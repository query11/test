// 会话累计：按 /clear 分段相加、去重、上一轮、对话内容里的 JSON
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, assistant, result } = require('./harness');

const OPUS = 'claude-opus-5-5';
const HAIKU = 'claude-haiku-5-5';

test('/clear 之后累计值从零重新开始：各段最后一条相加', () => {
  const h = load();
  h.feed(result({ [OPUS]: { output: 1000, cost: 1 } }));
  h.feed(result({ [OPUS]: { output: 3000, cost: 2.5 } }));
  h.feed({ type: 'conversation_reset', uuid: 'reset-1' });
  h.feed(result({ [OPUS]: { output: 500, cost: 0.4 } }));
  h.feed(result({ [OPUS]: { output: 1500, cost: 1.2 } }));
  const t = h.ctm.totals();
  assert.equal(t.runs, 2);
  assert.ok(Math.abs(t.cost - 3.7) < 1e-9, 'cost ' + t.cost);
  assert.equal(t.output, 4500);
});

test('累计值变小或某个模型的累计值不见了，也算新的一段', () => {
  const h = load();
  h.feed(result({ [OPUS]: { output: 1000, cost: 1 }, [HAIKU]: { output: 200, cost: 0.01 } }));
  h.feed(result({ [OPUS]: { output: 4000, cost: 3 } })); // Haiku 不见了：续接时没有存档
  const t = h.ctm.totals();
  assert.equal(t.runs, 2);
  assert.ok(Math.abs(t.cost - 4.01) < 1e-9, 'cost ' + t.cost);
  assert.deepEqual(Object.keys(t.models).sort(), ['Haiku 5.5', 'Opus 5.5']);
});

test('同一条 result 来了两次（同一个 uuid，或两个通道各一份）只算一次', () => {
  const h = load();
  const r = result({ [OPUS]: { output: 1000, cost: 1 } });
  h.feed(r, r, { ...r, uuid: 'other-channel' });
  const t = h.ctm.totals();
  assert.equal(t.runs, 1);
  assert.equal(t.cost, 1);
});

test('上一轮的输出和均速取同一段里相邻两条之差，包含子代理', () => {
  const h = load();
  h.feed(result({ [OPUS]: { output: 1000, cost: 1 } }, { apiMs: 10000, wallMs: 12000 }));
  // 这一轮主对话输出 500（result.usage 只含主对话），子代理又输出 2000
  const turn = { input_tokens: 10, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  h.feed(result({ [OPUS]: { output: 3500, cost: 2 } }, { apiMs: 35000, wallMs: 40000, turn }));
  const lt = h.ctm.lastTurn();
  assert.equal(lt.tokens, 2500);
  assert.equal(lt.ms, 25000);
  assert.equal(lt.speed, 100);
});

test('还没结束的这一轮：按事件累加并标成估算值', () => {
  const h = load();
  h.feed(result({ [OPUS]: { input: 100, output: 1000, cacheRead: 50000, cost: 1 } }));
  h.feed(assistant('msg_new', { input: 20, cacheRead: 60000, text: 'x'.repeat(380) }));
  const t = h.ctm.totals();
  assert.equal(t.approx, true);
  assert.equal(t.approxCost, true);
  assert.equal(t.input, 120);
  assert.equal(t.cacheRead, 110000);
  assert.ok(t.output > 1000 && t.output < 1300, 'output ' + t.output);
  assert.ok(t.cost > 1);
});

test('对话内容里看起来像事件的 JSON（比如读到的日志文件）不计入', () => {
  const h = load();
  h.feed(result({ [OPUS]: { output: 1000, cost: 1 } }));
  const fake = JSON.stringify(result({ [OPUS]: { output: 1e8, cost: 999 } }));
  h.feed({ type: 'user', uuid: 'u-1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: fake }] } });
  h.feed({ type: 'assistant', uuid: 'a-1', message: { id: 'msg_x', model: OPUS, content: [{ type: 'text', text: fake }] } });
  const t = h.ctm.totals();
  assert.equal(t.cost, 1);
  assert.equal(t.output, 1000);
});
