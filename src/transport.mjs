// 单调（非交叉）整数输运求解器。
//
// 单元化：质量为 q 的源词展开为 q 个有序供应单元；容量为 c 的目标槽展开为 c 个
// 有序槽单元。非交叉约束（i<k 且正流 => j<=l）等价于序列对齐：
//   - 跳过供应单元：付该词 skip；
//   - 跳过槽单元：免费（槽允许闲置）；
//   - 匹配供应/槽单元：付边成本 a+b*t（t 代为有理点后比较整数 a*den+b*num）。
//
// 滚动行 DP：每行只保留实际可达漂移状态（稀疏带状），状态记录父漂移 pd 与
// 动作 move 供回溯。私有工作区按“同时存活的滚动行”计费（滑动窗口高水位），
// 与组件总长度无关，长稿可增量求解。主成本并列时以次级目标 (shipped 优先,
// 槽序之和) 取 lex=max/min 两极，供参数包络覆盖全部并列最优解。
//
// 强制锚 [word,slot,min] 为必须满足的下界流：先做容量/顺序/边校验，再按
// 固定匹配切成独立对齐子问题。任何矛盾返回结构化冲突（区段范围+涉及锚），
// 绝不静默跳过。

import { WorkLedger } from './work-ledger.mjs';

const CELL_BYTES = 20; // 每个可达状态的工作区记账
const FLOW_CELL = 16;
const MOVE_SKIP = 1;
const MOVE_MATCH_LOCAL = 2;

let solveSeq = 0;

/**
 * @param {object} model 组件模型
 * @param {{num:bigint,den:bigint}} point 字宽有理点
 * @param {'min'|'max'} lex 并列最优解下次级目标方向
 * @param {WorkLedger} [ledger]
 */
