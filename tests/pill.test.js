// 一行摘要：额度用满、额外用量、短写法、菜单里关掉的项
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, assistant, result, rateLimit } = require('./harness');

const OPUS = 'claude-opus-5-5';
const MIN = 60000;
const T0 = new Date(2026, 9, 21, 10, 0).getTime(); // 本地时间 10/21 周三 10:00
const sec = (t) => Math.round(t / 1000);
const pill = (h) => h.ctm.pill();
const part = (h, key) => pill(h).filter((p) => p.key === key);
const extraApi = (used) => ({ five_hour: { utilization: 40, resets_at: new Date(T0 + 3 * 3600e3).toISOString() }, extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: used, currency: 'USD' } });

test('额度用满：显示多久后恢复（一天以上写星期），标红', () => {
  const h = load({ now: T0 });
  h.feed(rateLimit({ five_hour: [1, sec(T0 + 72 * MIN)], seven_day: [0.4, sec(T0 + 3 * 864e5)] }));
  const [five] = part(h, 'five');
  assert.equal(five.text, '5h 已满 · 1:12 后恢复');
  assert.equal(five.level, 'critical');
  h.feed(rateLimit({ five_hour: [1, sec(T0 + 72 * MIN)], seven_day: [1, sec(T0 + 3 * 864e5 + 4 * 3600e3 + 49 * MIN)] }));
  assert.equal(part(h, 'limits')[0].text, '7d 已满 · 周六 14:49 恢复');
  h.advance(30 * MIN);
  assert.equal(part(h, 'five')[0].text, '5h 已满 · 42 分钟后恢复');
});

test('服务端说窗口在拒绝请求时也算用满', () => {
  const h = load({ now: T0 });
  h.feed({ type: 'rate_limit_event', uuid: 'rl', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.97, resetsAt: sec(T0 + 2 * 3600e3), status: 'rejected' } } } });
  assert.match(part(h, 'five')[0].text, /^5h 已满 · 2:00 后恢复$/);
});

test('菜单里关掉的项不显示，但用满的额度照样显示', () => {
  const h = load({ now: T0, storage: { 'ctm-pill-hide': JSON.stringify(['five', 'cost']) } });
  h.feed(result({ [OPUS]: { output: 1000, cost: 1 } }));
  h.feed(rateLimit({ five_hour: [0.4, sec(T0 + 3 * 3600e3)] }));
  assert.deepEqual(part(h, 'five'), []);
  assert.deepEqual(part(h, 'cost'), []);
  h.feed(rateLimit({ five_hour: [1, sec(T0 + 3 * 3600e3)] }));
  assert.equal(part(h, 'five')[0].text, '5h 已满 · 3:00 后恢复');
});

test('正在用额外用量时显示已用金额并标黄：已用金额刚涨过、请求说在用、或者有额度用满了', () => {
  const h = load({ now: T0 });
  h.feed(extraApi(1000));
  assert.deepEqual(part(h, 'extra'), [], '这个月用过，但现在没在用');
  h.advance(5 * MIN);
  h.feed(extraApi(1230));
  const [x] = part(h, 'extra');
  assert.equal(x.text, '额外 $12.30');
  assert.equal(x.level, 'warning');
  h.advance(40 * MIN);
  assert.deepEqual(part(h, 'extra'), [], '半小时没再涨');
  h.feed({ type: 'rate_limit_event', uuid: 'rl2', rate_limit_info: { isUsingOverage: true, unifiedWindows: {} } });
  assert.equal(part(h, 'extra').length, 1);
  h.advance(15 * MIN);
  assert.equal(part(h, 'extra').length, 0);
  h.feed(rateLimit({ five_hour: [1, sec(T0 + 3 * 3600e3)] }));
  assert.equal(part(h, 'extra').length, 1, '5 小时额度用满了，请求走额外用量');
});

test('上下文写成 428k/1M', () => {
  const h = load({ now: T0 });
  h.feed(result({ [OPUS]: { output: 1000, cost: 1 } }));
  h.feed(assistant('msg_1', { input: 5, cacheRead: 428095 }));
  assert.equal(part(h, 'context')[0].text, '428k/1M');
  h.feed(assistant('msg_2', { input: 5, cacheRead: 999695 }));
  assert.equal(part(h, 'context')[0].text, '1M/1M');
});
