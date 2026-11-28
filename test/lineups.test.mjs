// The Lineups schedule table must list every 3-player lineup exactly once for each roster size.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const HTML = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const m = /var LINEUP = (\{[\s\S]*?\});/.exec(HTML);
assert.ok(m, 'LINEUP table not found');
const LINEUP = vm.runInNewContext('(' + m[1] + ')');
const choose3 = (n) => n * (n - 1) * (n - 2) / 6;

test('Lineups supports 4 to 7 players', () => {
  assert.deepEqual(Object.keys(LINEUP).map(Number).sort(), [4, 5, 6, 7]);
});

for (const n of [4, 5, 6, 7]) {
  test(n + ' players: every 3-player lineup appears once, using only slots 1-' + n, () => {
    const codes = LINEUP[n].split(' ');
    assert.equal(codes.length, choose3(n));
    assert.equal(new Set(codes.map((c) => [...c].sort().join(''))).size, codes.length);
    for (const c of codes) {
      assert.equal(c.length, 3);
      assert.ok([...c].every((d) => +d >= 1 && +d <= n), c);
      assert.equal(new Set(c).size, 3);
    }
  });
}
