// 主动查用量接口：额度窗口重置后马上查一次
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, rateLimit, usageApi } = require('./harness');

const T0 = Date.parse('2026-10-20T00:00:00Z');
const RESET = T0 / 1000 + 3600; // 一小时后重置
const ORG = '01234567-89ab-cdef-0123-456789abcdef';
const cookie = 'lastActiveOrg=' + ORG;

// 用量接口的替身：每次返回 reply(第几次)；calls 记下请求的地址
function fakeFetch(reply) {
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    const body = reply(calls.length);
    if (body instanceof Error) throw body;
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body };
  };
  f.calls = calls;
  return f;
}
const flush = () => new Promise(setImmediate); // pollUsage 是 async 的，等它把结果记下

test('窗口重置几秒后查一次用量接口，换上新窗口的读数', async () => {
  const fetch = fakeFetch(() => usageApi({ five_hour: [3, (RESET + 5 * 3600) * 1000] }));
  const h = load({ now: T0, fetch, cookie });
  h.feed(rateLimit({ five_hour: [0.6, RESET] }));
  h.advance(3600e3 - 1000);
  h.render(); // 还没到重置时间
  h.advance(3000);
  h.render(); // 刚过重置，留几秒给服务端
  assert.equal(fetch.calls.length, 0);
  h.advance(5000);
  h.render();
  assert.deepEqual(fetch.calls, ['/api/organizations/' + ORG + '/usage']);
  await flush();
  assert.equal(h.ctm.limits.five_hour.utilization, 0.03);
  assert.equal(h.ctm.limits.five_hour.resetsAt, RESET + 5 * 3600);
  h.wait(120000);
  assert.equal(fetch.calls.length, 1);
});

test('重置之后已经有新读数（比如别的标签页刚查过）就不再查', () => {
  const fetch = fakeFetch(() => ({}));
  // 服务端还没切到新窗口：读数时间在重置之后，但重置时间还是旧的
  const storage = { 'ctm-limits': JSON.stringify({ five_hour: { utilization: 0.6, resetsAt: RESET, at: RESET * 1000 + 10000, src: 'official' } }) };
  const h = load({ now: RESET * 1000 + 20000, fetch, cookie, storage });
  h.wait(120000);
  assert.equal(fetch.calls.length, 0);
});

test('返回的数据里没有这个窗口：每次重置只查一次，不会每分钟查个不停', async () => {
  const fetch = fakeFetch(() => usageApi({ seven_day: [40, (RESET + 3 * 86400) * 1000] }));
  const h = load({ now: T0, fetch, cookie });
  h.feed(rateLimit({ five_hour: [0.6, RESET], seven_day: [0.3, RESET + 3 * 86400] }));
  h.advance(3600e3 + 10000);
  h.render();
  await flush();
  h.wait(5 * 60000);
  await flush();
  assert.equal(fetch.calls.length, 1);
  assert.equal(h.ctm.limits.seven_day.utilization, 0.4);
});

test('请求失败也只试一次；额度刷新关掉时不查', async () => {
  const fetch = fakeFetch(() => new Error('offline'));
  const h = load({ now: T0, fetch, cookie });
  h.feed(rateLimit({ five_hour: [0.6, RESET] }));
  h.advance(3600e3 + 10000);
  h.render();
  await flush();
  h.wait(3 * 60000);
  await flush();
  assert.equal(fetch.calls.length, 1);
  assert.equal(h.ctm.diagnostics().poll.fails, 1);

  const off = fakeFetch(() => ({}));
  const h2 = load({ now: T0, fetch: off, cookie, storage: { 'ctm-poll': '0' } });
  h2.feed(rateLimit({ five_hour: [0.6, RESET] }));
  h2.advance(3600e3 + 10000);
  h2.wait(60000);
  assert.equal(off.calls.length, 0);
});
