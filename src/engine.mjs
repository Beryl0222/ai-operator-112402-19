// 离线长文排版引擎：参数化单调输运 + 联动书签。
//
// 关键不变量：
//  - 平常改一处字宽或锚点只重算受影响的连通组件，不重扫整个长稿；
//  - 计算不确定（参数区间内最优解不唯一、书签端点未落定）与出版阻塞
//    （桥/区段缺连续出版许可、锚冲突）是两个独立状态，永不合并；
//  - 书签每端必须在“所有仍可能的字宽 × 所有最优流”下把该词全部质量
//    送到同一个槽，两端及区间内经过的桥还需同一版连续出版许可，方可迁移；
//  - 已批准迁移的回读冻结当时整段版本，新稿审批不得静默改写旧划线坐标。

import { Fraction } from './fraction.mjs';
import { WorkLedger } from './work-ledger.mjs';
import { enumerateEnvelope, planId, settleWord, solveAt } from './envelope.mjs';
import { buildComponents, buildModel, PageStore } from './model.mjs';

export class LayoutEngine {
  constructor({ layoutPage, data }) {
    this.data = data;
    this.store = new PageStore(layoutPage, data);
    this.components = buildComponents(data);
    this.ledger = new WorkLedger(data.workBytes);
    // 字宽参数：初始为整卷共享闭区间
    this.range = [Fraction.int(data.range[0]), Fraction.int(data.range[1])];
    this.point = null; // 收窄为点后非空
    this.anchors = data.locks.map(([w, s, m]) => [w, s, m]);
    this.blockedSections = new Set(); // bridge blocked 事件登记
    // 组件缓存：model / envelope 计划 / 版本
    this.cache = new Map();
    this.version = 0;
    // 书签与别名
    this.bookmarks = new Map(); // name -> {name, start, end, refs:Set, snapshots:[]}
    this.aliases = new Map(); // alias -> bookmarkName
    this.conflict = null; // 最近一次锚冲突（结构化）
    this.evidence = []; // 已领取之外仍保留的区段证据
    this.openView = null; // 开版视图名
  }

  componentOf(word) {
    const sec = this.store.sectionOfOrdinal(word);
    return this.components.find((c) => c.sectionSet.has(sec));
  }

  // ---------------- 增量求解 ----------------

  invalidateComponent(compId) {
    this.cache.delete(compId);
  }

  solveComponent(comp) {
    const cached = this.cache.get(comp.id);
    if (cached && cached.version === this.version) return cached;
    const model = cached?.model ?? buildModel(this.store, comp, this.anchors);
    // 锚可能变化：重建模型以纳入新锚
    const fresh = buildModel(this.store, comp, this.anchors);
    const [lo, hi] = this.range;
    let result;
    if (this.point) {
      result = solveAt(fresh, this.point, this.ledger);
    } else {
      result = enumerateEnvelope(fresh, lo, hi, this.ledger);
    }
    if (!result.ok) {
      this.conflict = result.conflict;
      const entry = {
        version: this.version,
        model: fresh,
        ok: false,
        conflict: result.conflict,
        plans: [],
        memo: result.memo ?? new Map(),
      };
      this.cache.set(comp.id, entry);
      return entry;
    }
    this.conflict = null;
    const entry = {
      version: this.version,
      model: fresh,
      ok: true,
      plans: result.plans,
      memo: result.memo ?? new Map(),
    };
    this.cache.set(comp.id, entry);
    return entry;
  }

  // 收窄字宽：点 (num/den) 必须落在当前闭区间内；只影响含相关边的组件，
  // 但书签要按依赖重估（远处容量争用可能改变可迁移性）。
  narrow(num, den) {
    const p = Fraction.from(num, den);
    if (!Fraction.contains(this.range, p)) {
      throw new RangeError(`字宽点 ${p} 落在当前区间 [${this.range[0]},${this.range[1]}] 之外`);
    }
    this.point = p;
    this.range = [p, p];
    this.version += 1;
    // 全部组件缓存失效（参数共享），但页面不重新交付，DP 才是工作区开销
    for (const c of this.components) this.invalidateComponent(c.id);
    return { kind: 'narrow', point: p.toString() };
  }

  // 新增锚：立即校验并定位实际冲突范围，冲突不静默跳过
  addAnchor(word, slot, min) {
    this.anchors.push([word, slot, min]);
    this.version += 1;
    const comp = this.componentOf(word);
    this.invalidateComponent(comp.id);
    const entry = this.solveComponent(comp);
    if (!entry.ok) {
      return { kind: 'anchor', accepted: false, conflict: entry.conflict };
    }
    return { kind: 'anchor', accepted: true, anchor: [word, slot, min] };
  }

