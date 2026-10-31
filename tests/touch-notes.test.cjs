"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
require("../touch-notes.js");

function hub() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) { listeners.set(type, fn); },
    fire(type, properties = {}) {
      const event = { type, cancelable: true, prevented: false,
        preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...properties };
      listeners.get(type)?.(event);
      return event;
    },
  };
}
function setup(options = {}) {
  const list = hub(); const document = hub();
  const classes = new Set();
  const row = { style: {}, isConnected: true,
    classList: { add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)),
      toggle(name, active) { if (active) classes.add(name); else classes.delete(name); } },
    getBoundingClientRect: () => ({ width: 320 }),
    contains: target => target === row,
  };
  row.closest = () => row;
  list.contains = target => target === row;
  const deleted = [];
  const touch = CopyNotesTouch.attach(list, { document, now: () => 100, onDelete: (...args) => deleted.push(args), ...options });
  const point = (x, y = 10, identifier = 1) => ({ clientX: x, clientY: y, identifier });
  const start = () => list.fire("touchstart", { target: row, touches: [point(300)] });
  const move = (x, y = 10) => list.fire("touchmove", { touches: [point(x, y)] });
  const end = (type = "touchend") => document.fire(type, { changedTouches: [point(20)] });
  return { list, document, row, classes, deleted, touch, point, start, move, end };
}

test("only a completed left swipe deletes, and suppresses its synthetic link/copy click", () => {
  const h = setup(); h.start();
  const move = h.move(40);
  assert.equal(move.prevented, true); assert.equal(h.classes.has("is-swipe-ready"), true);
  h.end();
  assert.deepEqual(h.deleted, [[h.row, true]]); assert.equal(h.touch.active, false);
  const click = h.list.fire("click", { target: h.row });
  assert.equal(click.prevented, true); assert.equal(click.stopped, true);
});

test("short swipes spring back without deleting", () => {
  const h = setup(); h.start(); h.move(180); h.end();
  assert.equal(h.deleted.length, 0); assert.equal(h.row.style.transform, "");
  assert.equal(h.classes.has("is-swiping"), false);
});

test("vertical scrolling, diagonal motion and rightward swipes never delete or block scrolling", () => {
  for (const [x, y] of [[290, 100], [250, 80], [320, 10]]) {
    const h = setup(); h.start(); assert.equal(h.move(x, y).prevented, false);
    h.move(0); h.end(); assert.equal(h.deleted.length, 0);
  }
});

test("cancelled gestures and a second finger cancel even a nearly completed swipe", () => {
  const cancelled = setup(); cancelled.start(); cancelled.move(20); cancelled.end("touchcancel");
  assert.equal(cancelled.deleted.length, 0); assert.equal(cancelled.row.style.transform, "");
  const multi = setup(); multi.start(); multi.move(20);
  multi.document.fire("touchstart", { touches: [multi.point(20), multi.point(100, 20, 2)] });
  multi.end(); assert.equal(multi.deleted.length, 0); assert.equal(multi.touch.active, false);
});

test("selection, composition and another removal preserve normal input interaction", () => {
  for (const options of [{ selectionActive: () => true }, { blocked: () => true }]) {
    const h = setup(options); h.start(); assert.equal(h.touch.active, false);
    assert.equal(h.move(0).prevented, false); h.end(); assert.equal(h.deleted.length, 0);
  }
  const tap = setup(); tap.start(); tap.end();
  assert.equal(tap.list.fire("click", { target: tap.row }).prevented, false);
});

test("removal slides out, collapses its height and grid gap, and releases animation handles", async t => {
  const previous = globalThis.getComputedStyle;
  t.after(() => { globalThis.getComputedStyle = previous; });
  globalThis.getComputedStyle = () => ({ rowGap: "12px", transform: "translateX(-250px)", opacity: ".7",
    paddingTop: "12px", paddingBottom: "12px", borderTopWidth: "1px", borderBottomWidth: "1px" });
  const animations = [];
  const row = { isConnected: true, parentElement: { children: [1, 2] },
    getBoundingClientRect: () => ({ width: 320, height: 80 }),
    remove() { this.isConnected = false; },
    animate(frames, options) {
      const item = { frames, options, cancelled: false, finished: Promise.resolve(), cancel() { this.cancelled = true; } };
      animations.push(item); return item;
    },
  };
  await CopyNotesTouch.remove(row, true);
  assert.equal(row.isConnected, false); assert.equal(animations.length, 2);
  assert.equal(animations[0].frames[1].transform, "translateX(-352px)");
  assert.equal(animations[1].frames[1].height, "0px");
  assert.equal(animations[1].frames[1].marginBottom, "-12px");
  assert.ok(animations.every(animation => animation.cancelled));
});

test("reduced-motion preference removes immediately without animation", async t => {
  const previous = globalThis.matchMedia;
  t.after(() => { globalThis.matchMedia = previous; });
  globalThis.matchMedia = () => ({ matches: true });
  let removed = false;
  await CopyNotesTouch.remove({ remove() { removed = true; }, animate() { assert.fail("must not animate"); } });
  assert.equal(removed, true);
});
