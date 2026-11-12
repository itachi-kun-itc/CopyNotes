"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '../styles.css'), 'utf8');
const variables = block => Object.fromEntries([...block.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map(match => [match[1], match[2]]));
const base = variables(css.match(/^:root\s*\{([^}]+)\}/)[1]);
const dark = variables(css.match(/:root:is\([^}]+\{([^}]+)\}/)[1]);
function rgba(hex) {
  let value = hex.replace('#', '');
  if (value.length === 3) value = [...value].map(char => char + char).join('');
  assert.match(value, /^[\da-f]{6}(?:[\da-f]{2})?$/i);
  return [0, 2, 4].map(offset => parseInt(value.slice(offset, offset + 2), 16) / 255)
    .concat(value.length === 8 ? parseInt(value.slice(6), 16) / 255 : 1);
}
const over = (front, back) => front.slice(0, 3).map((value, index) => value * front[3] + back[index] * (1 - front[3])).concat(1);
const interpolate = (start, end, amount) => start.map((value, index) => value + (end[index] - value) * amount);
function luminance(color) {
  return color.slice(0, 3).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
}
function contrast(first, second) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + .05) / (values[1] + .05);
}
function gradientColors(value) {
  const stops = [...value.matchAll(/#[\da-f]{3,8}\b/gi)].map(match => rgba(match[0]));
  assert.ok(stops.length, `Unsupported background: ${value}`);
  return stops.flatMap((stop, index) => index ? [0, .25, .5, .75, 1].map(amount => interpolate(stops[index - 1], stop, amount)) : [stop]);
}

// Calculate contrast from the shipped palettes, including translucent gradient
// stops over page glows. This checks color pairs, not a browser-rendered audit.
// Formula/threshold: https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
for (const theme of ['light', 'dark', 'sepia', 'blue', 'mint', 'rose', 'lavender', 'navy']) {
  test(`${theme} keeps text readable across note, dialog and glass control backgrounds`, () => {
    const block = css.match(new RegExp(':root\\[data-theme="' + theme + '"\\]\\s*\\{([^}]+)\\}'))?.[1] || '';
    const palette = { ...base, ...(['dark', 'navy'].includes(theme) ? dark : {}), ...variables(block) };
    const page = rgba(palette.page), surface = rgba(palette.surface);
    // Include both glow layers at their full opacities as a conservative bound.
    const pages = [page, over(rgba(palette['glow-a']), page), over(rgba(palette['glow-b']), page), over(rgba(palette['glow-a']), over(rgba(palette['glow-b']), page))];
    const backgrounds = (name, under = pages) => gradientColors(palette[name]).flatMap(color => under.map(back => over(color, back)));
    const tabs = backgrounds('tabs-bg');
    const pairs = {
      text: [surface, ...pages],
      muted: [surface, ...pages],
      subtle: [surface, ...pages],
      'control-text': ['control-bg', 'control-hover', 'control-active'].flatMap(name => backgrounds(name)),
      'tab-text': tabs,
      'tab-selected': backgrounds('tab-bg', tabs),
      'login-text': ['login-bg', 'control-hover', 'control-active'].flatMap(name => backgrounds(name, [page])),
      danger: [surface, page, rgba(palette['danger-bg']), ...backgrounds('logout-bg', [page])],
      link: [surface],
      success: [surface, rgba(palette['success-bg'])],
    };
    for (const [role, colors] of Object.entries(pairs)) {
      const minimum = Math.min(...colors.map(color => contrast(rgba(palette[role]), color)));
      assert.ok(minimum >= 4.5, `${theme}/${role}: ${minimum.toFixed(2)}:1 is below 4.5:1`);
    }
  });
}