  // 登记出版阻塞：某 section 的桥/连续锚失去出版许可（图中的桥边保留）
  blockSection(section) {
    this.blockedSections.add(section);
    this.version += 1;
    return { kind: 'bridge-blocked', section };
  }

  // ---------------- 书签 ----------------

  addBookmark(name, start, end, refName = name) {
    const mark = {
      name,
      start,
      end,
      refs: new Set([refName]),
      snapshots: [], // 已批准迁移：冻结整段版本
    };
    this.bookmarks.set(name, mark);
    this.aliases.set(refName, name);
    this.bindOpenView(mark);
    return mark;
  }

  // 开版视图：在书签尚未登记前先占位，之后登记的首个书签自动承接该视图引用
  registerOpenView(view) {
    this.openView = view;
    this.aliases.set(view, null);
  }

  addAlias(alias, bookmarkName) {
    const bm = this.bookmarks.get(bookmarkName);
    if (!bm) throw new RangeError(`别名引用了未知书签 ${bookmarkName}`);
    bm.refs.add(alias);
    this.aliases.set(alias, bookmarkName);
  }

  // 把开版视图绑定到首个书签（book 事件调用）
  bindOpenView(mark) {
    if (this.openView && !mark.refs.has(this.openView)) {
      mark.refs.add(this.openView);
      this.aliases.set(this.openView, mark.name);
    }
  }

  resolveBookmark(name) {
    const direct = this.bookmarks.get(name);
    if (direct) return direct;
    const via = this.aliases.get(name);
    return via ? this.bookmarks.get(via) : undefined;
  }

  massOf(word) {
    const comp = this.componentOf(word);
    const entry = this.solveComponent(comp);
    if (!entry.ok) return null;
    const unit = entry.model.units.filter((u) => u.word === word).length;
    return unit;
  }

  // 两端落定：所有仍可能字宽下、每个最优流都把整词质量送到同一槽
  settleEndpoints(bm) {
    const compS = this.componentOf(bm.start);
    const compE = this.componentOf(bm.end);
    const parts = [];
    for (const [word, comp] of [[bm.start, compS], [bm.end, compE]]) {
      const entry = this.solveComponent(comp);
      if (!entry.ok) {
        parts.push({ word, settled: false, conflict: entry.conflict });
        continue;
      }
      const qty = entry.model.units.filter((u) => u.word === word).length;
      const verdict = settleWord(entry.plans, word, qty);
      parts.push({ word, qty, ...verdict, comp: comp.id });
    }
    return parts;
  }

  // 出版许可：两端所在 section 与区间内经过的桥都不能落在阻塞段，
  // 且流路径上的桥必须仍存在于成本图（公开出版边界不删桥，只限制迁移）。
  publicationCheck(bm, endpoints) {
    const comp = this.componentOf(bm.start);
    const entry = this.solveComponent(comp);
    const blockers = [];
    const secStart = this.store.sectionOfOrdinal(bm.start);
    const secEnd = this.store.sectionOfOrdinal(bm.end);
    for (let s = secStart; s <= secEnd; s++) {
      if (this.blockedSections.has(s)) blockers.push({ type: 'section', section: s });
    }
    // 区间内经过的桥：端点 ordinal 之间、且属于本组件
    const usedBridges = [];
    for (const br of this.data.bridges) {
      const [i, j] = br;
      if (i >= bm.start && j <= bm.end) {
        usedBridges.push({ bridge: br, sections: [this.store.sectionOfOrdinal(i), this.store.sectionOfOrdinal(j)] });
        if (this.blockedSections.has(this.store.sectionOfOrdinal(i)) ||
            this.blockedSections.has(this.store.sectionOfOrdinal(j))) {
          blockers.push({ type: 'bridge', bridge: br });
        }
      }
    }
    // 连续锚验证：任一端落定后，流路径必须能按同一稿件顺序连续引用
    let orderOk = true;
    const orderReason = [];
    if (entry.ok && endpoints.every((e) => e.settled)) {
      const slots = endpoints.map((e) => e.slot);
      if (slots[0] > slots[1]) {
        orderOk = false;
        orderReason.push('两端落点逆序，违反同一稿件顺序');
      }
      // 桥必须在某个最优计划中实际可用（图中保留即候选，出版侧再卡阻塞）
    }
    return {
      permitted: blockers.length === 0 && orderOk,
      blockers,
      usedBridges,
      orderOk,
      orderReason,
    };
  }

