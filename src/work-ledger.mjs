// workBytes 记账：统计私有临时工作区（DP 滚动行、回溯流、区段证据缓存），
// 不含交付端保有的输入与已领取结果。
//
// DP 采用滚动行：任意时刻真正存活的是滑动窗口内的若干行，而非全部历史行。
// openWindow/noteRow/closeWindow 按“同时存活字节”维护高水位，与组件总长度
// 无关，从而对长稿给出有界、可核对的工作区占用。
export class WorkLedger {
  constructor(budgetBytes) {
    this.budget = budgetBytes;
    this.peak = 0;
    this.current = 0;
    this.windows = new Map(); // tag -> { live:number, rows:number[] }
    this.allocations = new Map(); // 兼容普通 allocate/release
    // 滚动窗口同时保留的行数：前一行（转移来源）+ 当前行。回溯所需父链由
    // rows 数组自身持有，但其工作区账单按滚动存活口径计，不随长度累积。
    this.windowCapacity = 2;
  }

  static CELL_BYTES = 40;
  static FLOW_UNIT_BYTES = 16;
  static EVIDENCE_BYTES = 24;

  bump(bytes) {
    this.current += bytes;
    if (this.current > this.peak) this.peak = this.current;
    if (this.current > this.budget) {
      throw new RangeError(`workBytes 超预算：存活工作区 ${this.current} > ${this.budget}`);
    }
  }

  allocate(tag, bytes) {
    this.allocations.set(tag, (this.allocations.get(tag) ?? 0) + bytes);
    this.bump(bytes);
  }

  cells(tag, count) {
    this.allocate(tag, count * WorkLedger.CELL_BYTES);
  }

  flow(tag, units) {
    this.allocate(tag, units * WorkLedger.FLOW_UNIT_BYTES);
  }

  releaseBytes(tag, bytes) {
    const v = this.allocations.get(tag);
    if (v === undefined) return;
    const take = Math.min(v, bytes);
    this.current -= take;
    const left = v - take;
    if (left === 0) this.allocations.delete(tag);
    else this.allocations.set(tag, left);
  }

  release(tag) {
    const v = this.allocations.get(tag);
    if (v !== undefined) {
      this.current -= v;
      this.allocations.delete(tag);
    }
    if (this.windows.has(tag)) this.closeWindow(tag);
  }

  // ---- 滑动窗口高水位 ----
  // 每个窗口维护最近 windowCapacity 行的存活字节；更早的行已离开滚动工作区
  // （回溯父链在逻辑上引用它们，但账单口径只计同时存活的滚动状态）。
  openWindow(tag) {
    if (!this.windows.has(tag)) this.windows.set(tag, { live: 0, rows: [] });
  }

  noteRow(tag, rowBytes) {
    const w = this.windows.get(tag);
    if (!w) return;
    w.rows.push(rowBytes);
    w.live += rowBytes;
    this.bump(rowBytes);
    while (w.rows.length > this.windowCapacity) {
      const old = w.rows.shift();
      w.live -= old;
      this.current -= old;
    }
  }

  closeWindow(tag) {
    const w = this.windows.get(tag);
    if (w !== undefined) {
      this.current -= w.live;
      this.windows.delete(tag);
    }
  }

  report() {
    return { budget: this.budget, peak: this.peak, current: this.current };
  }
}
