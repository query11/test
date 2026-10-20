// 用量账本：按天记每一轮的用量；实时、刷新后的历史、多个标签页看到的同一轮只记一次
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, result } = require('./harness');

const OPUS = 'claude-opus-5-5';
const HAIKU = 'claude-haiku-5-5';
const P = '/code/session_0123456789abcdefghij';
const LEDGER = 'ctm-ledger-v2';
const MIN = 60000;
const DAY = 864e5;

// 本地时间：账本按本地日期记，用本地时间构造就不受测试机时区影响
const local = (d, h = 12, m = 0) => new Date(2026, 9, d, h, m).getTime(); // 2026 年 10 月 d 日
const key = (d) => '2026-10-' + String(d).padStart(2, '0');
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, (msg || '') + ' ' + a + ' ≠ ' + b);

// 一次带来多条消息的数据，脚本当成历史记录加载
let n = 0;
const user = () => ({ type: 'user', uuid: 'u-' + ++n, message: { role: 'user', content: 'hi' } });
const history = (...events) => events.flatMap((e) => [user(), e]);
const at = (r, t) => ({ ...r, timestamp: new Date(t).toISOString() });
// 累计花费 cost 的一条 result，token 按花费等比例
const cum = (cost, extra = {}) => result({ [OPUS]: { input: 10 * cost, output: 1000 * cost, cacheRead: 50000 * cost, cacheWrite: 500 * cost, cost }, ...extra });

const today = (h) => h.ctm.usage('day');

test('实时的几轮只记一次；刷新后历史里又来一遍，不重复记', () => {
  const store = new Map();
  const h = load({ now: local(20, 10), storage: store });
  const r1 = cum(1);
  const r2 = cum(2.5);
  h.feed(r1);
  h.render();
  h.advance(MIN);
  h.feed(r2);
  h.render();
  h.render();
  let s = today(h);
  near(s.cost, 2.5);
  assert.equal(s.turns, 2);
  assert.equal(s.output, 2500);
  assert.equal(s.input, 25);
  assert.equal(s.cacheRead, 125000);
  assert.equal(s.cacheWrite, 1250);

  // 刷新：同一个 storage 重新加载，历史一次全部来到（带服务端时间戳）
  const h2 = load({ now: local(20, 10, 5), storage: store });
  h2.feed(history(at(r1, local(20, 10)), at(r2, local(20, 10, 1))));
  h2.render();
  s = today(h2);
  near(s.cost, 2.5);
  assert.equal(s.turns, 2);

  // 之后实时的一轮接着记
  h2.feed(cum(4));
  h2.render();
  near(today(h2).cost, 4);
  assert.equal(today(h2).turns, 3);
});

test('历史里同一轮的 uuid 对不上时，按时间和累计值判断已经记过', () => {
  const store = new Map();
  const h = load({ now: local(20, 10), storage: store });
  const r1 = cum(1);
  const r2 = cum(2);
  h.feed(r1);
  h.advance(MIN);
  h.feed(r2);
  h.render();
  // 重新加载时 uuid 都换了；服务端时钟比本机快 5 秒，同一轮的时间戳比水位线还晚
  const h2 = load({ now: local(20, 10, 5), storage: store });
  h2.feed(history(at({ ...r1, uuid: 'x1' }, local(20, 10) + 5000), at({ ...r2, uuid: 'x2' }, local(20, 10, 1) + 5000), at(cum(3), local(20, 10, 3))));
  h2.render();
  near(today(h2).cost, 3);
  assert.equal(today(h2).turns, 3);
});

test('本机时钟比服务端快：按 uuid 找到水位线，之后在别处用的一轮照样记上', () => {
  const store = new Map();
  const h = load({ now: local(20, 10, 1), storage: store }); // 本机比服务端快 30 秒
  const r1 = cum(1);
  const r2 = cum(2);
  h.feed(r1, r2);
  h.render();
  // 紧接着在别处又用了一轮，服务端时间比水位线（按本机时间记的）还早
  const h2 = load({ now: local(20, 10, 5), storage: store });
  h2.feed(history(at(r1, local(20, 10) - 30000), at(r2, local(20, 10, 1) - 30000), at(cum(3), local(20, 10, 1) - 10000)));
  h2.render();
  near(today(h2).cost, 3);
});

