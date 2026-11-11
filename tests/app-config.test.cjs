"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../app-config.js'), 'utf8');

test('static previews on loopback port 5500 use the public login API, including nested paths', () => {
  for (const origin of ['http://localhost:5500', 'http://127.0.0.1:5500', 'http://[::1]:5500']) {
    const context = vm.createContext({ location: { origin, href: origin + '/CopyNotes/index.html' } });
    vm.runInContext(source, context);
    assert.equal(context.CopyNotesConfig.apiBase, 'https://copynotes-bjx.pages.dev');
    assert.equal(Object.isFrozen(context.CopyNotesConfig), true);
  }
});

test('native hosting, other ports and lookalike hosts keep the same-origin API', () => {
  for (const origin of ['https://copynotes-bjx.pages.dev', 'http://localhost:4173', 'http://127.0.0.1:5501', 'http://localhost.example.com:5500', 'http://192.168.1.1:5500']) {
    const context = vm.createContext({ location: { origin } });
    vm.runInContext(source, context);
    assert.equal(context.CopyNotesConfig.apiBase, '');
  }
});