export function solveComponent(model, point, lex, ledger) {
  const { units, slots, edgeMap, anchors, sectionsOf, id } = model;
  const n = units.length;
  const m = slots.length;
  const den = Number(point.den);
  const num = Number(point.num);
  const tag = `dp:${id}:${point.num}/${point.den}:${lex}#${solveSeq++}`;
  const K = 2 * (n + m) + 4;
  const edgeCost = (e) => e.a * den + e.b * num;

  const anchorConflict = checkAnchors(model);
  if (anchorConflict) return { ok: false, conflict: anchorConflict };

  const forced = [];
  for (const an of anchors) {
    const ui = unitRange(units, an.word, true);
    const gi = unitRange(slots, an.slot, false);
    if (ui == null || gi == null) {
      return { ok: false, conflict: buildMissingConflict(anchors, an, sectionsOf) };
    }
    for (let k = 0; k < an.min; k++) {
      forced.push({ u: ui[0] + k, g: gi[0] + k, anchor: an });
    }
  }
  forced.sort((x, y) => x.u - y.u || x.g - y.g);
  for (let k = 1; k < forced.length; k++) {
    if (forced[k].g <= forced[k - 1].g) {
      return { ok: false, conflict: buildOrderConflict(anchors, sectionsOf) };
    }
  }
  for (const f of forced) {
    const e = edgeMap.get(units[f.u].word)?.get(slots[f.g].slot);
    if (!e) {
      return {
        ok: false,
        conflict: buildEdgeConflict(anchors, units[f.u].word, slots[f.g].slot, sectionsOf),
      };
    }
  }

  const steps = [];
  let cu = 0;
  let cg = 0;
  for (const f of forced) {
    if (f.u > cu || f.g > cg) {
      steps.push({ kind: 'align', u0: cu, u1: f.u, g0: cg, g1: f.g });
    }
    steps.push({ kind: 'fixed', f });
    cu = f.u + 1;
    cg = f.g + 1;
  }
  if (cu < n || cg < m) steps.push({ kind: 'align', u0: cu, u1: n, g0: cg, g1: m });

  const allMatches = [];
  let totalPrimary = 0;
  let totalSecondary = 0;
  let sumA = 0;
  let sumB = 0;

  for (const st of steps) {
    if (st.kind === 'fixed') {
      const { f } = st;
      const e = edgeMap.get(units[f.u].word).get(slots[f.g].slot);
      allMatches.push({ u: f.u, g: f.g, forced: true });
      totalPrimary += edgeCost(e);
      totalSecondary += K + f.g;
      sumA += e.a;
      sumB += e.b;
    } else {
      const res = align(st.u0, st.u1, st.g0, st.g1);
      if (!res) {
        ledger?.release(tag);
        return { ok: false, conflict: buildCapacityConflict(anchors, model, st, sectionsOf) };
      }
      totalPrimary += res.primary;
      totalSecondary += res.secondary;
      sumA += res.sumA;
      sumB += res.sumB;
      for (const mt of res.matches) allMatches.push(mt);
    }
  }
  ledger?.release(tag);

  const flowByWord = new Map();
  for (const mt of allMatches) {
    const w = units[mt.u].word;
    const sl = slots[mt.g].slot;
    let row = flowByWord.get(w);
    if (!row) flowByWord.set(w, (row = new Map()));
    row.set(sl, (row.get(sl) ?? 0) + 1);
  }
  const flow = [];
  for (const [w, row] of flowByWord) {
    for (const [sl, qty] of row) flow.push({ word: w, slot: sl, qty });
  }
  flow.sort((x, y) => x.word - y.word || x.slot - y.slot);
  return {
    ok: true,
    flow,
    primary: totalPrimary,
    secondary: totalSecondary,
    sumA,
    sumB,
    point,
    lex,
  };

  function better(cp, cs, bp, bs) {
    return cp < bp || (cp === bp && (lex === 'max' ? cs > bs : cs < bs));
  }

  // ---------------- 稀疏滚动行对齐 ----------------
  function align(u0, u1, g0, g1) {
    const rn = u1 - u0;
    const rm = g1 - g0;
    const tagCells = `${tag}:cells`;
    const tagFlow = `${tag}:flow`;

    // 预建槽位 -> 局部单元下标/数量，避免每个状态重复线性扫描
    const slotIndex = new Map();
    for (let q = 0; q < rm; q++) {
      const sl = slots[g0 + q].slot;
      if (!slotIndex.has(sl)) slotIndex.set(sl, q);
    }
    const slotCount = new Map();
    for (let q = 0; q < rm; q++) {
      const sl = slots[g0 + q].slot;
      slotCount.set(sl, (slotCount.get(sl) ?? 0) + 1);
    }
    // 每个词的边目标预解为局部槽单元范围 [{qStart,cap,e}]
    const wordEdges = new Array(rn);
    for (let p = 0; p < rn; p++) {
      const w = units[u0 + p].word;
      const row = edgeMap.get(w);
      if (!row) {
        wordEdges[p] = [];
        continue;
      }
      const arr = [];
      for (const [sl, e] of row) {
        const qStart = slotIndex.get(sl);
        if (qStart === undefined) continue;
        arr.push({ qStart, cap: slotCount.get(sl), e });
      }
      wordEdges[p] = arr;
    }

    // rows[p]: Map<drift, state>。保留全部行用于回溯，但账本只按同时存活的
    // 滚动窗口计费（见 ledger.window）；JS 堆占用与行宽×行数同级，数据本身稀疏。
    const rows = [new Map([[0, { p: 0, s: 0, a: 0, b: 0, pd: null, move: 0 }]])];
    ledger?.openWindow(tagCells);

    for (let p = 0; p < rn; p++) {
      const word = units[u0 + p].word;
      const skip = model.skipCost(word);
      const targets = wordEdges[p];
      const next = new Map();
      const consider = (d, cand) => {
        const qConsumed = p + 1 + d;
        if (qConsumed > rm) return; // 槽上界（唯一安全剪枝，负漂移合法）
        const ex = next.get(d);
        if (!ex || better(cand.p, cand.s, ex.p, ex.s)) next.set(d, cand);
      };

      for (const [d, st] of rows[p]) {
        const qCur = p + d;
        // 动作 1：跳过供应，新漂移 d-1
        consider(d - 1, {
          p: st.p + skip,
          s: st.s,
          a: st.a + skip,
          b: st.b,
          pd: d,
          move: MOVE_SKIP,
        });
        // 动作 2：匹配边（可先免费跳过若干槽），新漂移 q-p，父漂移 d
        for (const { qStart, cap, e } of targets) {
          for (let k = 0; k < cap; k++) {
            const q = qStart + k;
            if (q < qCur) continue;
            consider(q - p, {
              p: st.p + edgeCost(e),
              s: st.s + K + (g0 + q),
              a: st.a + e.a,
              b: st.b + e.b,
              pd: d,
              move: MOVE_MATCH_LOCAL,
            });
          }
        }
      }
      rows.push(next);
      ledger?.noteRow(tagCells, next.size * CELL_BYTES);
      if (next.size === 0) {
        ledger?.closeWindow(tagCells);
        return null;
      }
    }

    // 末行：免费跳过剩余槽，取字典序最优末端
    let endDrift = 0;
    let endState = null;
    for (const [d, st] of rows[rn]) {
      const q = rn + d;
      if (q >= 0 && q <= rm && (!endState || better(st.p, st.s, endState.p, endState.s))) {
        endState = st;
        endDrift = d;
      }
    }
    if (!endState) {
      ledger?.closeWindow(tagCells);
      return null;
    }

    // 回溯
    const matches = [];
    let d = endDrift;
    for (let p = rn; p >= 1; p--) {
      const st = rows[p].get(d);
      if (!st) {
        ledger?.closeWindow(tagCells);
        return null;
      }
      if (st.move === MOVE_MATCH_LOCAL) {
        const qAfter = p + d;
        matches.push({ u: u0 + p - 1, g: g0 + qAfter - 1 });
      }
      d = st.pd;
    }
    matches.reverse();
    ledger?.noteRow(tagFlow, matches.length * FLOW_CELL);
    ledger?.closeWindow(tagCells);
    ledger?.closeWindow(tagFlow);
    return {
      primary: endState.p,
      secondary: endState.s,
      sumA: endState.a,
      sumB: endState.b,
      matches,
    };
  }
}

