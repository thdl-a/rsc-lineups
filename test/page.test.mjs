// Every inline <script> in public/index.html must at least compile.
// A syntax error stops the whole page script (the page then hangs on "Loading...").
//   node --test test/
// The same file runs in both repos.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const HTML = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const scripts = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

test('index.html has inline scripts', () => {
  assert.ok(scripts.length >= 2);
});

scripts.forEach((src, i) => {
  test('inline script #' + (i + 1) + ' compiles', () => {
    assert.doesNotThrow(() => new vm.Script(src, { filename: 'index.html#script' + (i + 1) }));
  });
});
