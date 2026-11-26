import assert from 'node:assert/strict';
import test from 'node:test';
import data from '../inputs/layout-pages.json' with { type: 'json' };
import { layoutPage } from '../inputs/layout-pages.mjs';
import { LayoutEngine } from '../src/engine.mjs';
import { Fraction } from '../src/fraction.mjs';
import { replay } from '../src/replay.mjs';
import { validateFlow } from '../src/validate.mjs';
import { buildComponents, buildModel, PageStore } from '../src/model.mjs';

function newEngine() {
  return new LayoutEngine({ layoutPage, data });
}

test('组件切分：无桥 section 独立，桥 12-13-14 构成一个三区段组件', () => {
  const comps = buildComponents(data);
  const sizes = comps.map((c) => c.sections.length).sort((a, b) => b - a);
  assert.equal(sizes[0], 3);
  assert.ok(sizes.slice(1).every((s) => s === 1));
  const big = comps.find((c) => c.sections.length === 3);
  assert.deepEqual(big.sections, [12, 13, 14]);
});

test('取页计数：每次交付都计数，重复同一页也计', () => {
  const store = new PageStore(layoutPage, data);
  store.deliver(0);
  store.deliver(0);
  store.ensurePage(0); // 命中缓存不计数
  assert.equal(store.deliveries, 2);
});

test('计算不确定与出版阻塞是两个独立状态', () => {
  const eng = newEngine();
  eng.registerOpenView('winter');
  eng.addBookmark('later', data.marker[0], data.marker[1]);
  const before = eng.evaluate('later');
  assert.equal(before.computation.status, 'uncertain');
  assert.equal(before.publication.status, 'publishable');
  assert.equal(before.migratable, false);

  eng.blockSection(13);
  const after = eng.evaluate('later');
  assert.equal(after.computation.status, 'uncertain'); // 计算侧不变
  assert.equal(after.publication.status, 'blocked'); // 出版侧独立阻塞
  assert.ok(after.publication.blockers.some((b) => b.type === 'section'));
});

test('新增锚与既有锚争同一字格：报告实际冲突区段与涉及锚，不静默跳过', () => {
  const eng = newEngine();
  eng.narrow(3, 2);
  const [w, sl, m] = data.proposedLock;
  const res = eng.addAnchor(w, sl, m);
  assert.equal(res.accepted, false);
  assert.match(res.conflict.kind, /anchor-.*conflict/);
  assert.deepEqual(res.conflict.sections, [12, 12]);
  const flat = res.conflict.anchors.map((a) => a.join(','));
  assert.ok(flat.includes(data.locks[0].join(',')));
  assert.ok(flat.includes(data.proposedLock.join(',')));
  // 冲突组件标记为不可用，而非假装交付
  const comp = eng.componentOf(w);
  const entry = eng.cache.get(comp.id);
  assert.equal(entry.ok, false);
});

test('字宽收窄越界抛错；合法点收窄后区间变为点', () => {
  const eng = newEngine();
  assert.throws(() => eng.narrow(99, 1), /落在当前区间/);
  eng.narrow(3, 2);
  assert.ok(eng.point.equals(Fraction.from(3, 2)));
  assert.equal(eng.range[0].toString(), '3/2');
  assert.equal(eng.range[1].toString(), '3/2');
});

test('已批准迁移的回读冻结整段版本，后续改稿不改写旧划线', () => {
  const eng = newEngine();
  eng.registerOpenView('winter');
  eng.addBookmark('later', data.marker[0], data.marker[1]);
  eng.narrow(3, 2);
  // 单 section 内、收窄后两端落定且无出版阻塞的书签
  const eng2 = newEngine();
  eng2.narrow(3, 2);
  eng2.addBookmark('clean', 100, 101);
  const ev = eng2.evaluate('clean');
  assert.equal(ev.computation.status, 'settled');
  assert.equal(ev.publication.status, 'publishable');
  assert.equal(ev.migratable, true);

  const r0 = eng2.read('clean');
  assert.equal(r0.historical, false);
  assert.equal(r0.frozen, null);

  const appr = eng2.approve('clean');
  assert.equal(appr.approved, true);
  const frozenVersion = appr.snapshot.version;
  assert.deepEqual(
    appr.snapshot.endpoints.map((e) => e.slot),
    ev.computation.endpoints.map((e) => e.slot),
  );

  // 后续加锚产生新版本；旧划线坐标必须保持冻结
  eng2.addAnchor(50, 50, 1);
  assert.notEqual(eng2.version, frozenVersion);
  const r1 = eng2.read('clean');
  assert.equal(r1.historical, true);
  assert.equal(r1.frozen.version, frozenVersion);
  assert.deepEqual(r1.frozen.endpoints, appr.snapshot.endpoints);

  const h = eng2.history('clean');
  assert.equal(h.snapshots.length, 1);
  assert.equal(h.snapshots[0].version, frozenVersion);
  // 再次批准只追加新版本，不改写旧快照
  eng2.approve('clean');
  const h2 = eng2.history('clean');
  assert.equal(h2.snapshots.length, 2);
  assert.equal(h2.snapshots[0].version, frozenVersion);
});