// ---------------- 单元定位与锚校验 ----------------

function unitRange(items, key, isUnit) {
  let lo = -1;
  let hi = -1;
  for (let i = 0; i < items.length; i++) {
    const v = isUnit ? items[i].word : items[i].slot;
    if (v === key) {
      if (lo < 0) lo = i;
      hi = i + 1;
    }
  }
  return lo < 0 ? null : [lo, hi];
}

function checkAnchors(model) {
  const { anchors, units, slots, sectionsOf } = model;
  if (!anchors.length) return null;
  const wordUnits = new Map();
  for (const u of units) wordUnits.set(u.word, (wordUnits.get(u.word) ?? 0) + 1);
  const slotUnits = new Map();
  for (const g of slots) slotUnits.set(g.slot, (slotUnits.get(g.slot) ?? 0) + 1);

  const bad = [];
  for (const an of anchors) {
    const q = wordUnits.get(an.word);
    const c = slotUnits.get(an.slot);
    if (q === undefined || c === undefined || an.min > q || an.min > c) bad.push(an);
  }
  if (bad.length) return buildCapacityConflictList(dedup(bad), sectionsOf);

  const perSlot = new Map();
  const perWord = new Map();
  for (const an of anchors) {
    perSlot.set(an.slot, (perSlot.get(an.slot) ?? 0) + an.min);
    perWord.set(an.word, (perWord.get(an.word) ?? 0) + an.min);
  }
  const clash = [];
  for (const [sl, sum] of perSlot) {
    if (sum > slotUnits.get(sl)) clash.push(...anchors.filter((a) => a.slot === sl));
  }
  for (const [w, sum] of perWord) {
    if (sum > wordUnits.get(w)) clash.push(...anchors.filter((a) => a.word === w));
  }
  if (clash.length) return buildCapacityConflictList(dedup(clash), sectionsOf);
  return null;
}

function dedup(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = `${x.word}:${x.slot}:${x.min}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(x);
    }
  }
  return out;
}

function sectionRange(anchors, sectionsOf) {
  const secs = anchors.map((a) => sectionsOf(a.word, a.slot));
  return [Math.min(...secs), Math.max(...secs)];
}

function buildCapacityConflictList(anchors, sectionsOf) {
  return {
    kind: 'anchor-capacity-conflict',
    sections: sectionRange(anchors, sectionsOf),
    anchors: anchors.map((a) => [a.word, a.slot, a.min]),
    reason: '锚位最小容量超过词质量/槽容量，或同槽、同词锚合计超限',
  };
}

function buildCapacityConflict(anchors, model, st, sectionsOf) {
  const scope = anchors.length
    ? anchors
    : [{ word: model.units[st.u0]?.word ?? 0, slot: model.slots[st.g0]?.slot ?? 0, min: 0 }];
  return {
    kind: 'anchor-capacity-conflict',
    sections: sectionRange(scope, sectionsOf),
    anchors: anchors.map((x) => [x.word, x.slot, x.min]),
    reason: `强制锚切开后的子问题 [${st.u0},${st.u1})×[${st.g0},${st.g1}) 无可行单调对齐`,
  };
}

function buildOrderConflict(anchors, sectionsOf) {
  return {
    kind: 'anchor-order-conflict',
    sections: sectionRange(anchors, sectionsOf),
    anchors: anchors.map((a) => [a.word, a.slot, a.min]),
    reason: '强制锚在供应序与槽序上不能同时单调，违反非交叉约束',
  };
}

function buildEdgeConflict(anchors, word, slot, sectionsOf) {
  return {
    kind: 'anchor-edge-conflict',
    sections: sectionRange(anchors, sectionsOf),
    anchors: anchors.map((a) => [a.word, a.slot, a.min]),
    reason: `强制匹配缺少可用边 word=${word} slot=${slot}（受 section/bridge 限制）`,
  };
}

function buildMissingConflict(anchors, an, sectionsOf) {
  return {
    kind: 'anchor-missing-conflict',
    sections: sectionRange(anchors, sectionsOf),
    anchors: anchors.map((a) => [a.word, a.slot, a.min]),
    reason: `锚引用了组件外的词或槽 word=${an.word} slot=${an.slot}`,
  };
}
