import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import { layoutPage } from '../inputs/layout-pages.mjs';

const data=JSON.parse(readFileSync(new URL('../inputs/layout-pages.json',import.meta.url),'utf8'));
test('长稿稀疏排版页的格式与关联', () => {
  const boundary = layoutPage(51);
  const following = layoutPage(52);
  assert.equal(boundary.sources.length,data.rows);
  assert.notEqual(boundary.sources[0].section,following.sources[0].section);
  assert.ok(data.bridges.some(e => e[0] <= boundary.sources.at(-1).ordinal && e[1] >= following.targets[0].ordinal));
  assert.ok(new Set(data.toy.edges.map(e=>e[3])).size === 3);
  assert.ok(data.locks[0][1] === data.proposedLock[1]);
  assert.ok(data.range[0] < data.fold.num/data.fold.den && data.fold.num/data.fold.den < data.range[1]);
  assert.ok(data.updatePages < data.pages);
  assert.equal(data.events[2][2],data.events[1][1]);
});
