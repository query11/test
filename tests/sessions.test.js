// 切换会话：网页切回看过的会话时只补拉最新的事件（cursor 之后的和最新 20 条），更早的用它自己的缓存；
// 接口地址里带着会话 id；一个页面里可能混着几个 CLI 会话的 result
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, result, messageStart, assistant } = require('./harness');

const OPUS = 'claude-opus-5-5';
const MIN = 60000;
const A = '/code/session_0123456789abcdefghij'; // 测试台默认的页面
const B = '/code/session_bbbbbbbbbbbbbbbbbbbb';
const CHAN = '/code/project/chan_0123456789abcdef';
const eventsOf = (page) => '/v1/code/sessions/' + page.split('/').pop() + '/events?limit=20&sort_order=desc';

const local = (d, h = 12, m = 0) => new Date(2026, 9, d, h, m).getTime(); // 2026 年 10 月 d 日，本地时间
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, (msg || '') + ' ' + a + ' ≠ ' + b);
let n = 0;
const user = () => ({ type: 'user', uuid: 'su-' + ++n, message: { role: 'user', content: 'hi' } });
const history = (...events) => events.flatMap((e) => [user(), e]); // 一次带来多条消息：当成历史记录
const at = (r, t) => ({ ...r, timestamp: new Date(t).toISOString() });
const cum = (cost, sid) => result({ [OPUS]: { input: 10 * cost, output: 1000 * cost, cacheRead: 50000 * cost, cacheWrite: 500 * cost, cost } }, { sid });

test('切走再切回来：网页只补拉最新的一点，会话统计接着之前的，不会只剩最后一段', () => {
  const h = load({ now: local(20, 11) });
  const r3 = at(cum(2), local(20, 10, 30));
  const clear = { type: 'conversation_reset', uuid: 'clear-1', timestamp: new Date(local(20, 9, 30)).toISOString() };
  h.feed([user(), at(cum(5), local(20, 9)), clear, user(), at(cum(1), local(20, 10)), user(), r3]);
  h.render();
  near(h.ctm.totals().cost, 7);
  h.navigate(B);
  h.feed(history(at(cum(0.3), local(20, 10, 50))));
  h.render();
  near(h.ctm.totals().cost, 0.3);
  // 切回来：网页只拉了 cursor 之后的和最新 20 条，里面只有最新的两轮
  h.advance(5 * MIN);
  h.navigate(A);
  h.feed(history(r3, at(cum(2.5), local(20, 11, 3))));
  h.render();
  near(h.ctm.totals().cost, 7.5); // /clear 之前那段 $5 还在
  assert.equal(h.ctm.lastTurn().tokens, 500);
  near(h.ctm.usage('day').cost, 7.8);
});

test('切换之后才到的上一个会话的数据：按接口地址归回那个会话，不算到新会话头上', () => {
  const h = load({ now: local(20, 11) });
  h.navigate(B);
  h.feedFrom(eventsOf(A), history(at(cum(1), local(20, 10)), at(cum(3), local(20, 10, 30))));
  h.render();
  assert.equal(h.ctm.totals().cost, 0);
  near(h.ctm.usage('day').cost, 3); // 账本照样记上
  h.navigate(A);
  near(h.ctm.totals().cost, 3);
});

test('频道页上加载的会话历史归到那个会话：之后打开它，网页只补拉最新一轮也是完整的', () => {
  const h = load({ now: local(20, 11), path: CHAN });
  h.feedFrom(eventsOf(A), history(at(cum(1), local(20, 9)), at(cum(2), local(20, 10))));
  h.render();
  near(h.ctm.usage('day').cost, 2);
  assert.equal(h.ctm.totals().cost, 0); // 频道页自己的统计里没有
  h.navigate(A);
  h.feedFrom(eventsOf(A), history(at(cum(2.5), local(20, 11))));
  h.render();
  near(h.ctm.totals().cost, 2.5);
  assert.equal(h.ctm.lastTurn().tokens, 500);
  near(h.ctm.usage('day').cost, 2.5);
});

test('切换前就拿到的会话信息（地址带会话 id）：切过去马上能看到模型和推理强度', () => {
  const h = load({ now: local(20, 11), path: B });
  const id = A.split('/').pop();
  h.feedFrom('/v1/code/sessions/' + id, { id, external_metadata: { model: OPUS, effort_level: 'xhigh' } });
  assert.equal(h.ctm.model().id, '');
  h.navigate(A);
  assert.equal(h.ctm.model().id, OPUS);
  assert.equal(h.ctm.model().effort, 'xhigh');
});

test('切走时还在进行的请求：切回来不再显示成进行中', () => {
  const h = load({ now: local(20, 11) });
  h.feed(messageStart('msg_1'));
  h.render();
  assert.ok(h.ctm.live.active);
  h.navigate(B);
  h.advance(MIN);
  h.navigate(A);
  h.render();
  assert.equal(h.ctm.live.active, null);
  // 地址换了写法、还是同一个会话：进行中的请求照常显示
  h.feed(messageStart('msg_2'));
  h.navigate('/code/cse_' + A.split('_').pop());
  h.render();
  assert.ok(h.ctm.live.active);
});

