// 额度预测：按最近的消耗速度，什么时候用完
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, rateLimit } = require('./harness');

const T0 = Date.parse('2026-10-20T00:00:00Z'); // 5 小时窗口开始
const RESET = T0 / 1000 + 5 * 3600; // 窗口重置时间（unix 秒）
const MIN = 60000;

// 每隔 everyMin 分钟一个读数（开着额度刷新时每 3 分钟一个），最后一个读数在“现在”
function readings(h, pcts, everyMin = 3) {
  pcts.forEach((p, i) => {
    if (i) h.advance(everyMin * MIN);
    h.feed(rateLimit({ five_hour: [p / 100, RESET] }));
  });
}

test('闲置之后猛用：按最近 30 分钟的速度预测，不被闲置的那段摊薄', () => {
  // 40% 停了近两小时（相同的读数只存头尾两点），最近 10 分钟涨到 50%，距重置约 3 小时。
  // 1.5.0 从平台期的开头算起：“按最近 1 小时 58 分钟的速度…重置时约用到 65%”，不提醒
  const h = load({ now: T0 + 5 * MIN });
  readings(h, Array(36).fill(40));
  h.advance(3 * MIN);
  readings(h, [43, 46, 48, 50]);
  const f = h.ctm.forecast().five_hour;
  assert.match(f.tip, /按最近 30 分钟的速度（每小时约 \+20\.0%）/);
  assert.equal(f.text, '约 2.5 小时后用完 · 早于重置 28 分钟');
  assert.equal(f.level, 'warning');
});

test('一直在稳定地用：按最近 30 分钟的速度', () => {
  const h = load({ now: T0 + 5 * MIN });
  readings(h, Array.from({ length: 21 }, (_, i) => 10 + i)); // 每 3 分钟 +1%，每小时 +20%
  const f = h.ctm.forecast().five_hour;
  assert.match(f.tip, /按最近 30 分钟的速度（每小时约 \+20\.0%）/);
  assert.equal(f.text, '约 3.5 小时后用完 · 早于重置 25 分钟');
});

test('闲置了很久、一直没涨：显示最近没有消耗', () => {
  const h = load({ now: T0 + 5 * MIN });
  readings(h, Array(40).fill(40));
  assert.equal(h.ctm.forecast().five_hour.text, '最近没有消耗');
});

test('周额度按本周开始以来的平均速度，含不用的时候', () => {
  const h = load({ now: T0 });
  // 7 天窗口还有 4 天重置，已经过了 3 天，用了 30%：每天 10%，到重置时约 70%
  h.feed(rateLimit({ seven_day: [0.3, T0 / 1000 + 4 * 86400] }));
  const f = h.ctm.forecast().seven_day;
  assert.equal(f.text, '重置时约用到 70%');
  assert.match(f.tip, /本周开始以来的平均速度/);
});
