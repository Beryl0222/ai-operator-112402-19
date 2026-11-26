// 精确有理数：字宽参数 t 与有理断点全部用 BigInt 分数表示，杜绝浮点符号误差。

function gcd(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a;
}

export class Fraction {
  constructor(num, den = 1n) {
    if (typeof num === 'number') num = BigInt(num);
    if (typeof den === 'number') den = BigInt(den);
    if (den === 0n) throw new RangeError('分母为零');
    if (den < 0n) {
      num = -num;
      den = -den;
    }
    const g = gcd(num, den);
    this.num = num / g;
    this.den = den / g;
  }

  static from(n, d) {
    return new Fraction(BigInt(n), BigInt(d));
  }

  static point(n, d) {
    return new Fraction(BigInt(n), BigInt(d));
  }

  // 整卷共享闭区间的端点也允许是整数
  static int(n) {
    return new Fraction(BigInt(n), 1n);
  }

  equals(o) {
    return this.num === o.num && this.den === o.den;
  }

  cmp(o) {
    const l = this.num * o.den;
    const r = o.num * this.den;
    return l === r ? 0 : l < r ? -1 : 1;
  }

  lt(o) {
    return this.cmp(o) < 0;
  }
  lte(o) {
    return this.cmp(o) <= 0;
  }
  gt(o) {
    return this.cmp(o) > 0;
  }
  gte(o) {
    return this.cmp(o) >= 0;
  }

  // 收窄：点 p 必须落在当前闭区间内
  static contains([lo, hi], p) {
    return p.gte(lo) && p.lte(hi);
  }

  toString() {
    return this.den === 1n ? `${this.num}` : `${this.num}/${this.den}`;
  }

  toJSON() {
    return this.toString();
  }
}

export const NEG_INF = null; // DP 不可达状态以 null 表示

// 两条线性成本 c1=a1+b1*t、c2=a2+b2*t 的交点；平行或交点不在 [lo,hi] 内时返回 null。
export function lineIntersection(a1, b1, a2, b2, lo, hi) {
  if (b1 === b2) return null;
  // t = (a2-a1)/(b1-b2)
  const p = new Fraction(a2 - a1, b1 - b2);
  if (p.lt(lo) || p.gt(hi)) return null;
  return p;
}
