import assert from 'node:assert/strict';
import test from 'node:test';
import { Fraction } from '../src/fraction.mjs';
import { solveComponent } from '../src/transport.mjs';
import { WorkLedger } from '../src/work-ledger.mjs';
import { bruteForceOptimal, validateFlow } from '../src/validate.mjs';

// 可复现的伪随机
function mulberry(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomModel(rnd, idx) {
  const nWords = 2 + Math.floor(rnd() * 4);
  const nSlots = 2 + Math.floor(rnd() * 4);
  const units = [];
  const wordQ = [];
  for (let w = 0; w < nWords; w++) {
    const q = 1 + Math.floor(rnd() * 2);
    wordQ.push(q);
    for (let k = 0; k < q; k++) units.push({ word: w, section: 0 });
  }
  const slots = [];
  const slotCap = [];
  for (let s = 0; s < nSlots; s++) {
    const c = 1 + Math.floor(rnd() * 2);
    slotCap.push(c);
    for (let k = 0; k < c; k++) slots.push({ slot: s, section: 0 });
  }
  const edgeMap = new Map();
  const skipMap = new Map();
  for (let w = 0; w < nWords; w++) {
    skipMap.set(w, 1 + Math.floor(rnd() * 6));
    const row = new Map();
    for (let s = 0; s < nSlots; s++) {
      // 稀疏边：约 55% 概率，含跨槽偏移，制造非平凡带宽
      if (rnd() < 0.55) {
        row.set(s, { a: Math.floor(rnd() * 6), b: -2 + Math.floor(rnd() * 5) });
      }
    }
    if (row.size) edgeMap.set(w, row);
  }
  // 保证至少有边可走
  if (edgeMap.size === 0) edgeMap.set(0, new Map([[0, { a: 1, b: 0 }]]));
  return {
    id: `fuzz${idx}`,
    units,
    slots,
    edgeMap,
    anchors: [],
    skipCost: (w) => skipMap.get(w),
    sectionsOf: () => 0,
    wordQ,
    slotCap,
  };
}

test('模糊：随机小问题 DP 解合法且达到暴力枚举最优（两极 × 多点）', () => {
  const rnd = mulberry(20261126);
  const ledger = new WorkLedger(1 << 22);
  let cases = 0;
  for (let i = 0; i < 120; i++) {
    const model = randomModel(rnd, i);
    for (const t of [-3, -1, 0, 1, 2]) {
      const point = Fraction.int(t);
      const brute = bruteForceOptimal(model, point);
      for (const lex of ['max', 'min']) {
        const res = solveComponent(model, point, lex, ledger);
        assert.ok(res.ok, `case ${i} t=${t} 求解失败`);
        const v = validateFlow(model, res.flow, point);
        assert.ok(v.valid, `case ${i} t=${t} 流非法: ${v.errors.join(';')}`);
        assert.equal(v.costAt, brute.cost, `case ${i} t=${t} 非最优`);
        // 成本线自洽：A+B*t 在该点等于 primary
        assert.equal(
          BigInt(res.sumA) * point.den + BigInt(res.sumB) * point.num,
          BigInt(res.primary),
        );
        cases++;
      }
    }
  }
  assert.ok(cases >= 1000);
});

test('模糊：随机强制锚要么可行且被满足，要么给出结构化冲突', () => {
  const rnd = mulberry(424242);
  const ledger = new WorkLedger(1 << 22);
  let feasible = 0;
  let conflict = 0;
  for (let i = 0; i < 80; i++) {
    const base = randomModel(rnd, i);
    // 随机挑一条存在的边做锚
    const words = [...base.edgeMap.keys()];
    const w = words[Math.floor(rnd() * words.length)];
    const sl = [...base.edgeMap.get(w).keys()][0];
    const model = { ...base, anchors: [{ word: w, slot: sl, min: 1 }] };
    const res = solveComponent(model, Fraction.int(rnd() < 0.5 ? 0 : 2), 'max', ledger);
    if (res.ok) {
      feasible++;
      const got = res.flow.filter((f) => f.word === w && f.slot === sl).reduce((s, f) => s + f.qty, 0);
      assert.ok(got >= 1, '可行解必须满足锚下界');
      const v = validateFlow(model, res.flow, Fraction.int(0));
      assert.ok(v.valid, v.errors.join(';'));
    } else {
      conflict++;
      assert.match(res.conflict.kind, /anchor-.*conflict/);
      assert.ok(Array.isArray(res.conflict.anchors));
      assert.ok(Array.isArray(res.conflict.sections));
    }
  }
  assert.equal(feasible + conflict, 80);
  assert.ok(feasible > 0);

  // 显式构造必冲突：两枚锚争同一容量 1 的槽
  const capOneSlotModel = (() => {
    const m = randomModel(mulberry(7), 999);
    const target = m.slots[0].slot;
    const w0 = m.units[0].word;
    const w1 = m.units[m.units.length - 1].word;
    // 保证两条边都存在
    for (const w of [w0, w1]) {
      if (!m.edgeMap.has(w)) m.edgeMap.set(w, new Map());
      m.edgeMap.get(w).set(target, { a: 0, b: 0 });
    }
    return { ...m, anchors: [
      { word: w0, slot: target, min: 1 },
      { word: w1, slot: target, min: 1 },
    ] };
  })();
  // 若两词恰好相同或槽容量>1，冲突断言可能不成立，用容量校验兜底
  const cap = capOneSlotModel.slots.filter((g) => g.slot === capOneSlotModel.anchors[0].slot).length;
  const distinctWords = new Set(capOneSlotModel.anchors.map((a) => a.word)).size === 2;
  if (cap === 1 && distinctWords) {
    const r = solveComponent(capOneSlotModel, Fraction.int(0), 'max', new WorkLedger(1 << 22));
    assert.equal(r.ok, false);
    assert.match(r.conflict.kind, /anchor-capacity-conflict/);
  }
});
