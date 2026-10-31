"use strict";

globalThis.CopyNotesTouch = (() => {
  function attach(list, { onDelete, onIdle = () => {}, blocked = () => false,
    selectionActive = () => false, document = globalThis.document, now = Date.now }) {
    let gesture = null;
    let touchUntil = 0;
    let clickUntil = 0;
    let clickRow = null;
    function restore(row) {
      row.classList.remove("is-swiping", "is-swipe-ready");
      row.style.transform = "";
      row.style.opacity = "";
    }
    function cancel() {
      if (!gesture) return;
      const current = gesture;
      gesture = null;
      if (current.horizontal) clickUntil = now() + 800;
      restore(current.row);
      onIdle();
    }
    list.addEventListener("touchstart", event => {
      cancel();
      touchUntil = now() + 10000;
      const row = event.target.closest(".note-row");
      if (event.touches.length !== 1 || !row || !list.contains(row) || blocked() || selectionActive(row)) return;
      const touch = event.touches[0];
      gesture = { row, id: touch.identifier, x: touch.clientX, y: touch.clientY,
        width: row.getBoundingClientRect().width, offset: 0, horizontal: false };
    }, { passive: true });
    document.addEventListener("touchstart", event => {
      if (event.touches.length !== 1) cancel();
    }, { passive: true });
    list.addEventListener("touchmove", event => {
      if (!gesture) return;
      if (event.touches.length !== 1) { cancel(); return; }
      const touch = Array.from(event.touches).find(item => item.identifier === gesture.id);
      if (!touch || !gesture.row.isConnected) { cancel(); return; }
      const dx = touch.clientX - gesture.x;
      const dy = touch.clientY - gesture.y;
      if (!gesture.horizontal) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 12) return;
        if (dx >= 0 || Math.abs(dx) < Math.abs(dy) * 1.3 || !event.cancelable) { cancel(); return; }
        gesture.horizontal = true;
        gesture.row.classList.add("is-swiping");
        clickRow = gesture.row;
        clickUntil = Infinity;
      }
      if (event.cancelable) event.preventDefault();
      gesture.offset = Math.max(-gesture.width, Math.min(0, dx));
      gesture.row.style.transform = `translateX(${gesture.offset}px)`;
      gesture.row.style.opacity = String(1 + gesture.offset / gesture.width * .35);
      gesture.row.classList.toggle("is-swipe-ready", -gesture.offset >= gesture.width * .75);
    }, { passive: false });
    function end(event) {
      touchUntil = now() + 800;
      clickUntil = now() + 800;
      if (!gesture) return;
      if (event.type === "touchcancel") { cancel(); return; }
      if (!Array.from(event.changedTouches).some(touch => touch.identifier === gesture.id)) return;
      const current = gesture;
      gesture = null;
      if (current.horizontal && -current.offset >= current.width * .75) onDelete(current.row, true);
      else restore(current.row);
      onIdle();
    }
    document.addEventListener("touchend", end, { passive: true });
    document.addEventListener("touchcancel", end, { passive: true });
    list.addEventListener("click", event => {
      if (now() < clickUntil && clickRow?.contains(event.target)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
    return { cancel, get active() { return Boolean(gesture); }, get recentTouch() { return now() < touchUntil; } };
  }

  async function remove(row, swipe = false) {
    const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced || !row.animate) { row.remove(); return; }
    const rect = row.getBoundingClientRect();
    const style = getComputedStyle(row);
    const gap = row.parentElement.children.length > 1 ? parseFloat(getComputedStyle(row.parentElement).rowGap) || 0 : 0;
    const animations = [];
    async function play(frames, duration) {
      if (!row.isConnected) return;
      const animation = row.animate(frames, { duration, easing: "cubic-bezier(.2,.8,.2,1)", fill: "forwards" });
      animations.push(animation);
      try { await animation.finished; } catch { /* Tab changes may cancel the animation. */ }
    }
    try {
      await play([{ transform: style.transform, opacity: style.opacity },
        { transform: swipe ? `translateX(${-rect.width - 32}px)` : style.transform, opacity: 0 }], 160);
      await play([{ height: `${rect.height}px`, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom,
        borderTopWidth: style.borderTopWidth, borderBottomWidth: style.borderBottomWidth, marginBottom: "0px" },
      { height: "0px", paddingTop: "0px", paddingBottom: "0px", borderTopWidth: "0px", borderBottomWidth: "0px", marginBottom: `${-gap}px` }], 240);
    } finally {
      row.remove();
      animations.forEach(animation => animation.cancel());
    }
  }
  return { attach, remove };
})();
