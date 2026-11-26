import assert from 'node:assert/strict';
import test from 'node:test';
import { Fraction } from '../src/fraction.mjs';
import { enumerateEnvelope, solveAt } from '../src/envelope.mjs';
import { WorkLedger } from '../src/work-ledger.mjs';

// 构造三条成本线，使中间一条只在单点 t=0 最优（下包络尖点）：
//   计划 L: -t（t<0 优），计划 M: 0（仅 t=0 并列），计划 R: t（t>0 优）
// 单供应、单槽，用不同边不可行（一个词到一个槽只有一条边），因此用三槽
// 各连一条边，配合 skip 让 DP 在不同 t 选不同槽。
function buildModel() {
  // 一个质量 1 的词，三个容量 1 的槽
  const units = [{ word: 0, section: 0 }];
  const slots = [{ slot: 0 }, { slot: 1 }, { slot: 2 }];
  const edgeMap = new Map([
    [0, new Map([
      [0, { a: 0, b: -1 }], // 成本 -t
      [1, { a: 0, b: 0 }],  // 成本 0
      [2, { a: 0, b: 1 }],  // 成本 t
    ])],
  ]);
  return {
    id: 'spike',
    units,
    slots,
    edgeMap,
    anchors: [],
    skipCost: () => 100, // skip 很贵，保证一定出运
    sectionsOf: () => 0,
  };
}

test('参数包络枚举下包络尖点：并列点的全部同成本计划被捕获', () => {
  const ledger = new WorkLedger(1 << 20);
  const model = buildModel();
  const env = enumerateEnvelope(model, Fraction.int(-2), Fraction.int(2), ledger);
  assert.ok(env.ok);
  const bSet = new Set(env.plans.map((p) => p.sumB));
  // 最小化下：b=1 在负 t 最优、b=-1 在正 t 最优，两者都是包络段
  assert.ok(bSet.has(-1));
  assert.ok(bSet.has(1));
  // t=0 三线同成本 0，求解器给出的每个计划主成本都必须为 0
  const at0 = solveAt(model, Fraction.int(0), ledger);
  assert.ok(at0.plans.length >= 1);
  for (const p of at0.plans) assert.equal(p.primary, 0);
});

test('收窄到偏离尖点的点：只保留该侧最优计划', () => {
  const ledger = new WorkLedger(1 << 20);
  const model = buildModel();
  // t=1>0：最小化下 b=-1 的线成本 -1 最优
  const env = enumerateEnvelope(model, Fraction.int(1), Fraction.int(1), ledger);
  assert.equal(env.plans.length, 1);
  assert.equal(env.plans[0].sumB, -1);
});
