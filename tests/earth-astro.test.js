// 地球天象仪的天文计算：和《天文算法》的算例、已公布的日月食对照
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../earth/astro.js');

const near = (actual, expected, tol, what) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual} 与 ${expected} 相差超过 ${tol}`);
const minutes = (ms) => ms / 60000;

test('月球位置与 Meeus 例 47.a 一致（1992-04-12 0h TD）', () => {
  const m = A.moon(2448724.5 - A.DELTA_T_S / 86400);
  near(m.lambda, 133.162655, 1e-5, '黄经');
  near(m.beta, -3.229126, 1e-5, '黄纬');
  near(m.distKm, 368409.7, 0.1, '距离');
});

test('太阳位置与 Meeus 例 25.a 一致（1992-10-13 0h TD）', () => {
  const s = A.sun(2448908.5 - A.DELTA_T_S / 86400);
  near(s.lambda, 199.90895, 1e-4, '视黄经');
  near(s.dec, -7.78507, 1e-4, '赤纬');
  near(s.distAU, 0.99766, 1e-5, '日地距离');
});

test('恒星时与地球自转角', () => {
  near(A.gmstDeg(2446895.5), 197.693195, 1e-5, 'Meeus 例 12.a 的 GMST');
  near(A.earthRotationAngle(A.J2000) * A.RAD, 280.4606184, 1e-6, 'J2000.0 的 ERA');
  // 一个恒星日之后，地球自转角回到原值
  const era0 = A.earthRotationAngle(2460000.5);
  const era1 = A.earthRotationAngle(2460000.5 + A.SIDEREAL_DAY_S / 86400);
  near(A.wrap180((era1 - era0) * A.RAD), 0, 1e-4, '恒星日');
});

test('2026 年的分至时刻在公布值的 15 分钟以内', () => {
  const cases = [
    [0, '2026-03-20T14:46Z'],
    [90, '2026-06-21T08:24Z'],
    [180, '2026-09-23T00:05Z'],
    [270, '2026-12-21T20:50Z'],
  ];
  for (const [lon, iso] of cases) {
    near(minutes(A.nextSunLongitude(Date.UTC(2026, 0, 1), lon)), minutes(Date.parse(iso)), 15, `黄经 ${lon}°`);
  }
});

test('节气：2026-11-05 处在霜降，下一个是立冬（11 月 7 日）', () => {
  const t = A.solarTerm(Date.UTC(2026, 10, 5, 12));
  assert.equal(t.name, '霜降');
  assert.equal(t.next, '立冬');
  assert.equal(new Date(t.nextMs).toISOString().slice(0, 10), '2026-11-07');
});

test('2026-08-12 日全食：时刻、地点与 NASA 公布的食甚一致', () => {
  const e = A.nextEclipse(Date.UTC(2026, 6, 1), 'solar');
  assert.equal(e.type, '日全食');
  near(minutes(e.ms), minutes(Date.parse('2026-08-12T17:45:00Z')), 3, '食甚');
  near(e.where.lat, 65.2, 1, '纬度');
  near(e.where.lon, -25.2, 1, '经度');
});

test('2027-08-02 日全食的食甚在埃及卢克索附近', () => {
  const e = A.nextEclipse(Date.UTC(2027, 6, 1), 'solar');
  assert.equal(e.type, '日全食');
  near(minutes(e.ms), minutes(Date.parse('2027-08-02T10:06:40Z')), 3, '食甚');
  near(e.where.lat, 25.5, 1, '纬度');
  near(e.where.lon, 33.2, 1, '经度');
});

test('2026-02-17 南极日环食', () => {
  const e = A.nextEclipse(Date.UTC(2026, 0, 1), 'solar');
  assert.equal(e.type, '日环食');
  assert.equal(new Date(e.ms).toISOString().slice(0, 10), '2026-02-17');
});

test('2026 年的两次月食：3 月 3 日月全食，8 月 28 日月偏食（食分约 0.93）', () => {
  const a = A.nextEclipse(Date.UTC(2026, 0, 1), 'lunar');
  assert.equal(a.type, '月全食');
  near(minutes(a.ms), minutes(Date.parse('2026-03-03T11:33:00Z')), 5, '3 月食甚');
  const b = A.nextEclipse(a.ms + A.DAY_MS * 5, 'lunar');
  assert.equal(b.type, '月偏食');
  near(minutes(b.ms), minutes(Date.parse('2026-08-28T04:12:00Z')), 5, '8 月食甚');
  near(b.magnitude, 0.93, 0.02, '本影食分');
});

test('月相名称按日月黄经差划分', () => {
  assert.equal(A.phaseName(0), '新月');
  assert.equal(A.phaseName(90), '上弦月');
  assert.equal(A.phaseName(180), '满月');
  assert.equal(A.phaseName(270), '下弦月');
  assert.equal(A.phaseName(317), '残月');
});
