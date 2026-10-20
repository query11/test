// 实时流：速度、等待状态、精确输出数
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, messageStart, blockStart, textDelta, messageDelta, messageStop, result } = require('./harness');

const SENTENCE = 'The quick brown fox jumps over the lazy dog. ';

// 一次请求：先思考 thinkMs（网页端看不到思考内容，没有任何增量），再输出 4 秒正文
function thinkThenAnswer(h, thinkMs, { id = 'msg_1', exact = 6000 } = {}) {
  h.feed(messageStart(id, { cacheRead: 400000 }), blockStart(0, 'thinking'));
  h.wait(thinkMs);
  const waiting = h.ctm.live;
  h.feed(blockStart(1, 'text'));
  let flowing = false;
  for (let i = 0; i < 40; i++) {
    h.advance(100);
    h.feed(textDelta(SENTENCE));
    if (i % 5 === 4) {
      h.render();
      flowing = flowing || h.ctm.live.flowing;
    }
  }
  h.feed(messageDelta(exact), messageStop());
  return { waiting, flowing, m: h.ctm.state.messages.get(id) };
}

test('思考不到 60 秒：实时速度和精确输出数都有', () => {
  const h = load();
  const { waiting, flowing, m } = thinkThenAnswer(h, 30000);
  assert.ok(waiting.active, '思考期间显示为请求进行中');
  assert.ok(flowing, '输出时显示为正在输出');
  assert.equal(m.exact, true);
  assert.equal(m.output, 6000);
  assert.ok(m.streamEst > 0);
  assert.equal(h.ctm.state.lastResp.exact, true);
});

test('思考超过 60 秒：之后的正文增量和精确输出数照样计入', () => {
  // 1.5.0 在 60 秒没动静时把这一路删掉，之后的增量和 message_delta 全被丢弃：
  // 圆点显示空闲、没有实时速度，输出停在占位值 1
  const h = load();
  const { waiting, flowing, m } = thinkThenAnswer(h, 70000);
  assert.equal(m.exact, true);
  assert.equal(m.output, 6000);
  assert.ok(m.streamEst > 0);
  assert.ok(waiting.active, '还没有输出时，思考 70 秒仍显示为请求进行中');
  assert.ok(flowing, '输出时显示为正在输出');
  const lr = h.ctm.state.lastResp;
  assert.equal(lr.tokens, 6000);
  // 有精确数时从 message_start 算起（含思考）：6000 / 74 秒
  assert.ok(lr.speed > 70 && lr.speed < 90, 'speed ' + lr.speed);
});

test('还没有输出时最多显示等待 10 分钟；更久之后来的增量仍然计入', () => {
  const h = load();
  h.feed(messageStart('msg_1'), blockStart(0, 'thinking'));
  h.wait(9 * 60000);
  assert.ok(h.ctm.live.active, '9 分钟时仍在等待');
  h.wait(2 * 60000);
  assert.equal(h.ctm.live.active, null, '11 分钟没有任何动静，不再显示为进行中');
  h.feed(blockStart(1, 'text'), textDelta(SENTENCE));
  h.render();
  assert.ok(h.ctm.live.flowing, '增量来了就恢复');
  h.feed(messageDelta(800), messageStop());
  assert.equal(h.ctm.state.messages.get('msg_1').output, 800);
});

test('输出过之后 60 秒没动静就不再显示为进行中，之后的增量照常计入', () => {
  const h = load();
  h.feed(messageStart('msg_1'), blockStart(1, 'text'), textDelta(SENTENCE));
  h.wait(59000);
  assert.ok(h.ctm.live.active, '59 秒时仍在进行中');
  h.wait(2000);
  assert.equal(h.ctm.live.active, null, '61 秒没动静（可能漏了 message_stop）');
  const before = h.ctm.state.messages.get('msg_1').streamEst;
  h.feed(textDelta(SENTENCE));
  h.render();
  assert.ok(h.ctm.live.flowing);
  assert.ok(h.ctm.state.messages.get('msg_1').streamEst > before);
});

test('漏了 message_stop、到 result 才关掉时，速度按最后一次增量算，不算上之后的空闲', () => {
  const h = load();
  h.feed(messageStart('msg_1'), blockStart(1, 'text'));
  for (let i = 0; i < 40; i++) {
    h.advance(100);
    h.feed(textDelta(SENTENCE));
  }
  h.feed(messageDelta(1000)); // 没有 message_stop
  h.wait(5 * 60000);
  h.feed(result({ 'claude-opus-5-5': { output: 1000, cost: 0.1 } }));
  const lr = h.ctm.state.lastResp;
  assert.equal(lr.tokens, 1000);
  // 4 秒输出 + 至多 1.5 秒收尾；不能是 1000 / 304 秒
  assert.ok(lr.speed > 150, 'speed ' + lr.speed);
  assert.equal(h.ctm.state.lanes.size, 0, 'result 之后不再有进行中的请求');
});

test('出错的一轮（result 是全零值）也算结束：不再显示等待', () => {
  // 还没有输出时最多显示等待 10 分钟，所以全零的 result 也要关掉进行中的请求
  const h = load();
  h.feed(messageStart('msg_1'), blockStart(0, 'thinking'));
  h.wait(5000);
  assert.ok(h.ctm.live.active);
  h.feed({ type: 'result', subtype: 'error_during_execution', is_error: true, uuid: 'r-err', total_cost_usd: 0, modelUsage: {} });
  h.render();
  assert.equal(h.ctm.live.active, null);
  assert.equal(h.ctm.state.lanes.size, 0);
  assert.equal(h.ctm.totals().runs, 0, '全零的 result 不计入');
});

test('子代理和主对话各走各的：一路结束不影响另一路', () => {
  const h = load();
  const sub = 'toolu_01';
  h.feed(messageStart('msg_main'), blockStart(1, 'text'));
  h.feed(messageStart('msg_sub', { lane: sub }), blockStart(1, 'text', sub));
  for (let i = 0; i < 10; i++) {
    h.advance(100);
    h.feed(textDelta(SENTENCE), textDelta(SENTENCE, sub));
  }
  h.feed(messageDelta(300, sub), messageStop(sub));
  assert.ok(h.ctm.state.lanes.has('main'), '子代理结束后主对话仍在进行');
  h.feed(textDelta(SENTENCE), messageDelta(400), messageStop());
  const main = h.ctm.state.messages.get('msg_main');
  const s = h.ctm.state.messages.get('msg_sub');
  assert.equal(main.output, 400);
  assert.equal(main.lane, 'main');
  assert.equal(s.output, 300);
  assert.equal(s.lane, sub);
  assert.ok(main.streamEst > s.streamEst, '主对话多收了一段增量');
});