test('切走期间在别处改了推理强度：切回来用会话信息里的新值，不被切走前的旧线索盖过', () => {
  const h = load({ now: local(20, 11) });
  const id = A.split('/').pop();
  const session = (effort) => ({ id, created_at: new Date(local(19, 9)).toISOString(), external_metadata: { model: OPUS, effort_level: effort } });
  h.feedFrom('/v1/code/sessions/' + id, session('high'));
  assert.equal(h.ctm.model().effort, 'high');
  h.feed({ type: 'control_request', request: { subtype: 'apply_flag_settings', settings: { effortLevel: 'xhigh' } } }); // 在网页上改的
  assert.equal(h.ctm.model().effort, 'xhigh');
  h.navigate(B);
  h.advance(10 * MIN);
  h.navigate(A);
  h.feedFrom('/v1/code/sessions/' + id, session('max'));
  assert.equal(h.ctm.model().effort, 'max');
  h.feedFrom('/v1/code/sessions/' + id, session('max')); // 再拉一次，值没变
  assert.equal(h.ctm.model().effort, 'max');
});

test('后到的历史比之前实时看到的还新（断线重连、切回会话后补拉的）：排在后面，不重复算', () => {
  const h = load({ now: local(20, 10) });
  h.feed(history(at(cum(1), local(20, 9)), at(cum(2), local(20, 9, 30))));
  h.render();
  for (const c of [3, 4]) {
    h.advance(MIN);
    h.feed(cum(c)); // 实时的两轮
  }
  h.render();
  near(h.ctm.totals().cost, 4);
  // 过了一阵，网页一次补拉了之后的两轮
  h.advance(15 * MIN);
  h.feed(history(at(cum(5), local(20, 10, 8)), at(cum(6), local(20, 10, 12))));
  h.render();
  near(h.ctm.totals().cost, 6);
  assert.equal(h.ctm.runs().length, 1);
  assert.equal(h.ctm.lastTurn().tokens, 1000);
  near(h.ctm.usage('day').cost, 6);
  assert.equal(h.ctm.usage('day').turns, 6);
});

test('本机时钟比服务端快：补拉的一轮和之前实时看到的离得很近，也排在后面', () => {
  const h = load({ now: local(20, 10) });
  h.feed(history(at(cum(1), local(20, 9)), at(cum(2), local(20, 9, 30))));
  h.advance(MIN);
  h.feed(cum(3)); // 实时到达，本机 10:01（本机快 30 秒，服务端是 10:00:30）
  h.render();
  // 紧接着断线，之后两轮在服务端 10:00:40、10:00:50 结束，重连后一次补拉回来：按时间戳比它们在实时那轮之前
  h.advance(2 * MIN);
  h.feed(history(at(cum(3.5), local(20, 10) + 40000), at(cum(4), local(20, 10) + 50000)));
  h.render();
  near(h.ctm.totals().cost, 4);
  assert.equal(h.ctm.runs().length, 1);
  near(h.ctm.usage('day').cost, 4);
});

test('一轮进行中刷新页面、历史比实时数据晚到：这一轮已经发出的请求照样算进还没结束的部分', () => {
  const h = load({ now: local(20, 10) });
  h.feed(assistant('msg_live', { input: 20, cacheRead: 60000 }));
  h.advance(5000);
  h.feed(history(at(cum(0.5), local(20, 9, 50)), at(cum(1), local(20, 9, 59))));
  const t = h.ctm.totals();
  assert.equal(t.approx, true);
  assert.equal(t.input, 30);
  assert.equal(t.cacheRead, 110000);
});

test('一个页面里混着两个 CLI 会话的 result（交替出现，比如频道页）：各自分段，不拿两个会话的累计值相减', () => {
  const h = load({ now: local(20, 10), path: CHAN });
  for (const [c, sid] of [[1, 'cli-x'], [5, 'cli-y'], [2, 'cli-x'], [6, 'cli-y']]) {
    h.advance(MIN);
    h.feed(cum(c, sid));
  }
  h.render();
  near(h.ctm.totals().cost, 8);
  near(h.ctm.usage('day').cost, 8);
  assert.equal(h.ctm.usage('day').turns, 4);
});

test('一个标签页最多留 10 个会话的状态，当前会话不会被挤掉', () => {
  const h = load({ now: local(20, 11) });
  h.feed(history(at(cum(1), local(20, 9)), at(cum(2), local(20, 10))));
  h.render();
  let others = 0;
  for (let i = 0; i < 12; i++) {
    const id = 'session_' + String(i).padStart(2, '0') + 'cccccccccccccccccc';
    h.feedFrom('/v1/code/sessions/' + id + '/events', history(at(cum(0.1 * (i + 1)), local(20, 10, i + 1))));
    h.render();
    others += 0.1 * (i + 1);
  }
  assert.equal(h.ctm.diagnostics().counts.sessions, 10);
  near(h.ctm.totals().cost, 2);
  // 当前会话还在：之后的一轮照样记账
  h.feed(history(at(cum(3), local(20, 11))));
  h.render();
  near(h.ctm.totals().cost, 3);
  assert.ok(Math.abs(h.ctm.usage('day').cost - (3 + others)) < 1e-6);
});
