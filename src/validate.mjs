// 流的独立约束校验：与求解器内部实现无关，直接核对运输约束与最优性。
// 用于测试，不进引擎工作区记账。

export function validateFlow(model, flow, point) {
  const { units, slots, edgeMap, anchors } = model;
  const errors = [];
  const wordMass = new Map();
  for (const u of units) wordMass.set(u.word, (wordMass.get(u.word) ?? 0) + 1);
  const slotCap = new Map();
  for (const g of slots) slotCap.set(g.slot, (slotCap.get(g.slot) ?? 0) + 1);

  // 1) 每条流必须有合法边且非负、整数
  const shippedPerWord = new Map();
  const usedPerSlot = new Map();
  for (const f of flow) {
    if (!Number.isInteger(f.qty) || f.qty <= 0) errors.push(`非法流量 ${JSON.stringify(f)}`);
    const e = edgeMap.get(f.word)?.get(f.slot);
    if (!e) errors.push(`流使用了不存在的边 word=${f.word} slot=${f.slot}`);
    shippedPerWord.set(f.word, (shippedPerWord.get(f.word) ?? 0) + f.qty);
    usedPerSlot.set(f.slot, (usedPerSlot.get(f.slot) ?? 0) + f.qty);
  }
  // 2) 出运不超过质量；未出运即跳过
  for (const [w, q] of shippedPerWord) {
    if (q > (wordMass.get(w) ?? 0)) errors.push(`词 ${w} 出运 ${q} 超过质量`);
  }
  // 3) 槽容量
  for (const [sl, q] of usedPerSlot) {
    if (q > (slotCap.get(sl) ?? 0)) errors.push(`槽 ${sl} 装载 ${q} 超过容量`);
  }
  // 4) 非交叉：i<k 的正流，目标槽序单调不减
  const byWord = new Map();
  for (const f of flow) {
    if (!byWord.has(f.word)) byWord.set(f.word, []);
    byWord.get(f.word).push(f.slot);
  }
  const words = [...byWord.keys()].sort((a, b) => a - b);
  let prevMax = -Infinity;
  for (const w of words) {
    const sls = byWord.get(w).sort((a, b) => a - b);
    if (sls[0] < prevMax) errors.push(`违反非交叉：词 ${w} 的槽 ${sls[0]} 早于前词 ${prevMax}`);
    prevMax = sls.at(-1);
  }
  // 5) 强制锚下界
  for (const an of anchors) {
    const got = flow.filter((f) => f.word === an.word && f.slot === an.slot)
      .reduce((s, f) => s + f.qty, 0);
    if (got < an.min) errors.push(`锚未满足 word=${an.word} slot=${an.slot} 需要>=${an.min} 实得${got}`);
  }
  // 6) 成本线：返回该流的 A、B 与在 point 处成本
  const den = BigInt(point.den);
  const num = BigInt(point.num);
  let A = 0n;
  let B = 0n;
  for (const f of flow) {
    const e = edgeMap.get(f.word).get(f.slot);
    A += BigInt(e.a) * BigInt(f.qty);
    B += BigInt(e.b) * BigInt(f.qty);
  }
  for (const [w, mass] of wordMass) {
    const shipped = shippedPerWord.get(w) ?? 0;
    A += BigInt(model.skipCost(w)) * BigInt(mass - shipped);
  }
  const costAt = A * den + B * num;
  return {
    valid: errors.length === 0,
    errors,
    line: { A, B },
    costAt,
    shipped: shippedPerWord,
  };
}

// 暴力枚举小问题的所有非交叉可行流，取最低成本，验证 DP 的最优性。
export function bruteForceOptimal(model, point) {
  const { units, slots, edgeMap } = model;
  const den = BigInt(point.den);
  const num = BigInt(point.num);
  let best = null;
  const n = units.length;
  const m = slots.length;

  function costOf(matches) {
    let c = 0n;
    const used = new Set();
    const matchedU = new Set();
    for (const [u, g] of matches) {
      const e = edgeMap.get(units[u].word)?.get(slots[g].slot);
      if (!e) return null;
      if (used.has(g) || matchedU.has(u)) return null;
      c += BigInt(e.a) * den + BigInt(e.b) * num;
      used.add(g);
      matchedU.add(u);
    }
    for (let u = 0; u < n; u++) {
      if (!matchedU.has(u)) c += BigInt(model.skipCost(units[u].word)) * den;
    }
    return c;
  }

  // 递归生成非交叉匹配（u、g 同时单调）
  function rec(u, g, matches) {
    if (u === n || g === m) {
      const c = costOf(matches);
      if (c !== null && (best === null || c < best.cost)) {
        best = { cost: c, matches: [...matches] };
      }
      return;
    }
    // 跳过 u
    rec(u + 1, g, matches);
    // 跳过 g
    rec(u, g + 1, matches);
    // 匹配 (u,g)（边存在时）
    if (edgeMap.get(units[u].word)?.has(slots[g].slot)) {
      matches.push([u, g]);
      rec(u + 1, g + 1, matches);
      matches.pop();
    }
  }
  rec(0, 0, []);
  return best;
}
