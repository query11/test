// 本轮进度、上轮的花费和用时、几路同时输出、上下文还能撑几轮
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, messageStart, textDelta, messageStop, assistant, result } = require('./harness');

const OPUS = 'claude-opus-5-5';
const MIN = 60000;
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, (msg || '') + ' ' + a + ' ≠ ' + b);
const init = () => ({ type: 'system', subtype: 'init', uuid: 'init-' + Math.random(), model: OPUS });
const zero = () => ({ type: 'result', subtype: 'error_during_execution', uuid: 'z-' + Math.random(), total_cost_usd: 0, modelUsage: {} });
// 一次带来多条消息的数据，脚本当成历史记录加载
const history = (...events) => events.flatMap((e) => [{ type: 'user', uuid: 'u-' + Math.random(), message: { role: 'user', content: 'hi' } }, e]);
const at = (o, t) => ({ ...o, timestamp: new Date(t).toISOString() });

test('一轮进行中：从 init 开始计时，请求数含子代理，花费按上一段的平均单价估算', () => {
  const h = load();
  h.feed(result({ [OPUS]: { input: 100, output: 1000, cacheRead: 50000, cost: 1 } }));
  assert.equal(h.ctm.turn(), null, '刚结束一轮');
  h.advance(MIN);
  h.feed(init());
  assert.equal(h.ctm.turn(), null, '光有 init 不算开始（重连时也可能来一条）');
  const t0 = h.clock.now;
  h.advance(10000);
  h.feed(messageStart('msg_a', { input: 10, cacheRead: 50000 }));
  let t = h.ctm.turn();
  assert.equal(t.start, t0, '开始时间往前推到 init');
  assert.equal(t.requests, 1);
  // 上一段的单价：$1 ÷（100 + 1000×5 + 50000×0.05）；这次请求的权重：10 + 1×5 + 50000×0.05
  near(t.cost, 2515 / 7600);
  h.advance(30000);
  h.feed(messageStart('msg_sub', { lane: 'toolu_1' }));
  assert.equal(h.ctm.turn().requests, 2);
  const pill = h.ctm.pill().find((p) => p.key === 'speed');
  assert.equal(pill.text, '本轮 0:40', '没有输出时一行摘要里是本轮计时');
  h.feed(result({ [OPUS]: { input: 200, output: 3000, cacheRead: 150000, cost: 1.5 } }, { apiMs: 30000, wallMs: 41000, requests: 2 }));
  assert.equal(h.ctm.turn(), null);
});

test('全零的 result（出错、被打断）也结束这一轮', () => {
  const h = load();
  h.feed(result({ [OPUS]: { output: 1000, cost: 1 } }));
  h.advance(MIN);
  h.feed(messageStart('msg_a'));
  assert.ok(h.ctm.turn());
  h.feed(messageStop());
  h.feed(zero());
  assert.equal(h.ctm.turn(), null);
  assert.equal(h.ctm.state.results.length, 1, '全零的不进累计值');
});

test('打开页面时一轮正在进行：历史里最后一条 result 之后的请求算本轮；很久以前没结束的不算', () => {
  const T = Date.parse('2026-10-20T02:00:00Z');
  const h = load({ now: T });
  h.feed(history(at(result({ [OPUS]: { output: 1000, cost: 1 } }), T - 20 * MIN), at(assistant('msg_1'), T - 3 * MIN), at(assistant('msg_2'), T - 2 * MIN)));
  const t = h.ctm.turn();
  assert.equal(t.start, T - 3 * MIN);
  assert.equal(t.requests, 2);

  const old = load({ now: T });
  old.feed(history(at(result({ [OPUS]: { output: 1000, cost: 1 } }), T - 300 * MIN), at(assistant('msg_1'), T - 200 * MIN), at(assistant('msg_2'), T - 190 * MIN)));
  assert.equal(old.ctm.turn(), null, 'CLI 中途退出留下的一轮');
});

test('会话的第一轮还没有 result：花费按价目表估', () => {
  const h = load();
  h.feed(messageStart('msg_a', { input: 1000, cacheWrite: 100000 }));
  // Opus 5.5：输入 $4/M，1 小时缓存写入是 2 倍，输出按输入的 5 倍
  near(h.ctm.turn().cost, 1000 * 4e-6 + 100000 * 8e-6 + 1 * 20e-6);
});

