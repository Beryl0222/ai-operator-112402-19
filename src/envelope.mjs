// 参数化最优解包络。
//
// 每条边成本 a+b*t，跳过成本与 t 无关（b=0），因此每个可行计划对应一条直线
// A+B*t，最优总成本是这些直线的下包络——凹、分段线性，断点都是有理数。
// 求解器直接返回计划成本线 (sumA,sumB)，断点按 BigInt 分数精确求交。
//
// 递归枚举：
//   1) 区间两端各取 lex=max/min 两极最优解（覆盖并列计划）；
//   2) 两端计划集合相同 => 凹性下整段不再出现新计划，收敛；
//   3) 否则取两端代表性计划线的交点为断点，在断点上再解，左右递归。
// t 收窄为点时直接在该点求解，书签端点按包络内“所有最优计划”稳健判定。

import { Fraction } from './fraction.mjs';
import { solveComponent } from './transport.mjs';

export function planId(flow) {
  return flow.map((f) => `${f.word}>${f.slot}:${f.qty}`).join(',');
}

export function slotOfWordInPlan(flow, word) {
  const slots = [];
  let total = 0;
  for (const f of flow) {
    if (f.word === word) {
      slots.push({ slot: f.slot, qty: f.qty });
      total += f.qty;
    }
  }
  return { slots, total };
}

/**
 * 在有理点上求两个字典序极的最优解，按流标识去重。
 */
export function solveAt(model, point, ledger) {
  const hi = solveComponent(model, point, 'max', ledger);
  if (!hi.ok) return hi;
  const lo = solveComponent(model, point, 'min', ledger);
  if (!lo.ok) return lo;
  return { ok: true, point, plans: dedupPlans([hi, lo]) };
}

function dedupPlans(plans) {
  const seen = new Map();
  for (const p of plans) seen.set(planId(p.flow), p);
  return [...seen.values()];
}

// 两条计划成本线 (A1+B1*t) 与 (A2+B2*t) 的交点；平行或落在区间外返回 null。
function lineIntersection(p1, p2, lo, hi) {
  const A1 = BigInt(p1.sumA);
  const B1 = BigInt(p1.sumB);
  const A2 = BigInt(p2.sumA);
  const B2 = BigInt(p2.sumB);
  if (B1 === B2) return null;
  const t = new Fraction(A2 - A1, B1 - B2);
  if (t.lt(lo) || t.gt(hi)) return null;
  return t;
}

/**
 * 递归枚举闭区间 [lo,hi] 上所有出现过的最优计划。
 * @param {Map} [memo] 点缓存，key=point.toString()
 */
export function enumerateEnvelope(model, lo, hi, ledger, memo = new Map(), depth = 0) {
  if (depth > 128) throw new RangeError('参数包络递归过深，断点未收敛');
  const at = (p) => {
    const k = p.toString();
    if (!memo.has(k)) memo.set(k, solveAt(model, p, ledger));
    return memo.get(k);
  };

  const resLo = at(lo);
  if (!resLo.ok) return resLo;
  const resHi = lo.equals(hi) ? resLo : at(hi);
  if (!resHi.ok) return resHi;

  const collected = new Map();
  for (const p of [...resLo.plans, ...resHi.plans]) collected.set(planId(p.flow), p);

  if (lo.equals(hi)) return { ok: true, plans: [...collected.values()], memo };

  const sameSet =
    resLo.plans.length === resHi.plans.length &&
    resLo.plans.every((pl) => resHi.plans.some((ph) => planId(ph.flow) === planId(pl.flow)));
  if (sameSet) {
    // 两端最优计划集合一致：下包络在整段由同一组直线承担，内部无新计划。
    return { ok: true, plans: [...collected.values()], memo };
  }

  // 候选断点：两端代表计划线在区间内的交点；枚举所有跨端计划对以防漏断点。
  let mid = null;
  outer: for (const pl of resLo.plans) {
    for (const pr of resHi.plans) {
      if (planId(pl.flow) === planId(pr.flow)) continue;
      const t = lineIntersection(pl, pr, lo, hi);
      if (t && !t.equals(lo) && !t.equals(hi)) {
        mid = t;
        break outer;
      }
    }
  }
  if (!mid) return { ok: true, plans: [...collected.values()], memo };

  const resMid = at(mid);
  if (!resMid.ok) return resMid;
  for (const p of resMid.plans) collected.set(planId(p.flow), p);

  const left = enumerateEnvelope(model, lo, mid, ledger, memo, depth + 1);
  if (!left.ok) return left;
  for (const p of left.plans) collected.set(planId(p.flow), p);
  const right = enumerateEnvelope(model, mid, hi, ledger, memo, depth + 1);
  if (!right.ok) return right;
  for (const p of right.plans) collected.set(planId(p.flow), p);
  return { ok: true, plans: [...collected.values()], memo };
}

/**
 * 书签端点稳健性：该词全部质量在包络内每个最优计划中都进入同一个槽。
 * 任何计划里出现跳过（-1）或多个槽，都视为未落定。
 */
export function settleWord(plans, word, expectedQty) {
  let slot = null;
  const alternatives = new Set();
  for (const p of plans) {
    const { slots, total } = slotOfWordInPlan(p.flow, word);
    if (total !== expectedQty || slots.length !== 1) {
      if (total !== expectedQty) alternatives.add(-1);
      for (const s of slots) alternatives.add(s.slot);
      continue;
    }
    alternatives.add(slots[0].slot);
    if (slot === null) slot = slots[0].slot;
    else if (slot !== slots[0].slot) slot = -1;
  }
  const alts = [...alternatives].sort((a, b) => a - b);
  const settled = alts.length === 1 && alts[0] !== -1;
  return settled
    ? { settled: true, slot, qty: expectedQty, alternatives: alts }
    : { settled: false, alternatives: alts };
}
