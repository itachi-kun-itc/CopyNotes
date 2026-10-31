"use strict";

globalThis.CopyNotesAutoSync = (() => {
  function create({ run, enabled, ready, hasChanges, debounce = 800, interval = 5000,
    setTimer = setTimeout, clearTimer = clearTimeout }) {
    let timer = null;
    let running = false;
    let paused = false;
    let queued = false;
    let failures = 0;
    function pause() {
      paused = true;
      clearTimer(timer);
      timer = null;
    }
    function schedule(delay) {
      clearTimer(timer);
      timer = null;
      if (paused || !enabled()) return;
      if (running) { queued = true; return; }
      timer = setTimer(tick, delay);
    }
    async function tick() {
      timer = null;
      if (paused || !enabled()) return;
      if (!ready()) { schedule(debounce); return; }
      running = true;
      queued = false;
      try {
        const success = await run();
        failures = success === false ? failures + 1 : 0;
      } catch {
        failures++;
      } finally {
        running = false;
        const delay = failures ? Math.min(30000, interval * 2 ** Math.min(failures - 1, 3))
          : queued || hasChanges() ? debounce : interval;
        schedule(delay);
      }
    }
    return {
      changed() { schedule(debounce); },
      refresh() { paused = false; schedule(0); },
      pause,
    };
  }
  return { create };
})();
