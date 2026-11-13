"use strict";

globalThis.CopyNotesReorder = (() => {
  const orderPrefix = 'copynotes.order.v1.';
  function createOrderStore(storage, onError = () => {}) {
    const memory = new Map();
    const unsaved = new Set();
    const validIds = value => Array.isArray(value) && value.every(id => typeof id === 'string') && new Set(value).size === value.length;
    function read(workspace) {
      if (unsaved.has(workspace)) return memory.get(workspace);
      try {
        const value = JSON.parse(storage.getItem(orderPrefix + workspace) || 'null');
        if (validIds(value)) return { ids: value, revision: 0 };
        if (value && validIds(value.ids) && Number.isSafeInteger(value.revision) && value.revision >= 0
          && (value.mutationId === undefined || typeof value.mutationId === 'string')) return value;
      } catch { onError(); }
      return memory.get(workspace) || { ids: [], revision: 0 };
    }
    function write(workspace, value) {
      memory.set(workspace, value);
      try { storage.setItem(orderPrefix + workspace, JSON.stringify(value)); unsaved.delete(workspace); }
      catch { unsaved.add(workspace); onError(); }
    }
    return {
      save(workspace, ids) {
        write(workspace, { ids: [...new Set(ids)], revision: read(workspace).revision,
          ...(workspace.startsWith('shared.') ? { mutationId: crypto.randomUUID() } : {}) });
      },
      pending(workspace) {
        const value = read(workspace);
        return value.mutationId ? { ids: [...value.ids], mutationId: value.mutationId } : null;
      },
      merge(workspace, remote, sent) {
        if (!remote || !validIds(remote.ids) || !Number.isSafeInteger(remote.revision) || remote.revision < 0) return;
        const current = read(workspace);
        if (current.mutationId && current.mutationId !== sent?.mutationId || current.revision > remote.revision) return;
        write(workspace, { ids: [...remote.ids], revision: remote.revision });
      },
      apply(items, workspace, identify = item => item.id) {
        const ranks = new Map(read(workspace).ids.map((id, index) => [id, index]));
        return [...items].sort((a, b) => (ranks.get(identify(a)) ?? Infinity) - (ranks.get(identify(b)) ?? Infinity));
      },
    };
  }
  function attach(list, scroller, { onChange, onStart = () => {}, onIdle = () => {}, blocked = () => false,
    document = globalThis.document, view = globalThis.window,
    requestFrame = requestAnimationFrame, cancelFrame = cancelAnimationFrame } = {}) {
    let gesture = null;
    let frame = null;
    const rows = () => Array.from(list.children).filter(row => !row.classList.contains('is-removing'));

    function clearMarker() {
      for (const row of rows()) {
        row.classList.remove('reorder-before');
        row.classList.remove('reorder-after');
      }
    }
    function cancel() {
      const current = gesture;
      gesture = null;
      if (frame !== null) cancelFrame(frame);
      frame = null;
      if (!current) return;
      clearMarker();
      current.row.classList.remove('is-reordering');
      list.classList.remove('is-reordering-list');
      current.preview?.remove();
      if (current.handle.hasPointerCapture?.(current.id)) current.handle.releasePointerCapture(current.id);
      onIdle();
    }
    function placeMarker() {
      clearMarker();
      const others = rows().filter(row => row !== gesture.row);
      const before = others.find(row => {
        const rect = row.getBoundingClientRect();
        return gesture.y < rect.top + rect.height / 2;
      }) || null;
      gesture.before = before;
      if (before) before.classList.add('reorder-before');
      else others.at(-1)?.classList.add('reorder-after');
    }
    function tick(time) {
      frame = null;
      if (!gesture?.dragging) return;
      if (!gesture.row.isConnected || document.visibilityState === 'hidden') { cancel(); return; }
      const rect = scroller.getBoundingClientRect();
      const edge = Math.min(48, rect.height / 4);
      const speed = gesture.y < rect.top + edge ? -Math.min(1, (rect.top + edge - gesture.y) / edge)
        : gesture.y > rect.bottom - edge ? Math.min(1, (gesture.y - rect.bottom + edge) / edge) : 0;
      const elapsed = Math.min(32, Math.max(0, time - (gesture.time ?? time)));
      gesture.time = time;
      scroller.scrollTop += speed * elapsed * .65;
      gesture.preview.style.top = `${Math.max(rect.top, Math.min(gesture.y - 24, rect.bottom - 48))}px`;
      placeMarker();
      frame = requestFrame(tick);
    }
    function moveRow(row, before) {
      const previous = Array.from(list.children);
      if (before === row || row.nextElementSibling === before || !before && row === previous.at(-1)) return;
      const scrollTop = scroller.scrollTop;
      list.insertBefore(row, before);
      scroller.scrollTop = scrollTop;
      row.querySelector('.reorder-handle').focus({ preventScroll: true });
      onChange(row, rows().indexOf(row));
    }
    list.addEventListener('pointerdown', event => {
      if (gesture) { cancel(); return; }
      const handle = event.target.closest('.reorder-handle');
      const row = handle?.closest('.note-row');
      if (!row || !list.contains(row) || event.button !== 0 || event.isPrimary === false || blocked()
        || row.classList.contains('is-removing') || rows().length < 2) return;
      event.preventDefault();
      onStart();
      handle.focus({ preventScroll: true });
      gesture = { row, handle, id: event.pointerId, x: event.clientX, y: event.clientY, startY: event.clientY, dragging: false };
      try { handle.setPointerCapture(event.pointerId); } catch { /* Document listeners still complete the gesture. */ }
    });
    document.addEventListener('pointermove', event => {
      if (!gesture || event.pointerId !== gesture.id) return;
      gesture.y = event.clientY;
      if (!gesture.dragging && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.startY) < 6) return;
      if (event.cancelable) event.preventDefault();
      if (!gesture.dragging) {
        gesture.dragging = true;
        gesture.row.classList.add('is-reordering');
        list.classList.add('is-reordering-list');
        const rect = gesture.row.getBoundingClientRect();
        const preview = document.createElement('div');
        preview.className = 'note-drag-preview';
        preview.setAttribute('aria-hidden', 'true');
        preview.textContent = gesture.row.querySelector('textarea').value.trim().split('\n')[0] || (gesture.row.noteImages?.length ? '画像のメモ' : '空のメモ');
        preview.style.left = `${rect.left}px`;
        preview.style.width = `${rect.width}px`;
        preview.style.top = `${event.clientY - 24}px`;
        document.body.append(preview);
        gesture.preview = preview;
        frame = requestFrame(tick);
      }
      placeMarker();
    }, { passive: false });
    document.addEventListener('pointerup', event => {
      if (!gesture || event.pointerId !== gesture.id) return;
      const current = gesture;
      if (current.dragging) { current.y = event.clientY; placeMarker(); }
      cancel();
      if (current.dragging && current.row.isConnected) moveRow(current.row, current.before);
    });
    document.addEventListener('pointercancel', event => { if (event.pointerId === gesture?.id) cancel(); });
    document.addEventListener('pointerdown', event => { if (gesture && event.pointerId !== gesture.id) cancel(); }, true);
    list.addEventListener('lostpointercapture', event => { if (event.pointerId === gesture?.id) cancel(); });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && gesture) { event.preventDefault(); cancel(); }
    });
    list.addEventListener('keydown', event => {
      const handle = event.target.closest('.reorder-handle');
      if (!handle || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      if (blocked() || gesture) return;
      const row = handle.closest('.note-row');
      const items = rows();
      const index = items.indexOf(row);
      const target = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : index + (event.key === 'ArrowUp' ? -1 : 1);
      if (target < 0 || target >= items.length || target === index) return;
      onStart();
      moveRow(row, target < index ? items[target] : items[target].nextElementSibling);
    });
    view.addEventListener('blur', cancel);
    view.addEventListener('resize', cancel);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') cancel(); });
    return { cancel, get active() { return Boolean(gesture); } };
  }
  return Object.freeze({ attach, createOrderStore, orderPrefix });
})();