test('未满足迁移条件时 approve 拒绝并区分原因', () => {
  const eng = newEngine();
  eng.registerOpenView('winter');
  eng.addBookmark('later', data.marker[0], data.marker[1]);
  // 未收窄：计算不确定
  const r1 = eng.approve('later');
  assert.equal(r1.approved, false);
  assert.equal(r1.reason, 'uncertain');

  // 出版阻塞分支：取一个收窄后两端都落定、但位于阻塞 section 13 的书签
  const eng2 = newEngine();
  eng2.narrow(3, 2);
  eng2.addBookmark('blocked', 3335, 3336);
  const before = eng2.evaluate('blocked');
  assert.equal(before.computation.status, 'settled');
  eng2.blockSection(13);
  const r2 = eng2.approve('blocked');
  assert.equal(r2.approved, false);
  assert.equal(r2.reason, 'blocked');
});

test('别名引用同一批注：共享 refs，端点落定后校验同一稿件顺序', () => {
  const eng = newEngine();
  eng.registerOpenView('winter');
  eng.addBookmark('later', data.marker[0], data.marker[1]);
  eng.addAlias('mini', 'later');
  const bm = eng.resolveBookmark('mini');
  assert.equal(bm.name, 'later');
  assert.ok(bm.refs.has('mini'));
  assert.ok(bm.refs.has('winter'));
  // 未落定时同序校验返回不确定而非伪造通过
  const order = eng.validateAliasOrder('mini');
  assert.equal(order.ok, false);
  assert.match(order.reason, /未落定/);
});

test('出版阻塞不删除成本图中的桥：阻塞后桥边仍可参与求解', () => {
  const eng = newEngine();
  eng.narrow(3, 2);
  eng.blockSection(13);
  const comp = eng.componentOf(data.marker[0]);
  const entry = eng.solveComponent(comp);
  // 组件仍可求解（桥在图中），只是出版侧阻塞
  assert.equal(entry.ok, true);
  const model = entry.model;
  const hasBridge = data.bridges.some(([i, j]) => model.edgeMap.get(i)?.has(j));
  assert.ok(hasBridge);
});

test('增量：改一处锚点只失效对应组件，其它组件缓存保留', () => {
  const eng = newEngine();
  eng.narrow(3, 2);
  // 求解两个不相邻组件
  const c0 = eng.components[0];
  const c1 = eng.components[1];
  eng.solveComponent(c0);
  eng.solveComponent(c1);
  const v0 = eng.cache.get(c0.id).version;
  // 在组件 0 的词上加锚
  const word = c0.sections[0] * data.rows * data.sectionPages;
  eng.addAnchor(word, word, 1);
  assert.equal(eng.cache.has(c1.id), true); // 远处组件缓存保留
  assert.equal(eng.cache.get(c1.id).version, v0);
});

test('长稿求解流独立校验：守恒、容量、非交叉、边合法全部满足', () => {
  const store = new PageStore(layoutPage, data);
  const big = buildComponents(data).find((c) => c.sections.length === 3);
  const model = buildModel(store, big, data.locks);
  const eng = newEngine();
  const entry = eng.solveComponent(big);
  assert.equal(entry.ok, true);
  for (const plan of entry.plans) {
    const v = validateFlow(model, plan.flow, eng.point ?? Fraction.int(0));
    assert.ok(v.valid, v.errors.join(';'));
  }
});

test('事件重放：交付不超额度、工作区不超预算，且双状态可追踪', () => {
  const { trace, accounting } = replay(layoutPage, data);
  assert.equal(accounting.deliveries, data.updatePages);
  assert.ok(accounting.work.peak <= data.workBytes);
  const reads = trace.filter((t) => t.event[0] === 'read');
  assert.ok(reads.length >= 2);
  // 第一次 read 出版可发，第二次因 section 13 阻塞
  assert.equal(reads[0].result.publication, 'publishable');
  assert.equal(reads.at(-1).result.publication, 'blocked');
  // 锚事件被拒绝并带冲突
  const anchorEv = trace.find((t) => t.event[0] === 'anchor');
  assert.equal(anchorEv.result.accepted, false);
  // 历史事件无已批准快照（流程中书签始终未达可迁移）
  const hist = trace.find((t) => t.event[0] === 'history');
  assert.equal(hist.result.snapshotCount, 0);
});
