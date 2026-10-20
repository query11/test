// 订阅额度：读数合并，以及“每 1% 折合多少美元”的估算
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, assistant, result, rateLimit, usageApi } = require('./harness');

const T0 = Date.parse('2026-10-20T00:00:00Z');
const RESET = T0 / 1000 + 5 * 3600;
const OPUS = 'claude-opus-5-5';

test('用量接口的新格式（只有 limits[] 行的 percent / resets_at）也能读到', () => {
  const h = load({ now: T0 });
  h.feed({ limits: [{ kind: 'session', group: 'session', percent: 37, resets_at: new Date(RESET * 1000).toISOString(), scope: {} }] });
  assert.equal(h.ctm.limits.five_hour.utilization, 0.37);
  assert.equal(h.ctm.limits.five_hour.src, 'official');
});

test('同一窗口里用量只增不减：读数回落时保留最大值；重置之后换成新窗口', () => {
  const h = load({ now: T0 });
  h.feed(rateLimit({ five_hour: [0.4, RESET] }));
  h.feed(rateLimit({ five_hour: [0.38, RESET] }));
  assert.equal(h.ctm.limits.five_hour.utilization, 0.4);
  h.feed(usageApi({ five_hour: [5, (RESET + 5 * 3600) * 1000] }));
  assert.equal(h.ctm.limits.five_hour.utilization, 0.05);
  assert.equal(h.ctm.limits.five_hour.resetsAt, RESET + 5 * 3600);
});

// 实时的一轮：一次请求、请求结束时带回的额度读数、这一轮的 result（累计花费）
function turns(h, n, { costPerTurn = 0.5, pct = (k) => 10 + Math.floor(k / 2), gapAt = -1, gapMin = 10, jump = 0 } = {}) {
  let cost = 0;
  let extra = 0;
  for (let k = 0; k < n; k++) {
    if (k === gapAt) {
      h.advance(gapMin * 60000); // 闲置：这期间别处用掉了 jump 个百分点
      extra += jump;
    }
    h.advance(20000);
    h.feed(assistant('msg_' + k, { input: 10, cacheRead: 50000 + k * 1000, cacheWrite: 1000, text: 'x'.repeat(400) }));
    h.feed(rateLimit({ five_hour: [(pct(k) + extra) / 100, RESET] }));
    cost += costPerTurn;
    h.feed(result({ [OPUS]: { input: 10 * (k + 1), output: 100 * (k + 1), cacheRead: 50000 * (k + 1), cost } }));
  }
}

test('每 1% 折合多少美元：相邻两次跳变之间的花费 ÷ 跳过的百分点数', () => {
  const h = load({ now: T0 });
  turns(h, 21); // 每轮 $0.5，每两轮涨 1%：每 1% 约 $1
  const [perPoint, points] = h.ctm.quota().session.five_hour;
  assert.ok(Math.abs(perPoint - 1) < 1e-6, 'perPoint ' + perPoint);
  assert.ok(points >= 8, 'points ' + points);
  assert.ok(Math.abs(h.ctm.quota().combined.five_hour.perPoint - 1) < 1e-6);
});

test('读数偶尔回落一格再回来，不算新跨过一格', () => {
  const h = load({ now: T0 });
  // 10 9 10 10 11 10 11 11 12 …：每轮 $0.25，四轮涨 1%，刚涨上去的下一轮回落一格、再下一轮回来。
  // 把“回来”也当成跨过一格的话，下一段只量到一半的花费，每 1% 会估成 $0.5
  turns(h, 41, { costPerTurn: 0.25, pct: (k) => 10 + Math.floor(k / 4) - (k % 4 === 1 ? 1 : 0) });
  const [perPoint] = h.ctm.quota().session.five_hour;
  assert.ok(Math.abs(perPoint - 1) < 1e-6, 'perPoint ' + perPoint);
});

test('闲置超过 5 分钟（期间可能在别处用），前后的读数不配对', () => {
  const h = load({ now: T0 });
  // 第 11 轮之前闲置 10 分钟，期间别处用掉了 4 个百分点；本会话这段几乎没花钱，不能算成“每 1% 很便宜”
  turns(h, 21, { gapAt: 11, jump: 4 });
  const [perPoint] = h.ctm.quota().session.five_hour;
  assert.ok(Math.abs(perPoint - 1) < 1e-6, 'perPoint ' + perPoint);
});

test('重开会话时历史只加载了一部分：不用依据更少的估算覆盖存下的', () => {
  const store = new Map();
  const h = load({ now: T0, storage: store });
  turns(h, 21);
  h.ctm.quota();
  const key = '/code/session_0123456789abcdefghij';
  const saved = JSON.parse(store.get('ctm-rates-v4'))[key].r;
  assert.ok(saved.five_hour[1] >= 8, 'points ' + saved.five_hour[1]);

  // 重开：历史只加载了最后 7 轮
  const h2 = load({ now: T0 + 3600e3, storage: store });
  const events = [];
  for (let k = 14; k < 21; k++) {
    const t = T0 + (k + 1) * 20000;
    events.push(assistant('msg_' + k, { input: 10, cacheRead: 50000 + k * 1000, cacheWrite: 1000, text: 'x'.repeat(400), timestamp: t - 1000 }));
    events.push(rateLimit({ five_hour: [(10 + Math.floor(k / 2)) / 100, RESET] }));
    events.push(result({ [OPUS]: { input: 10 * (k + 1), output: 100 * (k + 1), cacheRead: 50000 * (k + 1), cost: 0.5 * (k + 1) } }, { timestamp: t }));
  }
  h2.feed(events);
  const partial = h2.ctm.quota().session;
  assert.ok(partial.five_hour && partial.five_hour[1] < saved.five_hour[1], 'partial ' + JSON.stringify(partial));
  assert.deepEqual(JSON.parse(store.get('ctm-rates-v4'))[key].r, saved);
});
