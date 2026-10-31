"use strict";

globalThis.CopyNotesTabs = (() => {
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function attach(root, { onChange }) {
    const tabs = Array.from(root.querySelectorAll('[role="tab"]'));
    const view = root.ownerDocument.defaultView;
    const motion = view.matchMedia('(prefers-reduced-motion: reduce)');
    let positions = [];
    let selected = 0;
    let gesture = null;
    let suppressClick = false;
    let frame = 0;
    let previousTime = 0;
    let x = 0;
    let velocity = 0;
    let stretch = 0;
    let lift = 0;
    let targetX = 0;
    let targetLift = 0;

    function paint() {
      root.style.setProperty('--tab-x', `${x.toFixed(3)}px`);
      root.style.setProperty('--tab-y', `${lift.toFixed(3)}px`);
      root.style.setProperty('--tab-scale-x', (1 + stretch).toFixed(4));
      root.style.setProperty('--tab-scale-y', (1 - stretch * .65).toFixed(4));
    }

    function animate(time) {
      frame = 0;
      const dt = Math.min((time - previousTime) / 1000 || 1 / 60, .032);
      previousTime = time;
      const dragging = gesture?.dragging;
      // The same spring follows input and settles, so interruptions never jump.
      const stiffness = dragging ? 850 : 360;
      const damping = dragging ? 48 : 29;
      const steps = Math.ceil(dt * 120);
      const step = dt / steps;
      for (let index = 0; index < steps; index++) {
        velocity += ((targetX - x) * stiffness - velocity * damping) * step;
        x += velocity * step;
      }
      const follow = 1 - Math.exp(-22 * dt);
      const targetStretch = motion.matches ? 0 : Math.min(.075, Math.abs(velocity) / 11000 + (gesture ? .025 : 0));
      stretch += (targetStretch - stretch) * follow;
      lift += (targetLift - lift) * follow;
      if (Math.abs(targetX - x) < .02 && Math.abs(velocity) < .1
        && Math.abs(targetStretch - stretch) < .0002 && Math.abs(targetLift - lift) < .01) {
        x = targetX; velocity = 0; stretch = targetStretch; lift = targetLift;
        paint();
        return;
      }
      paint();
      frame = view.requestAnimationFrame(animate);
    }

    function moveTo(value, immediate = false) {
      targetX = value;
      if (motion.matches || immediate) {
        view.cancelAnimationFrame(frame);
        frame = 0; x = targetX; velocity = 0; stretch = 0; lift = 0;
        paint();
      } else if (!frame) {
        previousTime = view.performance.now();
        frame = view.requestAnimationFrame(animate);
      }
    }

    function sync() {
      selected = Math.max(0, tabs.findIndex(tab => tab.getAttribute('aria-selected') === 'true'));
      if (gesture && tabs[gesture.index].disabled) cancel();
      if (!gesture) moveTo(positions[selected] || 0);
    }

    function measure() {
      if (gesture) cancel();
      const rects = tabs.map(tab => tab.getBoundingClientRect());
      positions = rects.map(rect => rect.left - rects[0].left);
      root.style.setProperty('--tab-width', `${rects[0].width}px`);
      sync();
      moveTo(positions[selected], true);
    }

    function release() {
      const current = gesture;
      gesture = null;
      targetLift = 0;
      root.classList.remove('is-tab-pressed', 'is-tab-dragging');
      if (current && root.hasPointerCapture(current.id)) root.releasePointerCapture(current.id);
      return current;
    }

    function cancel() {
      if (!gesture) return;
      suppressClick = true;
      release();
      sync();
    }

    function choose(index, focus = false) {
      if (tabs[index]?.disabled) return;
      onChange(index);
      sync();
      if (focus) tabs[index].focus({ preventScroll: true });
    }

    function point(event) {
      const rect = root.getBoundingClientRect();
      root.style.setProperty('--tab-light', `${clamp(event.clientX - rect.left - x, 0, rect.width / 2)}px`);
    }

    root.addEventListener('pointerdown', event => {
      if (gesture || !event.isPrimary || event.button !== 0) return;
      const index = tabs.indexOf(event.target.closest('[role="tab"]'));
      if (index < 0 || tabs[index].disabled) return;
      suppressClick = false;
      gesture = { id: event.pointerId, index, startX: event.clientX, startY: event.clientY,
        lastX: event.clientX, time: event.timeStamp, speed: 0, offset: positions[index], dragging: false };
      root.setPointerCapture(event.pointerId);
      root.classList.add('is-tab-pressed');
      point(event);
      moveTo(positions[index]);
    });

    root.addEventListener('pointermove', event => {
      if (!gesture) { if (event.pointerType === 'mouse') point(event); return; }
      if (event.pointerId !== gesture.id) return;
      const dx = event.clientX - gesture.startX;
      const dy = event.clientY - gesture.startY;
      if (!gesture.dragging) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 5) return;
        if (Math.abs(dy) > Math.abs(dx) * 1.25) { cancel(); return; }
        gesture.dragging = true;
        root.classList.add('is-tab-dragging');
      }
      event.preventDefault();
      const elapsed = event.timeStamp - gesture.time;
      if (elapsed > 0) gesture.speed = (event.clientX - gesture.lastX) / elapsed;
      gesture.lastX = event.clientX;
      gesture.time = event.timeStamp;
      const enabled = positions.filter((_, index) => !tabs[index].disabled);
      const min = Math.min(...enabled), max = Math.max(...enabled);
      gesture.offset = positions[gesture.index] + dx;
      const bounded = clamp(gesture.offset, min, max);
      const rubber = Math.tanh((gesture.offset - bounded) / 60) * 9;
      targetLift = motion.matches ? 0 : clamp(dy * .08, -2, 2);
      moveTo(bounded + rubber);
      point(event);
    });

    root.addEventListener('pointerup', event => {
      if (!gesture || event.pointerId !== gesture.id) return;
      const current = release();
      suppressClick = true;
      if (!current.dragging) { choose(current.index); return; }
      // A short flick can cross the midpoint; a pause before release removes momentum.
      const speed = event.timeStamp - current.time < 100 ? current.speed : 0;
      const momentum = (positions.at(-1) - positions[0]) * .4;
      const projected = current.offset + clamp(speed * 110, -momentum, momentum);
      const enabled = tabs.map((tab, index) => index).filter(index => !tabs[index].disabled);
      const index = enabled.reduce((nearest, candidate) =>
        Math.abs(positions[candidate] - projected) < Math.abs(positions[nearest] - projected) ? candidate : nearest, selected);
      choose(index, event.pointerType !== 'touch');
    });
    for (const type of ['pointercancel', 'lostpointercapture']) {
      root.addEventListener(type, event => { if (gesture?.id === event.pointerId) cancel(); });
    }
    root.ownerDocument.addEventListener('pointerdown', event => {
      if (gesture && gesture.id !== event.pointerId) cancel();
    }, true);
    root.addEventListener('click', event => {
      if (suppressClick && event.detail !== 0) {
        suppressClick = false;
        event.preventDefault(); event.stopImmediatePropagation();
        return;
      }
      const index = tabs.indexOf(event.target.closest('[role="tab"]'));
      if (index >= 0) choose(index);
    }, true);
    root.addEventListener('keydown', event => {
      if (event.key === 'Escape' && gesture) { event.preventDefault(); cancel(); return; }
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      cancel();
      const enabled = tabs.map((tab, index) => index).filter(index => !tabs[index].disabled);
      const step = event.key === 'ArrowLeft' ? -1 : 1;
      const index = event.key === 'Home' ? enabled[0] : event.key === 'End' ? enabled.at(-1)
        : enabled[(enabled.indexOf(selected) + step + enabled.length) % enabled.length];
      choose(index, true);
    });
    view.addEventListener('blur', cancel);
    root.ownerDocument.addEventListener('visibilitychange', () => {
      if (root.ownerDocument.visibilityState === 'hidden') cancel();
    });
    motion.addEventListener('change', () => moveTo(targetX, true));
    if (view.ResizeObserver) new view.ResizeObserver(measure).observe(root);
    else view.addEventListener('resize', measure);
    measure();
    return { sync };
  }

  return { attach };
})();
