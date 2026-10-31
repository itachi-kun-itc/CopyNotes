"use strict";

(() => {
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
  const storageKey = "copynotes.notes.v1";
  const list = document.querySelector("#noteList");
  const template = document.querySelector("#noteTemplate");
  const status = document.querySelector("#status");
  const menu = document.querySelector("#noteMenu");
  const deleteButton = document.querySelector("#deleteNote");
  const addButton = document.querySelector("#addNote");
  let statusTimer;
  let storageWarningShown = false;
  let menuRow = null;
  let menuPoint = { x: 0, y: 0 };
  let press = null;
  let pressTimer;
  let touchContextUntil = 0;
  let touchClickRow = null;
  let touchClickUntil = 0;
  const sharing = CopyNotesSharing;
  const apiBase = (globalThis.CopyNotesConfig?.apiBase || '').replace(/\/$/, '');
  const crossOriginApi = Boolean(apiBase && new URL(apiBase).origin !== location.origin);
  // GitHub Pages uses a short-lived token only in memory; never in browser storage.
  let apiSession = '';
  const refreshButton = document.querySelector('#refreshNotes');
  const syncButton = document.querySelector('#syncNotes');
  const accountButton = document.querySelector('#accountButton');
  const deviceTab = document.querySelector('#deviceTab');
  const sharedTab = document.querySelector('#sharedTab');
  const syncStatus = document.querySelector('#syncStatus');
  const sharingLogin = document.querySelector('#sharingLogin');
  const loginDialog = document.querySelector('#loginDialog');
  const loginForm = document.querySelector('#loginForm');
  const loginFields = document.querySelector('#loginFields');
  const loginNumber = document.querySelector('#loginNumber');
  const loginError = document.querySelector('#loginError');
  const loginSubmit = document.querySelector('#loginSubmit');
  const logoutButton = document.querySelector('#logoutButton');
  const closeLogin = document.querySelector('#closeLogin');
  let deviceNotes = loadNotes();
  let sharedNotes = [];
  let activeTab = 'device';
  let roomId = null;
  let authenticated = false;
  let busy = true;
  let cloudMessage = '';
  const inFlightIds = new Set();

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

  function loadNotes() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
      if (Array.isArray(saved) && saved.every(note => typeof note === "string")) {
        const compacted = saved.filter(note => !sharing.isBlank(note));
        if (compacted.length !== saved.length) {
          try { localStorage.setItem(storageKey, JSON.stringify(compacted)); } catch { storageWarning(); }
        }
        return compacted;
      }
    } catch {
      storageWarning();
    }
    return [""];
  }

  function persistShared() {
    if (!roomId) return;
    try { localStorage.setItem('copynotes.shared.v1.' + roomId, JSON.stringify(sharedNotes)); }
    catch { storageWarning(); }
  }

  function readShared() {
    try {
      const value = JSON.parse(localStorage.getItem('copynotes.shared.v1.' + roomId) || '[]');
      if (Array.isArray(value) && value.every(note => note && typeof note.id === 'string' && typeof note.text === 'string' && Number.isSafeInteger(note.version) && typeof note.dirty === 'boolean')) {
        const compacted = sharing.compactBlank(value);
        try { localStorage.setItem('copynotes.shared.v1.' + roomId, JSON.stringify(compacted)); } catch { storageWarning(); }
        return compacted;
      }
    } catch { storageWarning(); }
    return [];
  }

  function saveNotes() {
    if (activeTab === 'device') {
      deviceNotes = Array.from(list.querySelectorAll('textarea'), input => input.value);
      try { localStorage.setItem(storageKey, JSON.stringify(deviceNotes)); }
      catch { storageWarning(); }
    } else if (authenticated) {
      const visible = new Map(Array.from(list.children, row => [row.dataset.noteId, row.querySelector('textarea').value]));
      sharedNotes = sharedNotes.filter(note => {
        if (visible.has(note.id)) sharing.update(note, visible.get(note.id), inFlightIds.has(note.id) || Boolean(note.pendingMutationId));
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
    deviceNotes = deviceNotes.filter(note => !sharing.isBlank(note));
    try { localStorage.setItem(storageKey, JSON.stringify(deviceNotes)); } catch { storageWarning(); }
    if (authenticated) {
      sharedNotes = sharing.compactBlank(sharedNotes, inFlightIds);
      persistShared();
    }
    const kept = new Set(sharedNotes.filter(note => !note.deleted).map(note => note.id));
    for (const row of Array.from(list.children)) {
      if (activeTab === 'device' ? sharing.isBlank(row.querySelector('textarea').value) : !kept.has(row.dataset.noteId)) row.remove();
    }
    if (menuRow && !menuRow.isConnected) closeMenu();
    cancelPress();
    labelNotes();
    updateWorkspace();
  }

  function updateWorkspace() {
    const shared = activeTab === 'shared';
    document.querySelector('.workspace-tabs').dataset.active = activeTab;
    deviceTab.setAttribute('aria-selected', String(!shared));
    sharedTab.setAttribute('aria-selected', String(shared));
    deviceTab.tabIndex = shared ? -1 : 0;
    sharedTab.tabIndex = shared ? 0 : -1;
    document.querySelector('#notesPanel').setAttribute('aria-labelledby', shared ? 'sharedTab' : 'deviceTab');
    accountButton.textContent = authenticated ? 'ログイン中' : 'ログイン';
    accountButton.disabled = busy;
    refreshButton.disabled = busy || !shared || !authenticated;
    refreshButton.title = !shared ? '共有タブで更新できます' : authenticated ? '共有内容を取得' : 'ログイン後に更新できます';
    syncButton.disabled = busy || !shared || !authenticated;
    syncButton.title = !shared ? '共有タブで同期できます' : authenticated ? '共有タブの変更を送信' : 'ログイン後に同期できます';
    syncButton.setAttribute('aria-busy', String(busy));
    addButton.disabled = shared && !authenticated;
    sharedTab.disabled = busy && !authenticated;
    loginSubmit.disabled = busy;
    logoutButton.disabled = busy;
    closeLogin.disabled = busy;
    logoutButton.hidden = !authenticated;
    loginFields.hidden = authenticated;
    loginNumber.disabled = authenticated;
    loginSubmit.hidden = authenticated;
    loginDialog.dataset.mode = authenticated ? 'logout' : 'login';
    loginDialog.setAttribute('aria-labelledby', authenticated ? 'logoutButton' : 'loginTitle');
    positionAccountMenu();
    sharingLogin.hidden = !shared || authenticated;
    syncStatus.hidden = !shared;
    const pending = sharedNotes.filter(note => note.dirty).length;
    syncStatus.textContent = cloudMessage || (busy ? '接続中…' : !authenticated ? '5桁の番号でログインして共有' : pending ? '未同期の変更 ' + pending + '件' : '同期済み · 同期した順に表示');
  }

  function renderNotes(restoreFocus = false) {
    const focused = restoreFocus && document.activeElement?.matches('textarea') && list.contains(document.activeElement) ? document.activeElement : null;
    const focusId = focused?.closest('.note-row')?.dataset.noteId;
    const selection = focused ? [focused.selectionStart, focused.selectionEnd] : null;
    cancelPress(); closeMenu();
    list.replaceChildren();
    if (activeTab === 'device') deviceNotes.forEach(value => addNote(value));
    else if (authenticated) sharedNotes.filter(note => !note.deleted).forEach(note => addNote(note.text, false, note));
    updateWorkspace();
    if (focusId) {
      const row = Array.from(list.children).find(row => row.dataset.noteId === focusId);
      const input = row?.querySelector('textarea');
      if (input) { input.focus({ preventScroll: true }); input.setSelectionRange(...selection); }
    }
  }

  function setTab(tab) {
    if (tab === activeTab) return;
    saveNotes();
    activeTab = tab;
    renderNotes();
  }

  function openLogin() {
    if (busy) return;
    loginError.textContent = '';
    loginNumber.value = '';
    if (!loginDialog.open) loginDialog.showModal();
    positionAccountMenu();
    (authenticated ? logoutButton : loginNumber).focus();
  }

  function positionAccountMenu() {
    if (!authenticated || !loginDialog.open) return;
    const rect = accountButton.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0;
    const top = viewport?.offsetTop || 0;
    const width = viewport?.width || window.innerWidth;
    const height = viewport?.height || window.innerHeight;
    loginDialog.style.setProperty('--account-menu-left', `${Math.max(left + 8, Math.min(rect.right - loginDialog.offsetWidth, left + width - loginDialog.offsetWidth - 8))}px`);
    loginDialog.style.setProperty('--account-menu-top', `${Math.max(top + 8, Math.min(rect.bottom + 8, top + height - loginDialog.offsetHeight - 8))}px`);
  }

  async function request(path, method = 'GET', body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const endpoint = crossOriginApi ? apiBase + '/api/' + path : new URL('api/' + path, document.baseURI).href;
      const response = await fetch(endpoint, {
        method, credentials: crossOriginApi ? 'omit' : 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(crossOriginApi && apiSession ? { Authorization: 'Bearer ' + apiSession } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('共有機能に接続できませんでした');
      const data = await response.json();
      if (crossOriginApi && (response.status === 401 || path === 'auth' && data.authenticated === false)) apiSession = '';
      if (!response.ok) {
        const error = new Error(data.error || '共有機能に接続できませんでした');
        error.status = response.status;
        throw error;
      }
      if (crossOriginApi && path === 'auth' && data.sessionToken) apiSession = data.sessionToken;
      return data;
    } catch (error) {
      if (error.name === 'AbortError' || error instanceof TypeError) throw new Error('通信できませんでした。変更はこの端末に保存されています');
      throw error;
    } finally { clearTimeout(timer); }
  }

  async function cloudAction(synchronize, compactRemoteBlanks = false) {
    if (busy) return;
    if (!authenticated) return;
    saveNotes();
    const expectedRoom = roomId;
    const sent = synchronize ? sharing.operations(sharedNotes) : [];
    sent.forEach(note => inFlightIds.add(note.id));
    if (sent.length) {
      const byId = new Map(sharedNotes.map(note => [note.id, note]));
      sent.forEach(operation => { byId.get(operation.id).pendingMutationId ||= operation.mutationId; });
      persistShared();
    }
    busy = true;
    cloudMessage = synchronize ? '同期中…' : '更新中…';
    updateWorkspace();
    try {
      const data = sent.length ? await request('notes', 'POST', { requestId: crypto.randomUUID(), operations: sent }) : await request('notes');
      if (roomId !== expectedRoom) return;
      const merged = sharing.merge(sharedNotes, data.notes, sent);
      sharedNotes = merged.notes;
      if (compactRemoteBlanks) {
        const blankIds = new Set(data.notes.filter(note => !note.deleted && sharing.isBlank(note.text)).map(note => note.id));
        sharedNotes = sharing.compactBlank(sharedNotes, inFlightIds, blankIds);
      }
      persistShared();
      cloudMessage = merged.copies ? '同時編集した内容を、未同期の別メモとして残しました'
        : merged.deletions ? '他端末で更新されたメモの削除は見送りました' : '';
      if (activeTab === 'shared') renderNotes(true);
      announce(cloudMessage || (synchronize ? '同期しました' : '共有内容を更新しました'));
    } catch (error) {
      cloudMessage = error.message;
      if (error.status === 401) {
        authenticated = false; roomId = null; sharedNotes = [];
        if (activeTab === 'shared') renderNotes();
      }
      announce(error.message);
    } finally {
      inFlightIds.clear(); busy = false; updateWorkspace();
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

  deviceTab.addEventListener('click', () => setTab('device'));
  sharedTab.addEventListener('click', () => setTab('shared'));
  document.querySelector('.workspace-tabs').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tab = event.key === 'Home' ? deviceTab : event.key === 'End' ? sharedTab : activeTab === 'device' ? sharedTab : deviceTab;
    if (tab.disabled) return;
    setTab(tab === deviceTab ? 'device' : 'shared');
    if (!loginDialog.open) tab.focus();
  });
  accountButton.addEventListener('click', openLogin);
  document.querySelector('#sharingLoginButton').addEventListener('click', openLogin);
  closeLogin.addEventListener('click', () => loginDialog.close());
  loginDialog.addEventListener('click', event => {
    if (!authenticated || busy || event.target !== loginDialog) return;
    const rect = loginDialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) loginDialog.close();
  });
  window.addEventListener('resize', positionAccountMenu);
  window.visualViewport?.addEventListener('resize', positionAccountMenu);
  window.visualViewport?.addEventListener('scroll', positionAccountMenu);
  loginDialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  loginNumber.addEventListener('input', () => { loginError.textContent = ''; });
  refreshButton.addEventListener('click', () => { if (activeTab === 'shared') cloudAction(false); });
  syncButton.addEventListener('click', () => { if (activeTab === 'shared') cloudAction(true); });
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
    } catch (error) { loginError.textContent = error.message; }
    finally { busy = false; updateWorkspace(); }
  });

  function resize(input) {
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }

  function cancelPress() {
    clearTimeout(pressTimer);
    press = null;
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
      if (activeTab === 'device') row.dataset.noteId = 'device-' + (index + 1);
      row.querySelector("textarea").setAttribute("aria-label", `コピーするテキスト ${index + 1}`);
      row.querySelector(".copy-button").setAttribute("aria-label", `テキスト ${index + 1} をコピー`);
    });
  }

  deleteButton.addEventListener("click", () => {
    const row = menuRow;
    if (!row?.isConnected) return;
    const next = row.nextElementSibling || row.previousElementSibling;
    cancelPress();
    closeMenu();
    row.remove();
    labelNotes();
    saveNotes();
    (next?.querySelector("textarea") || addButton).focus({ preventScroll: true });
    announce("削除しました");
  });

  list.addEventListener("contextmenu", event => {
    const row = event.target.closest(".note-row");
    if (!row) return;
    event.preventDefault();
    // Native touch menus can fire before the requested three-second delay.
    if (event.pointerType === "touch" || Date.now() < touchContextUntil) return;
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

  list.addEventListener("touchstart", event => {
    cancelPress();
    touchContextUntil = Date.now() + 10000;
    const row = event.target.closest(".note-row");
    if (!row || event.touches.length !== 1) return;
    const touch = event.touches[0];
    press = { row, id: touch.identifier, x: touch.clientX, y: touch.clientY };
    pressTimer = setTimeout(() => {
      if (!press || !row.isConnected) return;
      const { x, y } = press;
      cancelPress();
      touchClickRow = row;
      touchClickUntil = Infinity;
      openMenu(row, x, y);
    }, 3000);
  }, { passive: true });

  document.addEventListener("touchstart", event => {
    if (event.touches.length > 1) cancelPress();
  }, { passive: true });
  document.addEventListener("touchmove", event => {
    if (!press) return;
    const touch = Array.from(event.touches).find(touch => touch.identifier === press.id);
    if (!touch || Math.hypot(touch.clientX - press.x, touch.clientY - press.y) > 10) cancelPress();
  }, { passive: true });
  for (const type of ["touchend", "touchcancel"]) {
    document.addEventListener(type, () => {
      cancelPress();
      touchContextUntil = Date.now() + 800;
      touchClickUntil = Date.now() + 800;
    }, { passive: true });
  }
  list.addEventListener("click", event => {
    if (Date.now() < touchClickUntil && touchClickRow?.contains(event.target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

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
    preview.replaceChildren();
    if (!language) return;
    const fragment = document.createDocumentFragment();
    for (const token of CopyNotesSyntax.tokenize(input.value, language)) {
      if (!token.type) fragment.append(document.createTextNode(token.text));
      else {
        const span = document.createElement("span");
        span.className = `syntax-${token.type}`;
        span.textContent = token.text;
        fragment.append(span);
      }
    }
    preview.append(fragment);
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

  function addNote(value = "", focus = false, model = null) {
    const row = template.content.firstElementChild.cloneNode(true);
    const input = row.querySelector("textarea");
    const button = row.querySelector(".copy-button");
    const number = list.children.length + 1;
    if (activeTab === 'shared') {
      if (!model) { model = sharing.draft(value); sharedNotes.push(model); }
      row.dataset.noteId = model.id;
    } else row.dataset.noteId = 'device-' + number;
    let copiedTimer;
    input.value = value;
    input.setAttribute("aria-haspopup", "menu");
    input.setAttribute("aria-controls", "noteMenu");
    input.setAttribute("aria-label", `コピーするテキスト ${number}`);
    button.setAttribute("aria-label", `テキスト ${number} をコピー`);
    button.disabled = value.length === 0;
    CopyNotesEditor.attach(input);
    input.addEventListener("input", () => {
      clearTimeout(copiedTimer);
      button.removeAttribute("data-copied");
      button.disabled = input.value.length === 0;
      highlight(input);
      resize(input);
      saveNotes();
    });
    button.addEventListener("click", async () => {
      const text = input.value;
      if (!text) return;
      try {
        if (navigator.clipboard?.writeText) {
          try { await navigator.clipboard.writeText(text); }
          catch { fallbackCopy(input, text); }
        } else {
          fallbackCopy(input, text);
        }
        if (input.value === text) {
          clearTimeout(copiedTimer);
          button.setAttribute("data-copied", "");
          copiedTimer = setTimeout(() => button.removeAttribute("data-copied"), 1800);
        }
        announce("コピーしました");
      } catch {
        input.focus();
        input.select();
        announce("コピーできませんでした。選択したテキストを手動でコピーしてください");
      }
    });
    list.append(row);
    highlight(input);
    resize(input);
    if (focus) input.focus();
  }

  renderNotes();
  bootstrap();
  addButton.addEventListener("click", () => {
    if (activeTab === 'shared' && !authenticated) return;
    addNote("", true);
    saveNotes();
  });
  window.addEventListener("resize", () => list.querySelectorAll("textarea").forEach(resize));
  window.addEventListener('pagehide', compactNotes);
  window.addEventListener('pageshow', event => { if (event.persisted) compactNotes(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') compactNotes(); });
})();