test('上一轮：花费、用时、请求数；一段的第一条只有耗时对得上才知道花费', () => {
  const turn = { input_tokens: 5, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const h = load();
  h.feed(result({ [OPUS]: { output: 1000, cost: 1 } }, { apiMs: 20000, wallMs: 25000, requests: 3, turn }));
  let lt = h.ctm.lastTurn();
  assert.equal(lt.cost, 1, 'duration_api_ms 不超过本轮时长：就是这一轮的');
  assert.equal(lt.requests, 3);
  h.feed(result({ [OPUS]: { output: 2500, cost: 1.42 } }, { apiMs: 50000, wallMs: 130000, requests: 5 }));
  lt = h.ctm.lastTurn();
  near(lt.cost, 0.42);
  assert.equal(lt.wall, 130000);
  assert.equal(lt.requests, 5);

  // 历史只加载了最后一条：累计的 API 耗时比这一轮还长，花费是整段的，不能当成这一轮的
  const p = load();
  p.feed(result({ [OPUS]: { output: 9000, cost: 7 } }, { apiMs: 900000, wallMs: 60000, turn }));
  assert.equal(p.ctm.lastTurn().cost, null);
  const q = load();
  q.feed(result({ [OPUS]: { output: 9000, cost: 7 } }, { turn }));
  assert.equal(q.ctm.lastTurn().cost, null, '没有耗时也不知道');
});

test('主对话和子代理同时输出：标出几路，速度是合计的', () => {
  const h = load();
  h.feed(messageStart('msg_main'), messageStart('msg_s1', { lane: 'toolu_1' }), messageStart('msg_s2', { lane: 'toolu_2' }));
  for (let i = 0; i < 10; i++) {
    h.advance(100);
    h.feed(textDelta('hello world, streaming '), textDelta('hello world, streaming ', 'toolu_1'), textDelta('hello world, streaming ', 'toolu_2'));
  }
  h.render();
  assert.equal(h.ctm.live.lanes, 3);
  assert.equal(h.ctm.live.mainOut, true);
  assert.match(h.ctm.pill().find((p) => p.key === 'speed').text, / tok\/s ×3$/);
  // 主对话停了，两个子代理还在输出
  h.feed(messageStop());
  for (let i = 0; i < 20; i++) {
    h.advance(100);
    h.feed(textDelta('more text here ', 'toolu_1'), textDelta('more text here ', 'toolu_2'));
  }
  h.render();
  assert.equal(h.ctm.live.lanes, 2);
  assert.equal(h.ctm.live.mainOut, false);
});

// 主对话一轮：一次请求（上下文 ctx），然后 result
function turnWith(h, i, ctx, cost) {
  h.feed(assistant('msg_' + i, { input: 5, cacheRead: ctx - 5 }));
  h.feed(result({ [OPUS]: { output: 1000 * (i + 1), cost } }));
  h.advance(MIN);
}

test('上下文还能撑几轮：按最近几轮的增长，阈值不知道时按上下文窗口减去 33k', () => {
  const h = load();
  turnWith(h, 0, 300000, 1);
  turnWith(h, 1, 315000, 2);
  assert.equal(h.ctm.runway(), null, '不到 3 轮');
  turnWith(h, 2, 330000, 3);
  turnWith(h, 3, 345000, 4);
  let rw = h.ctm.runway();
  assert.equal(rw.growth, 15000);
  assert.equal(rw.limit, 967000);
  assert.equal(rw.guess, true);
  assert.equal(rw.turns, Math.floor((967000 - 345000) / 15000));
  // CLI 报告了自动压缩阈值
  h.feed({ type: 'control_response', uuid: 'cr1', response: { totalTokens: 345000, maxTokens: 1000000, percentage: 34.5, autoCompactThreshold: 800000 } });
  rw = h.ctm.runway();
  assert.equal(rw.limit, 800000);
  assert.equal(rw.guess, false);
  assert.equal(rw.turns, Math.floor((800000 - 345000) / 15000));
  // 压缩之后从头数
  h.feed({ type: 'system', subtype: 'compact_boundary', uuid: 'cb1', compact_metadata: { post_tokens: 40000 } });
  turnWith(h, 4, 45000, 5);
  assert.equal(h.ctm.runway(), null);
});
