import assert from 'node:assert/strict';
import test from 'node:test';
import data from '../inputs/layout-pages.json' with { type: 'json' };
import { Fraction } from '../src/fraction.mjs';
import { solveAt, enumerateEnvelope, settleWord } from '../src/envelope.mjs';
import { solveComponent } from '../src/transport.mjs';
import { WorkLedger } from '../src/work-ledger.mjs';
import { bruteForceOptimal, validateFlow } from '../src/validate.mjs';

function buildToyModel(anchors = []) {
  const { src, dst, edges } = data.toy;
  const units = [];
  for (const [word, q] of src) for (let k = 0; k < q; k++) units.push({ word, section: 0 });
  const slots = [];
  for (const [slot, cap] of dst) for (let k = 0; k < cap; k++) slots.push({ slot, section: 0 });
  const edgeMap = new Map();
  for (const [i, j, a, b] of edges) {
    if (!edgeMap.has(i)) edgeMap.set(i, new Map());
    edgeMap.get(i).set(j, { a, b });
  }
  const skipMap = new Map(src.map(([w, q, sk]) => [w, sk]));
  return {
    id: 'toy',
    units,
    slots,
    edgeMap,
    anchors: anchors.map(([word, slot, min]) => ({ word, slot, min })),
    skipCost: (w) => skipMap.get(w),
    sectionsOf: () => 0,
  };
}

test('toy：点解满足全部运输约束且与暴力枚举最优成本一致', () => {
  const ledger = new WorkLedger(data.workBytes);
  for (const t of [-2, -1, 0, 1, 2]) {
    const point = Fraction.int(t);
    const model = buildToyModel();
    const res = solveAt(model, point, ledger);
    assert.ok(res.ok);
    const brute = bruteForceOptimal(model, point);
    for (const plan of res.plans) {
      const v = validateFlow(model, plan.flow, point);
      assert.ok(v.valid, `t=${t} 约束违背: ${v.errors.join(';')}`);
      assert.equal(v.costAt, brute.cost, `t=${t} 计划成本未达暴力最优`);
      // 求解器成本线 (A,B) 与独立核算一致
      assert.equal(plan.sumA, Number(v.line.A));
      assert.equal(plan.sumB, Number(v.line.B));
    }
  }
});

test('toy：参数包络枚举两条最优线，断点 t=1，并列点捕获两极计划', () => {
  const ledger = new WorkLedger(data.workBytes);
  const model = buildToyModel();
  const env = enumerateEnvelope(model, Fraction.int(-2), Fraction.int(2), ledger);
  assert.ok(env.ok);
  const lines = env.plans.map((p) => `${p.sumA}+${p.sumB}t`).sort();
  assert.deepEqual(lines, ['0+3t', '3+0t']);
  // t=1 两线并列：solveAt 应返回两个不同流
  const at1 = solveAt(model, Fraction.int(1), ledger);
  assert.equal(at1.plans.length, 2);
});

test('toy：书签端点稳健性——词 2 全区间固定槽 2，词 0/1 未落定', () => {
  const ledger = new WorkLedger(data.workBytes);
  const model = buildToyModel();
  const env = enumerateEnvelope(model, Fraction.int(-2), Fraction.int(2), ledger);
  const q0 = model.units.filter((u) => u.word === 0).length;
  const q2 = model.units.filter((u) => u.word === 2).length;
  const s0 = settleWord(env.plans, 0, q0);
  const s2 = settleWord(env.plans, 2, q2);
  assert.equal(s0.settled, false);
  assert.deepEqual(s0.alternatives.sort(), [0, 1]);
  assert.equal(s2.settled, true);
  assert.equal(s2.slot, 2);
});

test('toy：收窄到点后落定判定与该点全部最优解一致', () => {
  const ledger = new WorkLedger(data.workBytes);
  const model = buildToyModel();
  const env = enumerateEnvelope(model, Fraction.int(0), Fraction.int(0), ledger);
  // t=0 唯一最优（3t 线），词 1 出运到槽 1
  const q1 = model.units.filter((u) => u.word === 1).length;
  const s1 = settleWord(env.plans, 1, q1);
  assert.equal(s1.settled, true);
  assert.equal(s1.slot, 1);
});

test('toy：强制锚可行时被满足，且仍为全局最优', () => {
  const ledger = new WorkLedger(data.workBytes);
  const model = buildToyModel([[2, 2, 1]]);
  const res = solveComponent(model, Fraction.int(0), 'max', ledger);
  assert.ok(res.ok);
  const v = validateFlow(model, res.flow, Fraction.int(0));
  assert.ok(v.valid);
  const got = res.flow.find((f) => f.word === 2 && f.slot === 2);
  assert.ok(got && got.qty >= 1);
});

test('toy：同槽锚容量冲突返回结构化冲突而非静默跳过', () => {
  const ledger = new WorkLedger(data.workBytes);
  // 槽 0 容量 2，两枚锚各要 1，但词 0 质量仅 2 且边受限：构造直接超容
  const model = buildToyModel([
    [0, 0, 2],
    [1, 0, 1],
  ]);
  const res = solveComponent(model, Fraction.int(0), 'max', ledger);
  assert.equal(res.ok, false);
  assert.match(res.conflict.kind, /anchor-.*conflict/);
  assert.ok(Array.isArray(res.conflict.sections));
  assert.ok(res.conflict.anchors.length >= 2);
});

test('toy：强制锚缺少可用边时报 edge-conflict', () => {
  const ledger = new WorkLedger(data.workBytes);
  // 词 2 只有到槽 2 的边
  const model = buildToyModel([[2, 0, 1]]);
  const res = solveComponent(model, Fraction.int(0), 'max', ledger);
  assert.equal(res.ok, false);
  assert.equal(res.conflict.kind, 'anchor-edge-conflict');
});

test('toy：工作区有界且不超预算，求解后临时区归还', () => {
  const ledger = new WorkLedger(data.workBytes);
  const model = buildToyModel();
  solveComponent(model, Fraction.int(0), 'max', ledger);
  solveComponent(model, Fraction.int(1), 'min', ledger);
  assert.ok(ledger.peak <= data.workBytes);
  assert.equal(ledger.current, 0);
});
