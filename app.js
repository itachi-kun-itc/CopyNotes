"use strict";

(async () => {
  // Keep the app at a fixed scale, including while an input has focus.
  document.addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey
      && (["+", "=", "-", "_", "0"].includes(event.key)
        || ["Equal", "Minus", "Digit0", "NumpadAdd", "NumpadSubtract", "Numpad0"].includes(event.code))) {
      event.preventDefault();
    }
  }, { capture: true });
  document.addEventListener("wheel", event => {
    if (event.ctrlKey || event.metaKey) event.preventDefault();
  }, { capture: true, passive: false });
  for (const type of ["touchstart", "touchmove"]) {
    document.addEventListener(type, event => {
      if (event.touches.length > 1) event.preventDefault();
    }, { capture: true, passive: false });
  }
  // Safari also exposes trackpad and pinch zoom through gesture events.
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    document.addEventListener(type, event => event.preventDefault(), { capture: true, passive: false });
  }
  document.addEventListener("selectstart", event => {
    if (!event.target.closest?.("input, textarea")) event.preventDefault();
  });

  function removeLegacyData() {
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("expence-tracker-")) localStorage.removeItem(key);
      }
    } catch {
      // Storage may be unavailable in restricted browser sessions.
    }
  }

  removeLegacyData();
  const list = document.querySelector("#noteList");
  const template = document.querySelector("#noteTemplate");
  const status = document.querySelector("#status");
  const menu = document.querySelector("#noteMenu");
  const deleteButton = document.querySelector("#deleteNote");
  const addButton = document.querySelector("#addNote");
  const notesScroller = document.querySelector('.notes-scroll');
  let resizeFrame = null;

  // The toolbar and tabs must never forward wheel/touch scrolling to the page.
  for (const type of ['wheel', 'touchmove']) {
    document.querySelector('.notes').addEventListener(type, event => {
      if (!event.target.closest?.('.notes-scroll')) event.preventDefault();
    }, { passive: false });
  }
  let statusTimer;
  let storageWarningShown = false;
  const attachmentStorage = globalThis.indexedDB ? await CopyNotesAttachmentStorage.open({
    storage: localStorage, indexedDB: globalThis.indexedDB, onError: storageWarning,
  }) : null;
  const noteStorage = attachmentStorage || localStorage;
  const imageTransfer = CopyNotesImageTransfer.create(request);
  let menuRow = null;
  let menuPoint = { x: 0, y: 0 };
  const sharing = CopyNotesSharing;
  const apiBase = (globalThis.CopyNotesConfig?.apiBase || '').replace(/\/$/, '');
  const crossOriginApi = Boolean(apiBase && new URL(apiBase).origin !== location.origin);
  // Static local previews retain the short-lived token across tab reloads.
  // The storage key also binds it to this API; login numbers are never saved.
  const persistApiSession = crossOriginApi && Boolean(globalThis.CopyNotesConfig?.persistSession);
  const apiSessionKey = 'copynotes.preview-session.v1.' + apiBase;
  let apiSession = '';
  if (persistApiSession) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(apiSessionKey));
      if (/^[a-f0-9]{64}$/.test(saved?.token) && Number.isFinite(saved.expiresAt) && saved.expiresAt > Date.now()) apiSession = saved.token;
      else sessionStorage.removeItem(apiSessionKey);
    } catch { /* Use the current tab's in-memory session if storage is blocked. */ }
  }
  const refreshButton = document.querySelector('#refreshNotes');
  const syncButton = document.querySelector('#syncNotes');
  const settingsButton = document.querySelector('#settingsButton');
  const settingsDialog = document.querySelector('#settingsDialog');
  const closeSettings = document.querySelector('#closeSettings');
  const colorTheme = document.querySelector('#colorTheme');
  const accountButton = document.querySelector('#accountButton');
  const deviceTab = document.querySelector('#deviceTab');
  const sharedTab = document.querySelector('#sharedTab');
  let tabMotion;
  const syncStatus = document.querySelector('#syncStatus');
  const sharingLogin = document.querySelector('#sharingLogin');
  const loginDialog = document.querySelector('#loginDialog');
  const loginForm = document.querySelector('#loginForm');
  const loginFields = document.querySelector('#loginFields');
  const loginTitle = document.querySelector('#loginTitle');
  const loginHelp = document.querySelector('#loginHelp');
  const loginNumber = document.querySelector('#loginNumber');
  const loginError = document.querySelector('#loginError');
  const loginSubmit = document.querySelector('#loginSubmit');
  const logoutButton = document.querySelector('#logoutButton');
  const closeLogin = document.querySelector('#closeLogin');
  const modalDialogs = [loginDialog, settingsDialog];
  const modalBackdrop = document.querySelector('#modalBackdrop');
  const returnFocus = new Map();
  const currentModal = () => modalDialogs.find(dialog => dialog.open);
  function releaseModalLayout() {
    if (currentModal()) return;
    document.documentElement.style.removeProperty('--overlay-notes-top');
    document.documentElement.style.removeProperty('--overlay-inset-top');
    delete document.documentElement.dataset.overlayOpen;
    modalBackdrop.hidden = true;
    document.querySelector('.notes').inert = false;
    menu.inert = false;
  }
  function openModal(dialog) {
    if (dialog.open) return;
    const previousFocus = document.activeElement;
    if (!currentModal()) {
      // Hold header spacing while the on-screen picker or keyboard is active.
      const rootStyle = document.documentElement.style;
      rootStyle.setProperty('--overlay-notes-top', getComputedStyle(document.querySelector('.notes')).paddingTop);
      rootStyle.setProperty('--overlay-inset-top', getComputedStyle(document.querySelector('.system-bar-background')).height);
    }
    for (const other of modalDialogs) if (other !== dialog && other.open) other.close();
    closeMenu();
    returnFocus.set(dialog, previousFocus && !modalDialogs.some(item => item.contains(previousFocus))
      ? previousFocus : dialog === settingsDialog ? settingsButton : accountButton);
    document.documentElement.dataset.overlayOpen = 'true';
    modalBackdrop.hidden = false;
    document.querySelector('.notes').inert = true;
    menu.inert = true;
    try {
      // Avoid the native modal/top-layer compositor: iOS Home Screen apps can
      // freeze their status-bar tint until a showModal() dialog is dismissed.
      dialog.show();
      // The dialog's autofocus target is its noninteractive container, so the
      // browser never selects a button/input or opens the software keyboard.
      // Clear that transient focus; Tab navigation still starts inside it.
      if (dialog.contains(document.activeElement)) document.activeElement.blur();
    } catch (error) { returnFocus.delete(dialog); releaseModalLayout(); throw error; }
  }
  for (const dialog of modalDialogs) {
    dialog.addEventListener('close', () => {
      const previousFocus = returnFocus.get(dialog); returnFocus.delete(dialog);
      requestAnimationFrame(() => {
        if (currentModal()) return;
        releaseModalLayout();
        if (previousFocus?.isConnected && !previousFocus.disabled) previousFocus.focus({ preventScroll: true });
      });
    });
  }
  modalBackdrop.addEventListener('click', event => {
    const dialog = currentModal();
    if (event.target !== modalBackdrop || !dialog || dialog === loginDialog && (!authenticated || busy)) return;
    dialog.close();
  });
  document.addEventListener('keydown', event => {
    const dialog = currentModal(); if (!dialog) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation();
      if (dialog !== loginDialog || !busy) dialog.close();
    } else if (event.key === 'Tab') {
      const controls = Array.from(dialog.querySelectorAll('button, input, select, textarea, a[href], [tabindex]'))
        .filter(element => !element.disabled && element.tabIndex !== -1 && element.getClientRects().length);
      const first = controls[0], last = controls.at(-1), focused = document.activeElement;
      if (!first) { event.preventDefault(); dialog.focus({ preventScroll: true }); }
      else if (event.shiftKey && (focused === first || !controls.includes(focused))) { event.preventDefault(); last.focus({ preventScroll: true }); }
      else if (!event.shiftKey && (focused === last || !controls.includes(focused))) { event.preventDefault(); first.focus({ preventScroll: true }); }
    }
  }, { capture: true });
  const deviceStore = CopyNotesDeviceStorage.create(noteStorage, storageWarning);
  let deviceNotes = deviceStore.load();
  let sharedNotes = [];
  let activeTab = 'device';
  let roomId = null;
  let authenticated = false;
  let busy = true;
  let cloudMessage = '';
  const inFlightIds = new Set();
  const composingInputs = new Set();
  const idleWaiters = new Set();
  let removingCount = 0;
  let preparingImages = 0;
  let backgroundSync = false;
  const touch = CopyNotesTouch.attach(list, {
    onDelete: (row, swipe) => deleteNote(row, swipe), onIdle: releaseIdle,
    blocked: () => removingCount > 0,
    selectionActive: row => {
      const input = row.querySelector('textarea');
      return composingInputs.has(input) || document.activeElement === input && input.selectionStart !== input.selectionEnd;
    },
  });
  const autoSync = CopyNotesAutoSync.create({
    run: () => cloudAction(true, false, true),
    enabled: () => authenticated && document.visibilityState !== 'hidden' && navigator.onLine !== false
      && (activeTab === 'shared' || pendingOperations().length > 0),
    ready: () => !busy && !interactionActive(),
    hasChanges: () => pendingOperations().length > 0,
  });

  function pendingOperations() {
    return sharing.operations(sharedNotes.filter(note => note.version || note.deleted || note.pendingMutationId || !CopyNotesImages.isBlank(note)));
  }
  function interactionActive() { return preparingImages > 0 || composingInputs.size > 0 || touch.active || removingCount > 0; }
  function releaseIdle() {
    // compositionend can precede the final input event; merge after both.
    setTimeout(() => {
      if (interactionActive()) return;
      for (const resolve of idleWaiters) resolve();
      idleWaiters.clear();
    }, 0);
  }
  function waitForIdle() {
    return interactionActive() ? new Promise(resolve => idleWaiters.add(resolve)) : Promise.resolve();
  }

  function announce(message) {
    clearTimeout(statusTimer);
    status.textContent = message;
    status.setAttribute("data-visible", "");
    statusTimer = setTimeout(() => {
      status.removeAttribute("data-visible");
      status.textContent = "";
    }, 2400);
  }

  function storageWarning() {
    if (storageWarningShown) return;
    storageWarningShown = true;
    announce("このブラウザでは入力内容を保存できません");
  }

  function persistDevice(notes) {
    const merged = deviceStore.save(notes);
    deviceNotes = merged.notes;
    if (activeTab === 'device' && (notes.length !== deviceNotes.length || notes.some((note, index) =>
      note.id !== deviceNotes[index].id || !CopyNotesImages.equalNote(note, deviceNotes[index])))) renderNotes(true, merged.preserved);
  }

  async function refreshDeviceNotes() {
    await attachmentStorage?.refresh();
    await waitForIdle();
    if (activeTab === 'device') saveNotes();
    else persistDevice(deviceNotes);
  }

  function persistShared() {
    if (!roomId) return;
    try {
      if (attachmentStorage) attachmentStorage.setNotes('copynotes.shared.v4.' + roomId, sharedNotes);
      else noteStorage.setItem('copynotes.shared.v4.' + roomId, JSON.stringify(sharedNotes));
    }
    catch { storageWarning(); }
  }

  function readShared() {
    try {
      const parse = key => attachmentStorage ? attachmentStorage.getNotes(key) : JSON.parse(noteStorage.getItem(key) || 'null');
      const value = parse('copynotes.shared.v4.' + roomId) ?? parse('copynotes.shared.v3.' + roomId) ?? parse('copynotes.shared.v2.' + roomId) ?? parse('copynotes.shared.v1.' + roomId) ?? [];
      if (Array.isArray(value) && value.every(note => note && typeof note.id === 'string' && typeof note.text === 'string' && CopyNotesImages.valid(note.images, 3) && Number.isSafeInteger(note.version) && typeof note.dirty === 'boolean')) {
        const compacted = sharing.compactBlank(sharing.normalizeLegacy(value));
        try {
          if (attachmentStorage) attachmentStorage.setNotes('copynotes.shared.v4.' + roomId, compacted);
          else noteStorage.setItem('copynotes.shared.v4.' + roomId, JSON.stringify(compacted));
        } catch { storageWarning(); }
        return compacted;
      }
    } catch { storageWarning(); }
    return [];
  }

  function saveNotes() {
    if (activeTab === 'device') {
      persistDevice(Array.from(list.querySelectorAll('.note-row:not(.is-removing)'), row => ({
        id: row.dataset.noteId, text: row.querySelector('textarea').value, images: [...row.noteImages],
      })));
    } else if (authenticated) {
      const visible = new Map(Array.from(list.children).filter(row => !row.classList.contains('is-removing')).map(row => [row.dataset.noteId, { text: row.querySelector('textarea').value, images: row.noteImages }]));
      sharedNotes = sharedNotes.filter(note => {
        if (visible.has(note.id)) sharing.update(note, visible.get(note.id).text, inFlightIds.has(note.id) || Boolean(note.pendingMutationId), visible.get(note.id).images);
        else if (!note.deleted) {
          if (note.version === 0 && !inFlightIds.has(note.id) && !note.pendingMutationId) return false;
          sharing.remove(note);
        }
        return true;
      });
      persistShared();
      cloudMessage = '';
    }
    updateWorkspace();
  }

  function compactNotes() {
    saveNotes();
    persistDevice(deviceNotes.filter(note => !CopyNotesImages.isBlank(note)));
    if (authenticated) {
      sharedNotes = sharing.compactBlank(sharedNotes, inFlightIds);
      persistShared();
    }
    const kept = new Set(sharedNotes.filter(note => !note.deleted).map(note => note.id));
    for (const row of Array.from(list.children)) {
      if (activeTab === 'device' ? sharing.isBlank(row.querySelector('textarea').value, row.noteImages) : !kept.has(row.dataset.noteId)) row.remove();
    }
    if (menuRow && !menuRow.isConnected) closeMenu();
    cancelPress();
    labelNotes();
    updateWorkspace();
  }

  function updateWorkspace() {
    const shared = activeTab === 'shared';
    updateImageButtons();
    document.querySelector('.workspace-tabs').dataset.active = activeTab;
    deviceTab.setAttribute('aria-selected', String(!shared));
    sharedTab.setAttribute('aria-selected', String(shared));
    deviceTab.tabIndex = shared ? -1 : 0;
    sharedTab.tabIndex = shared ? 0 : -1;
    document.querySelector('#notesPanel').setAttribute('aria-labelledby', shared ? 'sharedTab' : 'deviceTab');
    const accountLabel = authenticated ? 'ログイン中' : 'ログイン';
    if (accountButton.textContent !== accountLabel) accountButton.textContent = accountLabel;
    accountButton.disabled = busy;
    accountButton.setAttribute('aria-busy', String(busy));
    refreshButton.disabled = busy || !shared || !authenticated;
    refreshButton.setAttribute('aria-busy', String(busy && shared && authenticated));
    refreshButton.title = !shared ? '共有タブで更新できます' : authenticated ? '共有内容を取得して空白の入力欄を整理' : 'ログイン後に更新できます';
    syncButton.disabled = busy || !shared || !authenticated;
    syncButton.title = !shared ? '共有タブで同期できます' : authenticated ? '共有タブの変更を送信' : 'ログイン後に同期できます';
    syncButton.setAttribute('aria-busy', String(busy && shared && authenticated));
    addButton.disabled = shared && !authenticated;
    sharedTab.disabled = busy && !authenticated;
    tabMotion?.sync();
    loginSubmit.disabled = busy;
    logoutButton.disabled = busy;
    closeLogin.disabled = busy;
    logoutButton.hidden = !authenticated;
    loginFields.hidden = authenticated;
    loginNumber.disabled = authenticated;
    loginSubmit.hidden = authenticated;
    loginDialog.dataset.mode = authenticated ? 'logout' : 'login';
    loginTitle.textContent = authenticated ? 'ログアウト' : 'ログイン番号';
    loginHelp.textContent = authenticated
      ? 'ログアウトすると、共有メモの閲覧・編集には再度ログインが必要です。'
      : '発行済みの番号を入力してください。同じ番号の端末で共有できます。';
    sharingLogin.hidden = !shared || authenticated;
    syncStatus.hidden = !shared;
    const pending = pendingOperations().length;
    syncStatus.textContent = cloudMessage || (busy && !backgroundSync ? '接続中…' : !authenticated ? '5桁の番号でログインして共有' : pending ? '自動同期待ち ' + pending + '件' : '自動同期 · 同期した順に表示');
  }

  function renderNotes(restoreFocus = false, preserved = []) {
    const focused = restoreFocus && document.activeElement?.matches('textarea') && list.contains(document.activeElement) ? document.activeElement : null;
    for (const [previousId, nextId] of preserved) {
      const row = Array.from(list.children).find(item => item.dataset.noteId === previousId);
      if (row) row.dataset.noteId = nextId;
    }
    const focusId = focused?.closest('.note-row')?.dataset.noteId;
    const selection = focused ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null;
    const focusedTop = focused?.getBoundingClientRect().top;
    const scroller = document.querySelector('.notes-scroll');
    const scrollTop = scroller.scrollTop;
    cancelPress(); closeMenu();
    if (restoreFocus && (activeTab === 'device' || authenticated)) {
      const existing = new Map(Array.from(list.children, row => [row.dataset.noteId, row]));
      const visible = activeTab === 'device' ? deviceNotes : sharedNotes.filter(note => !note.deleted);
      visible.forEach((note, index) => {
        let row = existing.get(note.id);
        existing.delete(note.id);
        if (!row) row = addNote(note.text, note);
        if (!CopyNotesImages.equal(row.noteImages, note.images)) {
          row.noteImages = [...(note.images || [])];
          renderImages(row);
        }
        const input = row.querySelector('textarea');
        if (input.value !== note.text) {
          input.value = note.text;
          updateNoteState(row);
          row.querySelector('.copy-button').removeAttribute('data-copied');
          highlight(input); resize(input);
        }
        if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
      });
      existing.forEach(row => { if (!row.classList.contains('is-removing')) row.remove(); });
      labelNotes();
    } else {
      for (const row of list.children) row.getAnimations?.().forEach(animation => animation.cancel());
      list.replaceChildren();
      if (activeTab === 'device') deviceNotes.forEach(note => addNote(note.text, note));
      else if (authenticated) sharedNotes.filter(note => !note.deleted).forEach(note => addNote(note.text, note));
    }
    updateWorkspace();
    if (focusId) {
      const row = Array.from(list.children).find(row => row.dataset.noteId === focusId);
      const input = row?.querySelector('textarea');
      if (input) {
        if (document.activeElement !== input) input.focus({ preventScroll: true });
        input.setSelectionRange(...selection);
      }
    }
    if (restoreFocus) {
      scroller.scrollTop = scrollTop;
      if (focused?.isConnected) scroller.scrollTop += focused.getBoundingClientRect().top - focusedTop;
    }
    scheduleResizeNotes();
  }

  function setTab(tab) {
    if (tab === activeTab) return;
    saveNotes();
    activeTab = tab;
    renderNotes();
    autoSync.refresh();
  }

  function openLogin() {
    if (busy) return;
    loginError.textContent = '';
    loginNumber.value = '';
    openModal(loginDialog);
  }

  function resetAuthentication() {
    authenticated = false; roomId = null; sharedNotes = [];
    if (activeTab === 'shared') renderNotes();
  }

  async function request(path, method = 'GET', body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const endpoint = crossOriginApi ? apiBase + '/api/' + path : new URL('api/' + path, document.baseURI).href;
      const response = await fetch(endpoint, {
        method, credentials: crossOriginApi ? 'omit' : 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json',
          ...(roomId && (path === 'notes' || path.startsWith('images') || path === 'auth' && method === 'DELETE') ? { 'X-CopyNotes-Room': roomId } : {}),
          ...(crossOriginApi && apiSession ? { Authorization: 'Bearer ' + apiSession } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('共有機能に接続できませんでした');
      const data = await response.json();
      if (crossOriginApi && (response.status === 401 || path === 'auth' && data.authenticated === false)) {
        apiSession = '';
        if (persistApiSession) try { sessionStorage.removeItem(apiSessionKey); } catch { /* Storage can be blocked. */ }
      }
      if (!response.ok) {
        const error = new Error(data.error || '共有機能に接続できませんでした');
        error.status = response.status;
        throw error;
      }
      if (crossOriginApi && path === 'auth' && data.sessionToken) {
        apiSession = data.sessionToken;
        if (persistApiSession && Number.isFinite(data.expiresIn) && data.expiresIn > 0) try {
          sessionStorage.setItem(apiSessionKey, JSON.stringify({ token: apiSession, expiresAt: Date.now() + data.expiresIn * 1000 }));
        } catch { /* Keep the valid in-memory session if persistence fails. */ }
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError' || error instanceof TypeError) throw new Error('通信できませんでした。変更はこの端末に保存されています');
      throw error;
    } finally { clearTimeout(timer); }
  }

  async function cloudAction(synchronize, compactRemoteBlanks = false, automatic = false) {
    if (busy) return;
    if (!authenticated) return;
    saveNotes();
    const expectedRoom = roomId;
    const sent = synchronize ? sharing.batch(pendingOperations()) : [];
    sent.forEach(note => inFlightIds.add(note.id));
    if (sent.length) {
      const byId = new Map(sharedNotes.map(note => [note.id, note]));
      sent.forEach(operation => { byId.get(operation.id).pendingMutationId ||= operation.mutationId; });
      persistShared();
    }
    busy = true;
    backgroundSync = automatic;
    if (!automatic) cloudMessage = synchronize ? '同期中…' : '更新中…';
    updateWorkspace();
    try {
      if (roomId !== expectedRoom || !authenticated) return false;
      const operations = await imageTransfer.encode(sent, expectedRoom);
      const data = operations.length ? await request('notes', 'POST', { requestId: crypto.randomUUID(), operations }) : await request('notes');
      data.notes = await imageTransfer.decode(data.notes, expectedRoom);
      await attachmentStorage?.retain(data.notes);
      await waitForIdle();
      if (roomId !== expectedRoom || !authenticated) return false;
      const merged = sharing.merge(sharedNotes, data.notes, sent);
      sharedNotes = merged.notes;
      if (compactRemoteBlanks) {
        const blankIds = new Set(data.notes.filter(note => !note.deleted && CopyNotesImages.isBlank(note)).map(note => note.id));
        sharedNotes = sharing.compactBlank(sharedNotes, inFlightIds, blankIds);
      }
      persistShared();
      cloudMessage = merged.copies ? '同時編集した内容を、未同期の別メモとして残しました'
        : merged.deletions ? '他端末で更新されたメモの削除は見送りました' : '';
      if (activeTab === 'shared') renderNotes(true, merged.preserved);
      if (!automatic || cloudMessage) announce(cloudMessage || (synchronize ? '同期しました' : '共有内容を更新しました'));
      return true;
    } catch (error) {
      cloudMessage = error.message;
      if (error.status === 401) resetAuthentication();
      announce(error.message);
      return false;
    } finally {
      inFlightIds.clear(); busy = false; backgroundSync = false; updateWorkspace();
      if (!automatic) autoSync.changed();
    }
  }

  async function bootstrap() {
    try {
      const auth = await request('auth');
      authenticated = auth.authenticated;
      roomId = auth.roomId || null;
      if (authenticated) sharedNotes = readShared();
    } catch (error) { cloudMessage = error.message; }
    finally { busy = false; updateWorkspace(); }
    if (authenticated) await cloudAction(false, true);
  }

  tabMotion = CopyNotesTabs.attach(document.querySelector('.workspace-tabs'), {
    onChange: index => setTab(index === 0 ? 'device' : 'shared'),
  });
  accountButton.addEventListener('click', openLogin);
  document.querySelector('#sharingLoginButton').addEventListener('click', openLogin);
  closeLogin.addEventListener('click', () => loginDialog.close());
  loginDialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  loginNumber.addEventListener('input', () => { loginError.textContent = ''; });
  refreshButton.addEventListener('click', async () => {
    if (activeTab !== 'shared' || refreshButton.disabled) return;
    const expectedTab = activeTab;
    await waitForIdle();
    if (activeTab !== expectedTab || refreshButton.disabled) return;
    compactNotes();
    scheduleResizeNotes();
    autoSync.changed();
    await cloudAction(false, true);
  });
  syncButton.addEventListener('click', () => { if (activeTab === 'shared') cloudAction(true); });
  colorTheme.value = CopyNotesTheme.get();
  CopyNotesTheme.subscribe(value => { colorTheme.value = value; });
  function applySelectedTheme() {
    if (colorTheme.value === CopyNotesTheme.get()) return;
    if (!CopyNotesTheme.set(colorTheme.value)) announce('このブラウザでは設定を保存できません');
  }
  colorTheme.addEventListener('input', applySelectedTheme);
  colorTheme.addEventListener('change', applySelectedTheme);
  settingsButton.addEventListener('click', () => {
    openModal(settingsDialog);
  });
  closeSettings.addEventListener('click', () => settingsDialog.close());
  loginForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || authenticated) return;
    const code = loginNumber.value;
    if (!/^[0-9]{5}$/.test(code)) { loginError.textContent = '半角数字5桁で入力してください'; return; }
    busy = true; updateWorkspace();
    let success = false;
    try {
      const auth = await request('auth', 'POST', { code });
      saveNotes();
      authenticated = true; roomId = auth.roomId; sharedNotes = readShared();
      activeTab = 'shared'; cloudMessage = ''; loginNumber.value = '';
      loginDialog.close(); renderNotes(); success = true;
    } catch (error) { loginError.textContent = error.message; }
    finally { busy = false; updateWorkspace(); }
    if (success) await cloudAction(false, true);
  });
  logoutButton.addEventListener('click', async () => {
    if (busy) return;
    saveNotes(); busy = true; updateWorkspace();
    try {
      await request('auth', 'DELETE');
      authenticated = false; roomId = null; sharedNotes = []; cloudMessage = '';
      activeTab = 'device'; loginDialog.close(); renderNotes(); announce('ログアウトしました');
    } catch (error) {
      if (error.status === 401) resetAuthentication();
      loginError.textContent = error.message;
    }
    finally { busy = false; updateWorkspace(); }
  });

  function resize(input) {
    if (!input.isConnected || !input.getClientRects().length || input.closest('.is-removing')) return;
    const previousHeight = input.style.height;
    input.style.height = "auto";
    const height = input.scrollHeight;
    input.style.height = height > 0 ? `${Math.ceil(height) + 1}px` : previousHeight;
    input.scrollTop = 0;
  }

  function scheduleResizeNotes() {
    if (resizeFrame !== null) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = null;
      const scrollTop = notesScroller.scrollTop;
      list.querySelectorAll('textarea').forEach(resize);
      notesScroller.scrollTop = scrollTop;
    });
  }

  function cancelPress() {
    touch.cancel();
  }

  function closeMenu(restoreFocus = false) {
    const row = menuRow;
    menuRow = null;
    menu.hidden = true;
    row?.removeAttribute("data-menu-open");
    if (restoreFocus && row?.isConnected) row.querySelector("textarea").focus({ preventScroll: true });
  }

  function openMenu(row, x, y) {
    closeMenu();
    menuRow = row;
    row.setAttribute("data-menu-open", "");
    menu.hidden = false;
    menuPoint = { x, y };
    positionMenu();
    deleteButton.focus({ preventScroll: true });
  }

  function positionMenu() {
    if (menu.hidden) return;
    const { x, y } = menuPoint;
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0;
    const top = viewport?.offsetTop || 0;
    const width = viewport?.width || window.innerWidth;
    const height = viewport?.height || window.innerHeight;
    menu.style.left = `${Math.max(left + 8, Math.min(x, left + width - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(top + 8, Math.min(y, top + height - menu.offsetHeight - 8))}px`;
  }

  function labelNotes() {
    Array.from(list.children).forEach((row, index) => {
      row.querySelector("textarea").setAttribute("aria-label", `コピーするテキスト ${index + 1}`);
      row.querySelector(".copy-button").setAttribute("aria-label", `メモ ${index + 1} をコピー`);
    });
  }

  async function deleteNote(row, swipe = false, restoreFocus = false) {
    if (!row?.isConnected || removingCount > 0 || row.classList.contains('is-removing')) return;
    const expectedTab = activeTab;
    const next = row.nextElementSibling || row.previousElementSibling;
    row.classList.add('is-removing');
    removingCount++;
    closeMenu();
    saveNotes();
    autoSync.changed();
    try { await CopyNotesTouch.remove(row, swipe); }
    finally {
      removingCount--;
      releaseIdle();
      if (activeTab === expectedTab) {
        labelNotes();
        if (restoreFocus) (next?.isConnected ? next.querySelector('textarea') : addButton).focus({ preventScroll: true });
      }
      announce('削除しました');
    }
  }
  deleteButton.addEventListener('click', () => deleteNote(menuRow, false, true));

  list.addEventListener("contextmenu", event => {
    const row = event.target.closest(".note-row");
    if (!row) return;
    event.preventDefault();
    if (event.pointerType === "touch" || touch.recentTouch) return;
    const rect = row.getBoundingClientRect();
    openMenu(row, event.clientX || rect.left + 16, event.clientY || rect.bottom + 4);
  });

  list.addEventListener("keydown", event => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    const row = event.target.closest(".note-row");
    if (!row) return;
    event.preventDefault();
    const rect = row.getBoundingClientRect();
    openMenu(row, rect.left + 16, rect.bottom + 4);
  });

  document.addEventListener("pointerdown", event => {
    if (!menu.hidden && !menu.contains(event.target)) closeMenu();
  }, true);
  document.addEventListener("keydown", event => {
    if (menu.hidden) return;
    if (event.key === "Escape") { event.preventDefault(); closeMenu(true); }
    else if (event.key === "Tab") closeMenu(true);
    else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      deleteButton.focus();
    }
  });
  function dismissMenu() { cancelPress(); closeMenu(); }
  window.addEventListener("scroll", dismissMenu, { capture: true, passive: true });
  function resizeMenu() { cancelPress(); positionMenu(); }
  window.addEventListener("resize", resizeMenu);
  window.addEventListener("blur", dismissMenu);
  window.visualViewport?.addEventListener("resize", resizeMenu);
  window.visualViewport?.addEventListener("scroll", resizeMenu);

  function highlight(input) {
    const row = input.closest(".note-row");
    const preview = row.querySelector(".note-highlight");
    const language = CopyNotesSyntax.detect(input.value);
    input.autocapitalize = language ? "off" : "sentences";
    input.setAttribute("autocorrect", language ? "off" : "on");
    row.classList.toggle("is-code", Boolean(language));
    if (language) row.dataset.language = language;
    else delete row.dataset.language;
    const links = CopyNotesLinks.find(input.value);
    row.classList.toggle("has-links", links.length > 0);
    preview.replaceChildren(CopyNotesLinks.render(document, input.value, CopyNotesSyntax.tokenize(input.value, language), links));
    updateLinkState(input);
  }

  function updateLinkState(input) {
    const row = input.closest(".note-row");
    const preview = row.querySelector(".note-highlight");
    const editing = document.activeElement === input;
    row.classList.toggle("is-editing", editing);
    preview.setAttribute("aria-hidden", String(editing || !row.classList.contains("has-links")));
    for (const link of preview.querySelectorAll("a")) link.tabIndex = editing ? -1 : 0;
  }

  function fallbackCopy(input, text) {
    const focused = document.activeElement;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const direction = input.selectionDirection;
    const helper = document.createElement("textarea");
    helper.value = text;
    helper.setAttribute("readonly", "");
    helper.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0;font-size:16px";
    document.body.append(helper);
    let copied = false;
    try {
      helper.select();
      copied = document.execCommand("copy");
    } finally {
      helper.remove();
      focused?.focus({ preventScroll: true });
      input.setSelectionRange(start, end, direction);
    }
    if (!copied) throw new Error("Copy unavailable");
  }

  function rowContent(row) {
    return { text: row.querySelector('textarea').value, images: row.noteImages };
  }

  function updateNoteState(row) {
    const input = row.querySelector('textarea');
    const note = rowContent(row);
    const pending = Boolean(row.pendingAttachments);
    const media = Boolean(note.images.length);
    const moveFocus = media && document.activeElement === input;
    const button = row.querySelector('.copy-button');
    const unsupported = media && !CopyNotesImages.canCopy();
    button.disabled = !note.text.length && !media || unsupported;
    button.removeAttribute('data-copied');
    button.title = unsupported ? 'この形式・ブラウザではコピーできません。下のDLボタンをご利用ください' : 'コピー';
    button.setAttribute('aria-label', 'メモをコピー');
    const download = row.querySelector('.download-button');
    download.hidden = !media;
    download.disabled = !media;
    download.setAttribute('aria-label', '画像をダウンロード');
    row.classList.toggle('has-attachment', media);
    // Keep subsequent pastes in this memo when its text editor disappears.
    if (moveFocus) (button.disabled ? download : button).focus({ preventScroll: true });
    row.setAttribute('aria-busy', String(pending));
    input.readOnly = media || pending;
    input.placeholder = pending ? '読み込み中…' : 'テキストを入力…';
    const attachImage = row.querySelector('.attach-image');
    attachImage.hidden = note.text.length > 0 || media;
    attachImage.disabled = pending || note.text.length > 0 || note.images.length >= CopyNotesImages.maxImages || imageNoteCount() >= CopyNotesImages.maxImageNotes;
    row.querySelector('.image-count').textContent = `${row.noteImages.length}/${CopyNotesImages.maxImages}`;
  }

  function renderImages(row) {
    updateNoteState(row);
    const gallery = row.querySelector('.note-images');
    gallery.replaceChildren();
    gallery.hidden = row.noteImages.length === 0;
    row.noteImages.forEach((src, index) => {
      const item = document.createElement('div'); item.className = 'note-image';
      const image = document.createElement('img');
      image.src = src; image.alt = `添付画像 ${index + 1}`; image.draggable = false;
      item.append(image); gallery.append(item);
    });
  }

  function imageNoteCount() {
    const ids = new Set();
    if (activeTab === 'device') {
      // Read the small metadata directly, including changes from another tab.
      try {
        const saved = JSON.parse(localStorage.getItem(CopyNotesDeviceStorage.key) || '[]');
        for (const note of saved) if (note.images?.length) ids.add(note.id);
      } catch { /* The normal persistence path reports storage failures. */ }
    }
    for (const note of activeTab === 'device' ? deviceNotes : sharedNotes) {
      if (!note.deleted && note.images?.length) ids.add(note.id);
    }
    for (const row of list.children) if (!row.classList.contains('is-removing') && row.noteImages?.length) ids.add(row.dataset.noteId);
    return ids.size;
  }

  function updateImageButtons() {
    const reached = imageNoteCount() >= CopyNotesImages.maxImageNotes;
    for (const row of list.children) {
      const button = row.querySelector('.attach-image');
      button.disabled = reached || Boolean(row.pendingAttachments) || row.noteImages.length > 0 || row.querySelector('textarea').value.length > 0;
      button.title = reached ? '画像は端末・共有それぞれ3枚までです' : '画像を追加（1枚20MiBまで）';
    }
  }

  function attachImages(row, files) {
    if (!files.length) return;
    if (files.some(file => !file.type.startsWith('image/'))) { announce('画像のみ添付できます'); return; }
    const blocked = () => rowContent(row).text.length > 0 || row.noteImages.length >= CopyNotesImages.maxImages || imageNoteCount() >= CopyNotesImages.maxImageNotes;
    const explain = () => announce(row.noteImages.length >= CopyNotesImages.maxImages ? '画像は1つのメモに1枚までです'
      : rowContent(row).text.length ? '文字と画像は別々のメモにしてください' : (activeTab === 'device' ? '端末' : '共有') + 'の画像は3枚（3メモ分）までです');
    if (blocked()) { explain(); return; }
    const tab = activeTab;
    preparingImages++;
    row.pendingAttachments = (row.pendingAttachments || 0) + 1; updateNoteState(row);
    row.attachmentQueue = (row.attachmentQueue || Promise.resolve()).then(async () => {
      let added = 0;
      for (const file of files) {
        if (!row.isConnected || activeTab !== tab || row.classList.contains('is-removing')) break;
        if (blocked()) { explain(); break; }
        try {
          const prepared = await CopyNotesImages.prepare(file);
          if (attachmentStorage) await attachmentStorage.put(prepared);
          else if (CopyNotesImages.byteLength(prepared) > CopyNotesImages.inlineBytes) throw new Error('大きな画像の保存にはIndexedDBが使えるブラウザが必要です');
          const commit = async () => {
            await attachmentStorage?.refresh();
            if (!row.isConnected || activeTab !== tab || row.classList.contains('is-removing')) return;
            if (blocked()) { explain(); return; }
            row.noteImages.push(prepared);
            renderImages(row); saveNotes(); autoSync.changed(); added++;
          };
          if (tab === 'device' && navigator.locks) await navigator.locks.request('copynotes-device-attachments', commit);
          else await commit();
        } catch (error) { announce(error.message || '添付内容を読み込めませんでした'); }
      }
      if (added && files.length === added) announce('画像を追加しました');
    }).finally(() => { row.pendingAttachments--; updateNoteState(row); preparingImages--; releaseIdle(); autoSync.changed(); });
  }

  function addNote(value = "", model = null) {
    const row = template.content.firstElementChild.cloneNode(true);
    const input = row.querySelector("textarea");
    const button = row.querySelector(".copy-button");
    const number = list.children.length + 1;
    if (activeTab === 'shared') {
      if (!model) { model = sharing.draft(value); sharedNotes.push(model); }
      row.dataset.noteId = model.id;
    } else {
      if (!model) { model = CopyNotesDeviceStorage.draft(value); deviceNotes.push(model); }
      row.dataset.noteId = model.id;
    }
    let copiedTimer;
    input.value = value;
    row.noteImages = [...(model.images || [])];
    renderImages(row);
    // Capture before textarea paste handlers so image pastes never replace text.
    row.addEventListener('paste', event => {
      const files = CopyNotesImages.filesFrom(event.clipboardData);
      if (!files.length && !input.readOnly) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (files.length) attachImages(row, files);
      else announce('文字と画像は別々のメモにしてください');
    }, true);
    row.addEventListener('beforeinput', event => { if (input.readOnly) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
    row.addEventListener('dragover', event => { if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault(); });
    row.addEventListener('drop', event => {
      const files = CopyNotesImages.filesFrom(event.dataTransfer);
      if (!files.length && !input.readOnly && !Array.from(event.dataTransfer?.types || []).includes('Files')) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (files.length) attachImages(row, files);
    }, true);
    const fileInput = row.querySelector('.image-input');
    row.querySelector('.attach-image').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const files = Array.from(fileInput.files); fileInput.value = '';
      if (files.length) attachImages(row, files);
    });
    input.addEventListener('input', () => { if (row.noteImages.length) input.value = ''; }, true);
    input.setAttribute("aria-haspopup", "menu");
    input.setAttribute("aria-controls", "noteMenu");
    input.setAttribute("aria-label", `コピーするテキスト ${number}`);
    button.setAttribute("aria-label", `メモ ${number} をコピー`);
    updateNoteState(row);
    CopyNotesLimits.attach(input);
    CopyNotesEditor.attach(input);
    input.addEventListener("focus", () => updateLinkState(input));
    input.addEventListener("blur", () => updateLinkState(input));
    input.addEventListener("input", () => {
      clearTimeout(copiedTimer);
      updateNoteState(row);
      highlight(input);
      resize(input);
      saveNotes();
      autoSync.changed();
    });
    row.querySelector('.download-button').addEventListener('click', async () => {
      const images = [...row.noteImages];
      if (!images.length) return;
      try {
        await CopyNotesImages.download(images);
        announce('ダウンロードを開始しました');
      } catch { announce('ダウンロードできませんでした'); }
    });
    button.addEventListener("click", async () => {
      const text = input.value;
      const images = [...row.noteImages];
      if (button.disabled || !text && !images.length) return;
      try {
        if (images.length) {
          await CopyNotesImages.copy(text, images);
        } else if (navigator.clipboard?.writeText) {
          try { await navigator.clipboard.writeText(text); }
          catch { fallbackCopy(input, text); }
        } else {
          fallbackCopy(input, text);
        }
        if (input.value === text && CopyNotesImages.equal(row.noteImages, images)) {
          clearTimeout(copiedTimer);
          button.setAttribute("data-copied", "");
          copiedTimer = setTimeout(() => button.removeAttribute("data-copied"), 1800);
        }
        announce("コピーしました");
      } catch (error) {
        if (images.length) {
          announce(error.message === 'このブラウザは画像のコピーに対応していません' ? error.message : '画像をコピーできませんでした');
        } else {
          input.focus();
          input.select();
          announce("コピーできませんでした。選択したテキストを手動でコピーしてください");
        }
      }
    });
    list.append(row);
    highlight(input);
    resize(input);
    scheduleResizeNotes();
    return row;
  }

  renderNotes();
  bootstrap();
  addButton.addEventListener("click", () => {
    if (activeTab === 'shared' && !authenticated) return;
    addNote("");
    saveNotes();
    autoSync.changed();
  });
  window.addEventListener('resize', scheduleResizeNotes);
  window.visualViewport?.addEventListener('resize', scheduleResizeNotes);
  window.addEventListener('load', scheduleResizeNotes);
  document.fonts?.ready.then(scheduleResizeNotes);
  if (globalThis.ResizeObserver) {
    let measuredWidth = -1;
    new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width;
      if (width > 0 && width !== measuredWidth) {
        measuredWidth = width;
        scheduleResizeNotes();
      }
    }).observe(list);
  }
  list.addEventListener('compositionstart', event => composingInputs.add(event.target));
  list.addEventListener('compositionend', event => {
    setTimeout(() => {
      composingInputs.delete(event.target);
      releaseIdle(); autoSync.changed();
    }, 0);
  });
  list.addEventListener('focusout', event => { composingInputs.delete(event.target); releaseIdle(); });
  window.addEventListener('pagehide', () => { compactNotes(); autoSync.pause(); });
  window.addEventListener('pageshow', event => { if (event.persisted) compactNotes(); scheduleResizeNotes(); autoSync.refresh(); });
  window.addEventListener('online', () => autoSync.refresh());
  window.addEventListener('offline', () => autoSync.pause());
  window.addEventListener('focus', () => { refreshDeviceNotes(); autoSync.refresh(); });
  window.addEventListener('storage', event => {
    if (event.key === CopyNotesDeviceStorage.key || event.key === null) refreshDeviceNotes();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      compactNotes(); composingInputs.clear(); releaseIdle(); autoSync.pause();
    } else { scheduleResizeNotes(); autoSync.refresh(); }
  });
})().catch(error => {
  const status = document.querySelector('#status');
  status.textContent = error.message || '保存された画像を読み込めませんでした。再読み込みしてください';
  status.setAttribute('data-visible', '');
  document.querySelector('#addNote').disabled = true;
});
