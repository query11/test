// 用量汇总：往前翻、和上一期同期比、月底预计、命中率，按会话汇总，缓存重建记进账本
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, assistant, result } = require('./harness');

const OPUS = 'claude-opus-5-5';
const LEDGER = 'ctm-ledger-v2';
const MIN = 60000;
const P = '/code/session_0123456789abcdefghij';
const local = (m, d, h = 12) => new Date(2026, m - 1, d, h).getTime();
const key = (m, d) => '2026-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, (msg || '') + ' ' + a + ' ≠ ' + b);
const history = (...events) => events.flatMap((e) => [{ type: 'user', uuid: 'u-' + Math.random(), message: { role: 'user', content: 'hi' } }, e]);
const at = (o, t) => ({ ...o, timestamp: new Date(t).toISOString() });

// 8/1 起每天 $1（一轮），10/12 起每天 $2；10/21 是周三
function seeded(now) {
  const days = {};
  for (let t = local(8, 1); t <= local(10, 21); t += 864e5) {
    const d = new Date(t);
    const k = key(d.getMonth() + 1, d.getDate());
    const c = k >= key(10, 12) ? 2 : 1;
    days[k] = { [OPUS]: [10, 100, 900, 0, c, 1] };
  }
  return load({ now, storage: { [LEDGER]: JSON.stringify({ v: 2, at: now, days, ids: {}, sessions: {} }) } });
}

test('往前翻：昨天、上周、上月；31 天的月份柱状图有 31 天', () => {
  const h = seeded(local(10, 21));
  const y = h.ctm.usage('day', 1);
  assert.deepEqual([y.from, y.to, y.days], [key(10, 20), key(10, 20), 1]);
  const w = h.ctm.usage('week', 1);
  assert.deepEqual([w.from, w.to, w.days], [key(10, 12), key(10, 18), 7]);
  near(w.cost, 14);
  const m = h.ctm.usage('month', 1);
  assert.deepEqual([m.from, m.to, m.days, m.span], [key(9, 1), key(9, 30), 30, 30]);
  assert.equal(m.daily.length, 30);
  assert.equal(m.daily[29].day, key(9, 30));
  assert.ok(m.daily.every((d) => d.inPeriod));
  const aug = h.ctm.usage('month', 2);
  assert.equal(aug.daily.length, 31);
  assert.equal(aug.daily[0].day, key(8, 1));
  near(aug.cost, 31);
});

test('和上一期同期比：本周比上周的头三天；过完的一期和整个上一期比；今天和整个昨天比', () => {
  const h = seeded(local(10, 21));
  const w = h.ctm.usage('week');
  assert.deepEqual([w.prev.from, w.prev.to, w.prev.partial], [key(10, 12), key(10, 14), true]);
  near(w.prev.cost, 6);
  const lw = h.ctm.usage('week', 1);
  assert.deepEqual([lw.prev.from, lw.prev.to, lw.prev.partial], [key(10, 5), key(10, 11), false]);
  near(lw.prev.cost, 7);
  const d = h.ctm.usage('day');
  assert.deepEqual([d.prev.from, d.prev.to], [key(10, 20), key(10, 20)]);
  // 本月的头 21 天比 9 月的头 21 天；9 月只有 30 天，比 10 月整月时取到 9/30
  const m = h.ctm.usage('month');
  assert.deepEqual([m.prev.from, m.prev.to], [key(9, 1), key(9, 21)]);
  const late = seeded(new Date(2026, 9, 31, 12).getTime()).ctm.usage('month');
  assert.equal(late.prev.to, key(9, 30));
});

test('本月的月底预计按到现在为止的日均；命中率是缓存读占全部输入的比例', () => {
  const h = seeded(local(10, 21));
  const m = h.ctm.usage('month');
  // 10/1–10/11 每天 $1、10/12–10/21 每天 $2，到 10/21 12:00 过了 20.5 天
  near(m.cost, 11 + 20);
  near(m.projection, (31 / 20.5) * 31);
  near(m.hit, 900 / 910);
  assert.equal(h.ctm.usage('month', 1).projection, undefined, '过去的月份不预计');
  assert.equal(seeded(new Date(2026, 9, 2, 12).getTime()).ctm.usage('month').projection, null, '月初两天以内不预计');
});

test('点柱子看某一天：柱状图不跟着动，那一天在图里时照旧', () => {
  const h = seeded(local(10, 21));
  const d = h.ctm.usage('day', 5, key(10, 21));
  assert.equal(d.from, key(10, 16));
  assert.equal(d.daily[d.daily.length - 1].day, key(10, 21));
  assert.deepEqual(d.daily.filter((x) => x.inPeriod).map((x) => x.day), [key(10, 16)]);
  // 翻到图外面去了：图换成以那一天结尾
  const far = h.ctm.usage('day', 40, key(10, 21));
  assert.equal(far.daily[far.daily.length - 1].day, far.to);
});