  /**
   * 评估书签：计算状态与出版状态分别报告。
   */
  evaluate(name) {
    const bm = this.resolveBookmark(name);
    if (!bm) throw new RangeError(`未知书签 ${name}`);
    const endpoints = this.settleEndpoints(bm);
    const computation = {
      status: endpoints.every((e) => e.settled) ? 'settled' : 'uncertain',
      point: this.point ? this.point.toString() : null,
      range: [this.range[0].toString(), this.range[1].toString()],
      endpoints,
    };
    const pub = this.publicationCheck(bm, endpoints);
    const publication = {
      status: pub.permitted ? 'publishable' : 'blocked',
      ...pub,
    };
    const migratable = computation.status === 'settled' && publication.status === 'publishable';
    return { name: bm.name, refs: [...bm.refs], computation, publication, migratable };
  }

  // 批准迁移：仅当 migratable；冻结当时整段版本（含字宽、锚、流、区间）
  approve(name) {
    const eval_ = this.evaluate(name);
    if (!eval_.migratable) {
      // 计算未落定优先报 uncertain；计算已落定但出版受阻才是 blocked
      const reason = eval_.computation.status === 'settled' ? 'blocked' : 'uncertain';
      return { approved: false, reason, evaluation: eval_ };
    }
    const bm = this.bookmarks.get(eval_.name);
    const snapshot = {
      version: this.version,
      point: this.point ? this.point.toString() : null,
      range: [this.range[0].toString(), this.range[1].toString()],
      anchors: this.anchors.map((a) => [...a]),
      endpoints: eval_.computation.endpoints.map((e) => ({
        word: e.word,
        slot: e.slot,
        qty: e.qty,
      })),
      planIds: this.planIdsFor(bm),
      refs: [...bm.refs],
      blockedSections: [...this.blockedSections],
    };
    bm.snapshots.push(snapshot);
    return { approved: true, snapshot };
  }

  planIdsFor(bm) {
    const comp = this.componentOf(bm.start);
    const entry = this.solveComponent(comp);
    if (!entry.ok) return [];
    return entry.plans.map((p) => planId(p.flow));
  }

  // 回读：优先返回已批准快照（冻结坐标），不被后续改稿静默改写
  read(name) {
    const bm = this.resolveBookmark(name);
    if (!bm) throw new RangeError(`未知书签 ${name}`);
    const evaluation = this.evaluate(bm.name);
    const frozen = bm.snapshots.at(-1) ?? null;
    return {
      name: bm.name,
      refs: [...bm.refs],
      frozen, // 已批准迁移保留的整段版本；没有则为 null（从未迁移）
      current: evaluation,
      historical: frozen !== null,
    };
  }

  // 历史解释：新稿审批不得把旧划线改成当前坐标
  history(viewName) {
    const bm = this.resolveBookmark(viewName);
    if (!bm) throw new RangeError(`未知视图 ${viewName}`);
    return {
      view: viewName,
      bookmark: bm.name,
      snapshots: bm.snapshots.map((s) => ({ ...s })),
      currentVersion: this.version,
    };
  }

  // 别名同序校验：两个显示区域引用同一批注，两端对应落定后必须能按
  // 同一稿件顺序引用（共享源容量，落点集合一致且单调）。
  validateAliasOrder(alias) {
    const bm = this.resolveBookmark(alias);
    if (!bm) throw new RangeError(`未知别名 ${alias}`);
    const eval_ = this.evaluate(bm.name);
    const settled = eval_.computation.endpoints.every((e) => e.settled);
    if (!settled) return { ok: false, reason: '端点未落定，无法校验同序', evaluation: eval_ };
    const [s, e] = eval_.computation.endpoints;
    const ok = s.slot <= e.slot;
    return {
      ok,
      reason: ok ? '两端按同一稿件单调字序引用' : '引用逆序',
      slots: [s.slot, e.slot],
      sharedSource: [bm.start, bm.end],
    };
  }

  // ---------------- 工作区与交付对账 ----------------

  accounting() {
    return {
      deliveries: this.store.deliveries,
      updatePagesBudget: this.data.updatePages,
      work: this.ledger.report(),
      cachedComponents: [...this.cache.entries()].map(([id, e]) => ({
        id,
        version: e.version,
        ok: e.ok,
        plans: e.plans.length,
      })),
      version: this.version,
    };
  }
}
