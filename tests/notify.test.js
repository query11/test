// 浏览器通知：只在标签页在后台、打开了对应的一项、浏览器允许时发；同一件事只发一次
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, fakeNotification, assistant, result, rateLimit } = require('./harness');

const OPUS = 'claude-opus-5-5';
const MIN = 60000;
const T0 = Date.parse('2026-10-20T02:00:00Z');
const sec = (t) => Math.round(t / 1000);
const on = (...kinds) => ({ 'ctm-notify': JSON.stringify(Object.fromEntries(kinds.map((k) => [k, true]))) });

test('一轮结束：后台时发，带上这一轮的花费、用时和请求数；在前台、没打开、浏览器不允许时都不发', () => {
  const N = fakeNotification();
  const h = load({ now: T0, Notification: N, storage: on('turn') });
  h.feed(result({ [OPUS]: { output: 1000, cost: 1 } }));
  h.render();
  assert.equal(N.sent.length, 0, '在前台');
  h.setHidden(true);
  const turn = { input_tokens: 5, output_tokens: 800, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  h.feed(result({ [OPUS]: { output: 1800, cost: 1.42 } }, { wallMs: 130000, requests: 5, turn }));
  h.render();
  assert.equal(N.sent.length, 1);
  assert.equal(N.sent[0][0], 'Claude Code');
  assert.equal(N.sent[0][1].body, '这一轮结束了：$0.42 · 2 分 10 秒 · 5 次请求');
  // 出错、被打断的一轮
  h.feed({ type: 'result', subtype: 'error_during_execution', uuid: 'z1', total_cost_usd: 0, modelUsage: {} });
  h.render();
  assert.equal(N.sent[1][1].body, '这一轮出错或被打断了');

  const off = load({ now: T0, Notification: N, storage: on('quota') });
  off.setHidden(true);
  off.feed(result({ [OPUS]: { output: 1000, cost: 1 } }));
  off.render();
  const denied = fakeNotification('denied');
  const d = load({ now: T0, Notification: denied, storage: on('turn') });
  d.setHidden(true);
  d.feed(result({ [OPUS]: { output: 1000, cost: 1 } }));
  d.render();
  assert.equal(N.sent.length + denied.sent.length, 2);
});

test('同一个会话开在两个后台标签页里：一轮结束只提醒一次；会话标题用网页加载过的', () => {
  const N = fakeNotification();
  const store = new Map(Object.entries(on('turn')));
  const path = '/code/session_0123456789abcdefghij';
  const a = load({ now: T0, Notification: N, storage: store, path });
  const b = load({ now: T0, Notification: N, storage: store, path });
  for (const h of [a, b]) {
    h.setHidden(true);
    h.feed({ id: 'session_0123456789abcdefghij', title: '修登录页的 bug', external_metadata: {} });
  }
  const r = result({ [OPUS]: { output: 1000, cost: 1 } });
  a.feed(r);
  b.feed(r);
  a.render();
  b.render();
  assert.equal(N.sent.length, 1);
  assert.equal(N.sent[0][0], '修登录页的 bug');
});

test('额度窗口重置：后台定时器一分钟才跑一次、新窗口的读数已经到了，也能发现；用得少的窗口不提醒', () => {
  const N = fakeNotification();
  const h = load({ now: T0, Notification: N, storage: on('reset') });
  const reset = T0 + 10 * MIN;
  h.feed(rateLimit({ five_hour: [0.82, sec(reset)], seven_day: [0.3, sec(T0 + 3 * 864e5)] }));
  h.render();
  h.setHidden(true);
  h.advance(10 * MIN + 5000);
  // 重置几秒后就有了新窗口的读数，之后定时器才跑
  h.feed(rateLimit({ five_hour: [0.01, sec(reset + 5 * 3600e3)] }));
  h.advance(50000);
  h.render();
  assert.equal(N.sent.length, 1);
  assert.equal(N.sent[0][0], '5 小时额度已重置');
  assert.equal(N.sent[0][1].body, '之前用到 82%');
  h.wait(5000);
  assert.equal(N.sent.length, 1);
});

test('额度快用完：用到 95% 或者预计半小时内用完，每个窗口每次只提醒一次', () => {
  const N = fakeNotification();
  const h = load({ now: T0, Notification: N, storage: on('quota') });
  h.setHidden(true);
  h.feed(rateLimit({ five_hour: [0.5, sec(T0 + 3 * 3600e3)] })); // 按窗口开始以来的速度，约 2 小时后用完
  h.render();
  assert.equal(N.sent.length, 0);
  h.feed(rateLimit({ five_hour: [0.96, sec(T0 + 3 * 3600e3)] }));
  h.render();
  h.render();
  assert.equal(N.sent.length, 1);
  assert.equal(N.sent[0][0], '5 小时额度快用完了');
});

test('缓存快过期：大上下文、闲着、5 分钟内过期时提醒一次', () => {
  const N = fakeNotification();
  const h = load({ now: T0, Notification: N, storage: on('cache') });
  h.setHidden(true);
  h.feed(assistant('msg_1', { input: 5, cacheRead: 0, cacheWrite: 300000 }), result({ [OPUS]: { output: 1000, cost: 2 } }));
  h.advance(50 * MIN);
  h.render();
  assert.equal(N.sent.length, 0, '还有 10 分钟');
  h.advance(6 * MIN);
  h.render();
  h.render();
  assert.equal(N.sent.length, 1);
  assert.equal(N.sent[0][0], '提示缓存 4 分钟后过期');
  assert.match(N.sent[0][1].body, /^上下文 300k token，过期后下一条消息约多花 \$2\.\d\d$/);
});
