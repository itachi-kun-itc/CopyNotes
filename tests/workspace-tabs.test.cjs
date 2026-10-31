"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../workspace-tabs.js');

function events() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    fire(type, properties = {}) {
      const event = { type, detail: 1, prevented: false, stopped: false,
        preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...properties };
      for (const listener of listeners.get(type) || []) { listener(event); if (event.stopped) break; }
      return event;
    },
  };
}

function setup({ reduced = false, disabled = false } = {}) {
  let time = 0, nextFrame = 0, captured = null, focused = null;
  const frames = new Map(), styles = new Map(), classes = new Set(), changes = [];
  const motion = Object.assign(events(), { matches: reduced });
  const view = Object.assign(events(), {
    performance: { now: () => time }, matchMedia: () => motion,
    requestAnimationFrame(fn) { frames.set(++nextFrame, fn); return nextFrame; },
    cancelAnimationFrame(id) { frames.delete(id); },
  });
  const document = Object.assign(events(), { defaultView: view, visibilityState: 'visible' });
  const tabs = [0, 1].map(index => ({
    disabled: index === 1 && disabled, selected: index === 0,
    getAttribute: () => String(tabs[index].selected),
    getBoundingClientRect: () => ({ left: 6 + index * 160, width: 156 }),
    closest() { return this; }, focus() { focused = index; },
  }));
  const root = Object.assign(events(), {
    ownerDocument: document, querySelectorAll: () => tabs,
    getBoundingClientRect: () => ({ left: 0, width: 332 }),
    style: { setProperty: (name, value) => styles.set(name, value) },
    classList: { add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)) },
    setPointerCapture(id) { captured = id; }, hasPointerCapture: id => captured === id,
    releasePointerCapture() { captured = null; root.fire('lostpointercapture', { pointerId: 1 }); },
  });
  const controller = CopyNotesTabs.attach(root, {
    onChange(index) { tabs.forEach((tab, item) => { tab.selected = item === index; }); changes.push(index); },
  });
  function tick(count = 1) {
    for (let step = 0; step < count; step++) {
      time += 16;
      const pending = Array.from(frames.values()); frames.clear();
      pending.forEach(fn => fn(time));
    }
  }
  function pointer(type, x, properties = {}) {
    time += 16;
    return root.fire(type, { pointerId: 1, isPrimary: true, button: 0, clientX: x, clientY: 20,
      pointerType: 'mouse', target: tabs[0], timeStamp: time, ...properties });
  }
  return { root, document, view, tabs, styles, frames, classes, changes, controller, motion, tick, pointer,
    get selected() { return tabs.findIndex(tab => tab.selected); }, get focused() { return focused; },
    get captured() { return captured; } };
}

test('clicks and keyboard activation keep selection and focus in sync', () => {
  const h = setup();
  h.root.fire('click', { target: h.tabs[1], detail: 0 });
  assert.equal(h.selected, 1);
  for (const [key, expected] of [['ArrowLeft', 0], ['ArrowLeft', 1], ['Home', 0], ['End', 1]]) {
    assert.equal(h.root.fire('keydown', { key }).prevented, true);
    assert.equal(h.selected, expected); assert.equal(h.focused, expected);
  }
  h.tick(180);
  assert.equal(h.styles.get('--tab-x'), '160.000px');
  assert.equal(h.styles.get('--tab-scale-x'), '1.0000');
  assert.equal(h.frames.size, 0, 'the spring stops scheduling frames at rest');
});

test('mouse, touch and pen drags follow continuously and settle into either tab once', () => {
  for (const pointerType of ['mouse', 'touch', 'pen']) {
    const h = setup();
    h.pointer('pointerdown', 60, { pointerType });
    assert.equal(h.captured, 1);
    h.pointer('pointermove', 160, { pointerType }); h.tick(5);
    assert.ok(parseFloat(h.styles.get('--tab-x')) > 0);
    assert.ok(parseFloat(h.styles.get('--tab-x')) < 160);
    assert.equal(h.selected, 0, 'dragging previews without replacing notes');
    h.tick(10); h.pointer('pointerup', 160, { pointerType });
    assert.equal(h.selected, 1); assert.equal(h.captured, null);
    const click = h.root.fire('click', { target: h.tabs[0] });
    assert.equal(click.prevented, true); assert.deepEqual(h.changes, [1]);
    h.pointer('pointerdown', 240, { pointerType, target: h.tabs[1] });
    h.pointer('pointermove', 140, { pointerType });
    h.tick(10); h.pointer('pointerup', 140, { pointerType });
    assert.equal(h.selected, 0);
    h.tick(180);
    assert.equal(h.styles.get('--tab-x'), '0.000px');
    assert.equal(h.classes.size, 0);
  }
});

