// 按 inputs/layout-pages.json 的 events 记录重放整卷联调流程。
//
// 事件语义：
//   [open, view]              打开长稿（建立引擎与视图名）
//   [book, name, start, end]  登记跨行批注书签
//   [alias, alias, target]    第二个显示区域引用同一批注（共享源容量）
//   [read, name]              回读：报告计算/出版双状态，已批准则给冻结快照
//   [narrow, num, den]        共享字宽收窄为有理点
//   [bridge, blocked, sec]    某 section 失去连续出版许可（桥边保留在图中）
//   [anchor, w, slot, min]    新增固定锚；冲突报告实际区段范围与涉及锚
//   [history, view, target]   历史解释：旧划线保持审批时坐标

import { LayoutEngine } from './engine.mjs';

export function replay(layoutPage, data) {
  const engine = new LayoutEngine({ layoutPage, data });
  const trace = [];
  const views = new Map();
  let opened = null;

  for (const ev of data.events) {
    const [kind, ...args] = ev;
    switch (kind) {
      case 'open': {
        opened = args[0];
        engine.registerOpenView(opened);
        views.set(opened, null);
        trace.push({ event: ev, result: { kind: 'open', view: opened } });
        break;
      }
      case 'book': {
        const [name, start, end] = args;
        engine.addBookmark(name, start, end);
        trace.push({ event: ev, result: { kind: 'book', name, start, end } });
        break;
      }
      case 'alias': {
        const [alias, target] = args;
        engine.addAlias(alias, target);
        views.set(alias, target);
        trace.push({ event: ev, result: { kind: 'alias', alias, target } });
        break;
      }
      case 'read': {
        const [name] = args;
        const result = engine.read(name);
        trace.push({ event: ev, result: summarizeRead(result) });
        break;
      }
      case 'narrow': {
        const [num, den] = args;
        const result = engine.narrow(num, den);
        trace.push({ event: ev, result });
        break;
      }
      case 'bridge': {
        const [mode, section] = args;
        if (mode !== 'blocked') throw new RangeError(`未知 bridge 模式 ${mode}`);
        const result = engine.blockSection(section);
        trace.push({ event: ev, result });
        break;
      }
      case 'anchor': {
        const [w, slot, min] = args;
        const result = engine.addAnchor(w, slot, min);
        trace.push({ event: ev, result });
        break;
      }
      case 'history': {
        const [view, target] = args;
        const result = engine.history(view);
        trace.push({
          event: ev,
          result: {
            kind: 'history',
            view,
            target,
            snapshotCount: result.snapshots.length,
            versions: result.snapshots.map((s) => s.version),
          },
        });
        break;
      }
      default:
        throw new RangeError(`未知事件 ${kind}`);
    }
  }

  return { engine, trace, accounting: engine.accounting() };
}

function summarizeRead(r) {
  const c = r.current;
  return {
    name: r.name,
    refs: r.refs,
    historical: r.historical,
    frozenVersion: r.frozen?.version ?? null,
    computation: c.computation.status,
    publication: c.publication.status,
    migratable: c.migratable,
    endpoints: c.computation.endpoints.map((e) => ({
      word: e.word,
      settled: e.settled,
      slot: e.slot ?? null,
      alternatives: e.alternatives,
    })),
    blockers: c.publication.blockers,
  };
}
