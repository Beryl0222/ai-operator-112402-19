import assert from 'node:assert/strict';
import test from 'node:test';
import { Fraction, lineIntersection } from '../src/fraction.mjs';

test('Fraction 精确约分与比较', () => {
  const a = Fraction.from(6, 4); // 3/2
  assert.equal(a.toString(), '3/2');
  assert.equal(a.num, 3n);
  assert.equal(a.den, 2n);
  assert.ok(Fraction.from(3, 2).equals(a));
  assert.ok(Fraction.from(-4, 1).lt(a));
  assert.ok(Fraction.from(5, 1).gt(a));
  // 负分母归一
  const b = new Fraction(1n, -2n);
  assert.equal(b.toString(), '-1/2');
  assert.throws(() => new Fraction(1n, 0n), /分母为零/);
});

test('Fraction 闭区间包含与收窄边界', () => {
  const lo = Fraction.int(-4);
  const hi = Fraction.int(5);
  assert.ok(Fraction.contains([lo, hi], Fraction.from(3, 2)));
  assert.ok(Fraction.contains([lo, hi], lo));
  assert.ok(Fraction.contains([lo, hi], hi));
  assert.equal(Fraction.contains([lo, hi], Fraction.int(6)), false);
});

test('lineIntersection 精确求交与区间过滤', () => {
  const lo = Fraction.int(-4);
  const hi = Fraction.int(5);
  // 0+3t 与 3+0t 交于 t=1
  const p = lineIntersection(0n, 3n, 3n, 0n, lo, hi);
  assert.ok(p && p.equals(Fraction.int(1)));
  // 平行线
  assert.equal(lineIntersection(1n, 2n, 5n, 2n, lo, hi), null);
  // 交点落在区间外
  const out = lineIntersection(0n, 1n, 100n, 0n, lo, hi);
  assert.equal(out, null);
});