test('short drags return, but a quick flick switches; pausing removes momentum', () => {
  for (const pause of [false, true]) {
    const h = setup(); h.pointer('pointerdown', 60); h.pointer('pointermove', 90);
    if (pause) h.tick(10);
    h.pointer('pointerup', 90);
    assert.equal(h.selected, pause ? 0 : 1);
  }
});

test('tapping captures release outside the button and the next ordinary click still works', () => {
  const h = setup(); h.pointer('pointerdown', 240, { target: h.tabs[1] });
  h.pointer('pointerup', 240, { target: h.root });
  assert.equal(h.selected, 1);
  h.root.fire('click', { target: h.root });
  h.pointer('pointerdown', 60); h.pointer('pointerup', 60);
  assert.equal(h.selected, 0); assert.deepEqual(h.changes, [1, 0]);
});

test('cancellation, vertical movement, lost capture, blur and multitouch restore the selection', () => {
  for (const cancel of [
    h => h.pointer('pointercancel', 200),
    h => h.root.fire('lostpointercapture', { pointerId: 1 }),
    h => h.view.fire('blur'),
    h => h.document.fire('pointerdown', { pointerId: 2 }),
    h => h.root.fire('keydown', { key: 'Escape' }),
    h => { h.document.visibilityState = 'hidden'; h.document.fire('visibilitychange'); },
  ]) {
    const h = setup(); h.pointer('pointerdown', 60); h.pointer('pointermove', 200); cancel(h);
    h.pointer('pointerup', 200); h.tick(180);
    assert.equal(h.selected, 0); assert.equal(h.captured, null); assert.equal(h.classes.size, 0);
    assert.equal(h.styles.get('--tab-x'), '0.000px'); assert.equal(h.changes.length, 0);
  }
  const h = setup(); h.pointer('pointerdown', 60);
  h.pointer('pointermove', 64, { clientY: 60 }); h.pointer('pointerup', 64);
  assert.equal(h.changes.length, 0); assert.equal(h.classes.size, 0);
});

test('disabled destinations and secondary mouse buttons never activate a tab', () => {
  const h = setup({ disabled: true });
  h.root.fire('click', { target: h.tabs[1] });
  h.pointer('pointerdown', 240, { target: h.tabs[1] }); assert.equal(h.captured, null);
  h.pointer('pointerdown', 60, { button: 2 }); assert.equal(h.captured, null);
  h.pointer('pointerdown', 60); h.pointer('pointermove', 300); h.pointer('pointerup', 300);
  h.root.fire('keydown', { key: 'End' }); assert.equal(h.selected, 0);
});

test('external selection and resize update the indicator; reduced motion snaps without a spring', () => {
  const h = setup({ reduced: true });
  h.tabs[0].selected = false; h.tabs[1].selected = true; h.controller.sync();
  assert.equal(h.styles.get('--tab-x'), '160.000px'); assert.equal(h.frames.size, 0);
  h.tabs[1].getBoundingClientRect = () => ({ left: 106, width: 96 });
  h.view.fire('resize'); assert.equal(h.styles.get('--tab-x'), '100.000px');
  h.pointer('pointerdown', 240, { target: h.tabs[1] }); h.pointer('pointermove', 140); h.pointer('pointerup', 140);
  assert.equal(h.selected, 0); assert.equal(h.styles.get('--tab-x'), '0.000px');
  assert.equal(h.styles.get('--tab-scale-x'), '1.0000'); assert.equal(h.frames.size, 0);
});
