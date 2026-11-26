// 从联调页描述构建单调输运组件模型。
//
// 页面是候选全集描述：只有显式取过的页才进入工作区，补页不会引入描述外的边。
// 每条边只在自己的 section 可用，跨 section 仅以 bridges 为准。据此把全卷切成
// 连通组件（无桥的 section 各自独立），增量更新只重算受影响组件，不重扫长稿。

export class PageStore {
  constructor(layoutPage, data) {
    this.layoutPage = layoutPage;
    this.data = data;
    this.deliveries = 0; // updatePages 按交付次数计，重复同一页也计
    this.pages = new Map();
    this.sectionSpan = data.rows * data.sectionPages;
  }

  // 交付一页；每次调用都计数（含重复交付）
  deliver(page) {
    this.deliveries += 1;
    const pg = this.layoutPage(page);
    this.pages.set(page, pg);
    return pg;
  }

  ensurePage(page) {
    const cached = this.pages.get(page);
    if (cached) return cached;
    return this.deliver(page);
  }

  sectionOfOrdinal(ordinal) {
    return Math.floor(ordinal / this.sectionSpan);
  }

  // 组件涉及哪些页
  pagesOfComponent(comp) {
    const pages = new Set();
    for (const sec of comp.sections) {
      const firstPage = sec * this.data.sectionPages;
      for (let p = firstPage; p < firstPage + this.data.sectionPages; p++) pages.add(p);
    }
    return [...pages].sort((a, b) => a - b);
  }
}

// 依据 bridges 构建 section 连通组件（只依赖标定元数据，不触发取页）
export function buildComponents(data) {
  const sectionCount = data.pages / data.sectionPages;
  const dsu = Array.from({ length: sectionCount }, (_, i) => i);
  const find = (x) => {
    while (dsu[x] !== x) {
      dsu[x] = dsu[dsu[x]];
      x = dsu[x];
    }
    return x;
  };
  const span = data.rows * data.sectionPages;
  const bridgeEdges = [];
  for (const [i, j, a, b] of data.bridges) {
    const s1 = Math.floor(i / span);
    const s2 = Math.floor(j / span);
    if (s1 !== s2) {
      const r1 = find(s1);
      const r2 = find(s2);
      if (r1 !== r2) dsu[r2] = r1;
    }
    bridgeEdges.push({ word: i, slot: j, a, b, bridge: true, sections: [s1, s2] });
  }
  const groups = new Map();
  for (let s = 0; s < sectionCount; s++) {
    const r = find(s);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(s);
  }
  return [...groups.values()]
    .map((sections) => sections.sort((a, b) => a - b))
    .map((sections, idx) => ({ id: idx, sections, sectionSet: new Set(sections) }))
    .sort((x, y) => x.sections[0] - y.sections[0])
    .map((c, idx) => ({ ...c, id: idx }));
}

/**
 * 为一个组件构建单元化模型。会确保组件所需页面已交付。
 * @param {Array} anchors 全局锚 [word,slot,min]，仅纳入落在本组件内的
 */
export function buildModel(store, comp, anchors = []) {
  const pages = store.pagesOfComponent(comp);
  for (const p of pages) store.ensurePage(p);

  const units = []; // {word, section}
  const slots = []; // {slot, section}
  const skip = new Map(); // word -> skip
  const words = new Set();
  const slotSet = new Set();

  for (const p of pages) {
    const pg = store.pages.get(p);
    for (const s of pg.sources) {
      words.add(s.ordinal);
      skip.set(s.ordinal, s.skip);
      for (let k = 0; k < s.q; k++) units.push({ word: s.ordinal, section: s.section });
    }
    for (const t of pg.targets) {
      slotSet.add(t.ordinal);
      for (let k = 0; k < t.cap; k++) slots.push({ slot: t.ordinal, section: t.section });
    }
  }
  units.sort((x, y) => x.word - y.word);
  slots.sort((x, y) => x.slot - y.slot);

  // 边：同 section 的候选边 + 属于本组件的 bridge 边
  const edgeMap = new Map();
  const addEdge = (i, j, a, b, extra = {}) => {
    let row = edgeMap.get(i);
    if (!row) edgeMap.set(i, (row = new Map()));
    // 同一条 (i,j) 若重复登记，保留常数更小者，保持全集描述确定性
    const prev = row.get(j);
    if (!prev || a < prev.a) row.set(j, { a, b, ...extra });
  };
  for (const p of pages) {
    const pg = store.pages.get(p);
    for (const [i, j, a, b] of pg.edges) {
      const inComp =
        comp.sectionSet.has(store.sectionOfOrdinal(i)) &&
        comp.sectionSet.has(store.sectionOfOrdinal(j));
      if (inComp) addEdge(i, j, a, b);
    }
  }
  for (const br of store.data.bridges) {
    const s1 = store.sectionOfOrdinal(br[0]);
    const s2 = store.sectionOfOrdinal(br[1]);
    if (comp.sectionSet.has(s1) && comp.sectionSet.has(s2)) {
      addEdge(br[0], br[1], br[2], br[3], { bridge: true });
    }
  }

  const localAnchors = anchors
    .filter(([w, sl]) => words.has(w) && slotSet.has(sl))
    .map(([word, slot, min]) => ({ word, slot, min }));

  return {
    id: `c${comp.id}`,
    comp,
    units,
    slots,
    edgeMap,
    anchors: localAnchors,
    skipCost: (w) => skip.get(w) ?? 0,
    sectionsOf: (w, sl) => {
      const sw = store.sectionOfOrdinal(w);
      const ss = store.sectionOfOrdinal(sl);
      return comp.sectionSet.has(sw) ? sw : ss;
    },
    words,
    slotSet,
    pages,
  };
}
