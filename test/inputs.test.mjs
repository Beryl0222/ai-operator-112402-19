import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const d = JSON.parse(readFileSync(new URL('../inputs/session.json', import.meta.url), 'utf8'));

test("输入边及锚定都索引真实位置", () => {
  assert.ok(d.edges.every(e=>d.source[e[0]]&&d.target[e[1]])&&d.anchors.every(e=>d.source[e[0]]&&d.target[e[1]]));
});

test("缺折叠候选与容量紧张共存", () => {
  assert.ok(d.edges.some(e=>Array.isArray(e[2]))&&d.target[0].cap<d.source[0].mass);
});

test("相邻最低局部成本存在不合法交叉", () => {
  assert.ok(d.edges[1][0]<d.edges[2][0]&&d.edges[1][1]>d.edges[2][1]);
});
