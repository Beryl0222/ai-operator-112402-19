import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const qualification = JSON.parse(readFileSync(new URL('../inputs/qualification.json', import.meta.url), 'utf8'));

const { page } = await import('../inputs/qualification.mjs');
test('长稿折叠更新与后页锚跨越输入介质页但可在同段竞争', () => {
  const [a, b] = qualification.patch.edge;
  assert.equal(Math.floor(a / qualification.rowsPerPage), qualification.foldPage);
  const left = page(qualification, qualification.foldPage);
  const leftWord = left.source.find(({ word }) => word === a);
  const rightPage = Math.floor(b / qualification.rowsPerPage);
  const right = page(qualification, rightPage);
  const rightWord = right.target.find(({ word }) => word === b);
  assert.notEqual(qualification.foldPage, rightPage);
  assert.equal(leftWord.section, rightWord.section);
  assert.ok(left.edges.some(([word, target, cost]) => word === a && target === b && Array.isArray(cost)));
  assert.ok(qualification.updateReads < qualification.pages);
});
test('从真实页面验证全稿稀疏规模及显示词共享', () => {
  let edges = 0;
  let words = 0;
  let split = 0;
  for (let index = 0; index < qualification.pages; index += 1) {
    const input = page(qualification, index);
    words += input.source.length;
    edges += input.edges.length;
    split += input.views.length - input.source.length;
  }
  assert.equal(words, 7680);
  assert.ok(edges * 12 > qualification.maxWorkBytes);
  assert.ok(edges < words * 8);
  assert.ok(split > 1);
});