test('/clear 前后两段分别相减；子代理的花费看累计值的差，含在这一轮里', () => {
  const h = load({ now: local(20) });
  h.feed(result({ [OPUS]: { output: 1000, cost: 1 } }));
  // 这一轮主对话输出 200（result.usage 只含主对话），子代理用 Haiku 又输出 500
  const turn = { input_tokens: 5, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  h.feed(result({ [OPUS]: { output: 3000, cost: 2.5 }, [HAIKU]: { output: 500, cost: 0.05 } }, { turn }));
  h.feed({ type: 'conversation_reset', uuid: 'reset-1' });
  h.feed(result({ [OPUS]: { output: 400, cost: 0.3 } }));
  h.feed(result({ [OPUS]: { output: 900, cost: 0.8 } }));
  h.render();
  const s = today(h);
  near(s.cost, 3.35);
  assert.equal(s.output, 4400);
  assert.equal(s.turns, 4); // 用了两个模型的那一轮也只算一轮
  const by = Object.fromEntries(s.models.map((m) => [m.name, m]));
  near(by['Opus 5.5'].cost, 3.3);
  near(by['Haiku 5.5'].cost, 0.05);
  assert.equal(by['Haiku 5.5'].output, 500);
  assert.deepEqual(s.models.map((m) => m.name), ['Opus 5.5', 'Haiku 5.5']);
});

test('历史只加载了后半段：和水位线相减，不把整段累计值再记一遍', () => {
  const store = new Map();
  const h = load({ now: local(20, 9), storage: store });
  for (const c of [1, 2, 3]) {
    h.advance(MIN);
    h.feed(cum(c));
  }
  h.render();
  near(today(h).cost, 3);
  // 之后在别处又用了三轮（累计 4、5、6）；重开会话时历史只加载了最后两轮
  const h2 = load({ now: local(20, 11), storage: store });
  h2.feed(history(at(cum(5), local(20, 10, 40)), at(cum(6), local(20, 10, 50))));
  h2.render();
  near(today(h2).cost, 6); // 第 4、5 轮看不到分界，合在一起记
  assert.equal(today(h2).turns, 5);
});

test('只看到 /clear 之后的新一段（累计值比水位线小）：从零开始算', () => {
  const store = new Map();
  const h = load({ now: local(20, 9), storage: store });
  h.feed(cum(1));
  h.advance(MIN);
  h.feed(cum(3));
  h.render();
  const h2 = load({ now: local(20, 11), storage: store });
  h2.feed(history(at(cum(0.5), local(20, 10, 40)), at(cum(1.2), local(20, 10, 50))));
  h2.render();
  near(today(h2).cost, 4.2);
});

test('同一个会话开在两个标签页：两边交替看到同样的事件，不翻倍', () => {
  const store = new Map();
  const a = load({ now: local(20, 10), storage: store });
  const b = load({ now: local(20, 10), storage: store });
  const rs = [1, 2, 3, 4, 5].map((c) => cum(c));
  for (let i = 0; i < rs.length; i++) {
    const [x, y] = i % 2 ? [a, b] : [b, a];
    x.advance(MIN);
    y.advance(MIN);
    x.feed(rs[i]);
    x.render();
    y.feed(rs[i]);
    y.render();
  }
  near(today(a).cost, 5);
  assert.equal(today(a).turns, 5);
  near(JSON.parse(store.get(LEDGER)).days[key(20)][OPUS][4], 5);
});

test('两个标签页开着不同的会话：各自记账，不会互相覆盖', () => {
  const store = new Map();
  const a = load({ now: local(20, 10), storage: store, path: '/code/session_aaaaaaaaaaaaaaaaaaaa' });
  const b = load({ now: local(20, 10), storage: store, path: '/code/session_bbbbbbbbbbbbbbbbbbbb' });
  a.feed(cum(1));
  a.render();
  b.feed(cum(2));
  b.render();
  a.advance(MIN);
  a.feed(cum(1.5));
  a.render();
  const book = JSON.parse(store.get(LEDGER));
  near(book.days[key(20)][OPUS][4], 3.5);
  assert.equal(Object.keys(book.sessions).length, 2);
});

test('同一段历史出现在两个会话地址下（比如复制出来的会话）：只记一次', () => {
  const store = new Map();
  const a = load({ now: local(20, 10), storage: store, path: '/code/session_aaaaaaaaaaaaaaaaaaaa' });
  const r1 = cum(1);
  const r2 = cum(2);
  a.feed(r1);
  a.advance(MIN);
  a.feed(r2);
  a.render();
  const b = load({ now: local(20, 11), storage: store, path: '/code/session_bbbbbbbbbbbbbbbbbbbb' });
  b.feed(history(at(r1, local(20, 10)), at(r2, local(20, 10, 1))));
  b.render();
  near(today(b).cost, 2);
  b.feed(cum(2.5)); // 在新会话里接着做
  b.render();
  near(today(b).cost, 2.5);
  assert.equal(today(b).turns, 3);
});

// 真实的 result 带着 CLI 的会话 id（session_id）
const sid = (r, s) => ({ ...r, session_id: s });

test('前几轮在别的页面看到并记过账，到会话页面只看到最新一轮（看不到上一条）：按 CLI 会话的水位线相减，不重复记', () => {
  const store = new Map();
  const p = load({ now: local(20, 10, 5), storage: store, path: '/code/project/chan_0123456789abcdef' });
  p.feed(history(at(sid(cum(1), 'cli-1'), local(20, 9)), at(sid(cum(2), 'cli-1'), local(20, 10))));
  p.render();
  near(today(p).cost, 2);
  // 网页切到会话时只补拉最新 20 条，Claude Code 一轮往往比这多，上一条 result 不在里面
  const s = load({ now: local(20, 11, 5), storage: store });
  s.feed(history(at(sid(cum(2.5), 'cli-1'), local(20, 11))));
  s.render();
  near(today(s).cost, 2.5);
  assert.equal(today(s).turns, 3);
});

test('水位线只往后挪：另一个标签页里只加载到较早的几轮，不会把它拉回去', () => {
  const store = new Map();
  const rs = [1, 2, 3].map((c, i) => at(sid(cum(c), 'cli-2'), local(20, 9, i * 10)));
  const a = load({ now: local(20, 10), storage: store });
  a.feed(history(...rs));
  a.render();
  near(today(a).cost, 3);
  const b = load({ now: local(20, 10, 1), storage: store });
  b.feed(history(rs[0], rs[1]));
  b.render();
  // 之后又一个标签页只看到最新一轮：和第 3 轮相减
  const c = load({ now: local(20, 11, 5), storage: store });
  c.feed(history(at(sid(cum(4), 'cli-2'), local(20, 11))));
  c.render();
  near(today(c).cost, 4);
});

test('先看到最新一轮、后来才加载到历史：更早的几段补记到各自的日期，再刷新也不重复', () => {
  const store = new Map();
  const now = local(20, 21, 43);
  const live = cum(0.17); // 这一段的第一轮（之前续接时累计值从零重新开始）
  const h = load({ now, storage: store });
  h.feed(live);
  h.render();
  near(today(h).cost, 0.17);
  const past = [at(cum(4.2), local(13, 21, 35)), at(cum(7.6), local(13, 23, 29)), at(cum(4.5), local(20, 18)), at(cum(10), local(20, 21, 37)), at(live, now)];
  for (const m of [2, 3]) {
    const h2 = load({ now: now + m * MIN, storage: store });
    h2.feed(history(...past));
    h2.render();
    const days = h2.ctm.ledger.days;
    near(days[key(13)][OPUS][4], 7.6);
    assert.equal(days[key(13)][OPUS][5], 2);
    near(today(h2).cost, 10.17);
    assert.equal(today(h2).turns, 3);
  }
});

test('先看到一段中间的一轮（按整段累计值记了），后来才加载到这一段更早的几轮：不再重复记', () => {
  const store = new Map();
  const r5 = cum(5);
  const h = load({ now: local(20, 12), storage: store });
  h.feed(r5);
  h.render();
  near(today(h).cost, 5);
  const h2 = load({ now: local(20, 12, 5), storage: store });
  h2.feed(history(at(cum(1), local(20, 9)), at(cum(3), local(20, 10)), at(r5, local(20, 12))));
  h2.render();
  near(today(h2).cost, 5);
  assert.equal(today(h2).turns, 1);
});

test('支持 Web Locks 时在锁里记账；等锁期间新来的也会记上', async () => {
  const names = [];
  const locks = { request: (name, fn) => (names.push(name), Promise.resolve().then(fn)) };
  const h = load({ now: local(20, 10), locks });
  h.feed(cum(1));
  h.render();
  h.feed(cum(2));
  h.render(); // 上一次还在等锁，这次不重复申请
  assert.equal(names.length, 1);
  await new Promise(setImmediate);
  h.render();
  await new Promise(setImmediate);
  near(today(h).cost, 2);
  assert.equal(today(h).turns, 2);
  assert.deepEqual([...new Set(names)], ['ctm-ledger']);
});

test('跨午夜的两轮分到两天', () => {
  const h = load({ now: local(20, 23, 50) });
  h.feed(cum(1));
  h.render();
  h.advance(20 * MIN); // 10 月 21 日 00:10
  h.feed(cum(1.75));
  h.render();
  const days = h.ctm.ledger.days;
  near(days[key(20)][OPUS][4], 1);
  near(days[key(21)][OPUS][4], 0.75);
  assert.equal(days[key(21)][OPUS][5], 1);
  near(today(h).cost, 0.75);
  near(h.ctm.usage('week').cost, 1.75);
});

test('没有水位线的会话：60 天以前的 result 不记', () => {
  const now = local(20);
  const h = load({ now });
  h.feed(history(at(cum(1), now - 70 * DAY), at(cum(2), now - 65 * DAY), at(cum(5), now - DAY)));
  h.render();
  const days = h.ctm.ledger.days;
  assert.deepEqual(Object.keys(days), [key(19)]);
  near(days[key(19)][OPUS][4], 3); // 只记最近这一轮：和上一条相减
  assert.ok(h.ctm.ledger.sessions[P]);
});

test('账本清理：按天的记录留本月和之前 12 个月，记过账的编号和水位线留 60 天；旧版账本删掉', () => {
  const now = local(20);
  const old = { id: 'r-old', t: now - 61 * DAY, c: {} };
  const storage = {
    [LEDGER]: JSON.stringify({
      v: 2,
      days: { '2025-09-30': { [OPUS]: [1, 1, 1, 1, 1, 1] }, '2025-10-01': { [OPUS]: [1, 1, 1, 1, 2, 1] } },
      ids: { '2026-08-19': 'aaaaaaaaaaaa', '2026-08-21': 'bbbbbbbbbbbb cccccccccccc' },
      sessions: { '/code/session_old': old, '/code/session_recent': { ...old, t: now - 59 * DAY } },
    }),
    'ctm-ledger': JSON.stringify({ v: 1, days: {}, sessions: {} }),
  };
  const h = load({ now, storage });
  assert.equal(h.store.has('ctm-ledger'), false);
  h.feed(cum(1));
  h.render();
  const book = h.ctm.ledger;
  assert.deepEqual(Object.keys(book.days).sort(), ['2025-10-01', key(20)]);
  assert.deepEqual(Object.keys(book.ids).sort(), ['2026-08-21', key(20)]); // 8/21 离今天正好 60 天
  assert.deepEqual(Object.keys(book.sessions).sort(), [P, '/code/session_recent']);
});

// 预置一份账本：10/18 周日、10/19 周一、10/20 周二（今天，两个模型），9/30 和 10/1
function seeded(now) {
  const days = {
    '2026-09-30': { [OPUS]: [1, 100, 0, 0, 8, 1] },
    '2026-10-01': { [OPUS]: [1, 200, 0, 0, 16, 2] },
    [key(18)]: { [OPUS]: [1, 300, 0, 0, 1, 1] },
    [key(19)]: { [OPUS]: [1, 400, 0, 0, 2, 1] },
    [key(20)]: { [OPUS]: [10, 500, 9000, 800, 3, 2], 'claude-opus-5-5-20261001': [5, 50, 0, 0, 0.5, 1], [HAIKU]: [2, 20, 0, 0, 0.5, 0] },
  };
  return load({ now, storage: { [LEDGER]: JSON.stringify({ v: 2, at: now, days, ids: {}, sessions: {} }) } });
}

test('今天 / 本周（周一开始）/ 本月的合计，模型按显示名合并', () => {
  const h = seeded(local(20));
  const d = h.ctm.usage('day');
  near(d.cost, 4);
  assert.equal(d.turns, 3);
  assert.equal(d.output, 570);
  assert.equal(d.cacheRead, 9000);
  assert.deepEqual(d.models.map((m) => [m.name, m.cost, m.output]), [['Opus 5.5', 3.5, 550], ['Haiku 5.5', 0.5, 20]]);
  const w = h.ctm.usage('week');
  assert.equal(w.from, key(19));
  assert.equal(w.days, 2);
  near(w.cost, 6);
  const m = h.ctm.usage('month');
  assert.equal(m.from, '2026-10-01');
  assert.equal(m.days, 20);
  near(m.cost, 23);
  assert.equal(m.daily.length, 30);
  assert.deepEqual(m.daily[29], { day: key(20), cost: 4, turns: 3, inPeriod: true });
  assert.equal(m.daily.find((x) => x.day === '2026-09-30').inPeriod, false);
  // 周日还算这一周，周一是新的一周
  assert.equal(seeded(local(25)).ctm.usage('week').from, key(19));
  assert.equal(seeded(local(26)).ctm.usage('week').from, key(26));
});

test('导出 CSV：一行是“日期 + 模型”，模型写原始 id；诊断里只有账本的统计', () => {
  const h = seeded(local(20));
  const lines = h.ctm.usageCsv().trim().split('\n');
  assert.equal(lines[0], 'date,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_usd,turns');
  assert.equal(lines.length, 8);
  assert.equal(lines[1], '2026-09-30,claude-opus-5-5,1,100,0,0,8,1');
  assert.ok(lines.includes('2026-10-20,claude-opus-5-5-20261001,5,50,0,0,0.5,1'));
  const diag = h.ctm.diagnostics().ledger;
  assert.equal(diag.days, 5);
  assert.equal(diag.first, '2026-09-30');
  assert.equal(diag.sessions, 0);
});