test('按会话汇总：会话页面上的标题和地址，频道页上先记的账到会话页面后合并成一个会话', () => {
  const store = new Map();
  const T = local(10, 21);
  // 先在频道页上看到这个会话的两轮（没有会话地址）
  const ch = load({ now: T, storage: store, path: '/code/project/chan_0123456789abcdefghij' });
  const r1 = at(result({ [OPUS]: { output: 1000, cost: 1 } }, { sid: 'cli-a' }), T - 30 * MIN);
  const r2 = at(result({ [OPUS]: { output: 2000, cost: 3 } }, { sid: 'cli-a' }), T - 20 * MIN);
  ch.feed(history(r1, r2));
  ch.render();
  let s = ch.ctm.usage('day').sessions;
  assert.equal(s.length, 1);
  assert.equal(s[0].path, '', '还不知道是哪个网页会话');
  near(s[0].cost, 3);
  // 再打开会话页面：网页加载了会话对象（带标题），历史里是同样两轮，又来了一轮
  const h = load({ now: T + MIN, storage: store, path: P });
  h.feed({ id: 'session_0123456789abcdefghij', title: '修登录页的 bug', external_metadata: { model: OPUS } });
  h.feed(history(r1, r2));
  h.render();
  assert.equal(h.ctm.usage('day').sessions[0].path, P, '这两轮已经记过账，也要知道它们属于这个会话');
  h.feed(result({ [OPUS]: { output: 2500, cost: 3.5 } }, { sid: 'cli-a' }));
  h.render();
  s = h.ctm.usage('day').sessions;
  assert.equal(s.length, 1);
  assert.deepEqual([s[0].title, s[0].path, s[0].turns, s[0].current], ['修登录页的 bug', P, 3, true]);
  near(s[0].cost, 3.5);
  // 别的会话、按花费排
  h.navigate('/code/session_9876543210zyxwvutsrq');
  h.feed(result({ [OPUS]: { output: 9000, cost: 9 } }, { sid: 'cli-b' }));
  h.render();
  s = h.ctm.usage('day').sessions;
  assert.deepEqual(s.map((x) => [x.path, x.current]), [['/code/session_9876543210zyxwvutsrq', true], [P, false]]);
  assert.equal(s[1].title, '修登录页的 bug');
  // 诊断里没有标题和会话地址
  const diag = JSON.stringify(h.ctm.diagnostics());
  assert.ok(!diag.includes('修登录页') && !diag.includes('0123456789abcdefghij'));
});

// 主对话的一次请求：上下文 ctx，cacheRead 读到多少、cacheWrite 写了多少
const req = (id, ctx, read) => assistant(id, { input: 5, cacheRead: read, cacheWrite: ctx - 5 - read });

test('缓存重建记进账本：按请求去重，刷新、两个标签页都只记一次；/clear 之后的不记', () => {
  const store = new Map();
  const T = local(10, 21, 9);
  const h = load({ now: T, storage: store });
  const a = req('msg_01aaaaaaaaaaaaaaaa', 300005, 0);
  const r1 = result({ [OPUS]: { output: 1000, cost: 2 } });
  h.feed(a, r1);
  h.advance(70 * MIN); // 闲置超过 1 小时，缓存过期
  const b = req('msg_01bbbbbbbbbbbbbbbb', 300005, 0);
  const r2 = result({ [OPUS]: { output: 2000, cost: 4.5 } });
  h.feed(b, r2);
  h.render();
  let d = h.ctm.usage('day');
  assert.equal(d.rebuilds, 1);
  // Opus 5.5：1 小时缓存写入 $8/M，缓存读 $0.2/M，多花的是这两者之差
  near(d.rebuildCost, 300005 * (8e-6 - 0.2e-6));
  // 刷新之后历史里又看到一次
  const h2 = load({ now: T + 71 * MIN, storage: store });
  h2.feed(history(at(a, T), at(r1, T + MIN), at(b, T + 70 * MIN), at(r2, T + 71 * MIN)));
  h2.render();
  assert.equal(h2.ctm.usage('day').rebuilds, 1);
  // /clear 之后的新对话重建缓存是正常的
  h2.feed({ type: 'conversation_reset', uuid: 'cr-1' });
  h2.feed(req('msg_01cccccccccccccccc', 200005, 0), result({ [OPUS]: { output: 100, cost: 0.5 } }));
  h2.render();
  assert.equal(h2.ctm.usage('day').rebuilds, 1);
  assert.equal(h2.ctm.diagnostics().ledger.rebuilds, 1);
});

test('旧账本（1.6.x）没有按会话和缓存重建的记录，照常读', () => {
  const old = { v: 2, at: 1, days: { [key(10, 21)]: { [OPUS]: [1, 2, 3, 4, 5, 1] } }, ids: {}, sessions: {} };
  const h = load({ now: local(10, 21), storage: { [LEDGER]: JSON.stringify(old) } });
  const d = h.ctm.usage('day');
  near(d.cost, 5);
  assert.deepEqual([d.rebuilds, d.sessions.length], [0, 0]);
});
