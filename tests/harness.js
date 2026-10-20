// 在 Node 里加载 userscript 做回归测试：桩掉用到的浏览器对象，时间由测试控制，不建 UI。
// 脚本照常挂钩、解析、计算；render() 在建 UI 之前就返回，所以只算状态不画面板。
const fs = require('fs');
const path = require('path');

// CTM_SCRIPT 可以指向别的版本（比如 git show 出来的旧版），看用例在旧版上是否失败
const SRC = fs.readFileSync(process.env.CTM_SCRIPT || path.join(__dirname, '..', 'claude-token-meter.user.js'), 'utf8');

// opts.now：起始时间（毫秒）；opts.storage：预置的 localStorage；opts.path：页面路径（会话）
function load(opts = {}) {
  const clock = { now: opts.now || Date.parse('2026-10-20T02:00:00Z'), perf: 1000 };
  const store = new Map(Object.entries(opts.storage || {}));
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
  };
  const window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
  const document = {
    readyState: 'loading', // DOMContentLoaded 不会来，所以不建 UI
    addEventListener() {},
    body: null,
    documentElement: {},
    visibilityState: 'visible',
    cookie: '',
  };
  const location = { pathname: opts.path || '/code/session_0123456789abcdefghij' };
  const history = { pushState() {}, replaceState() {} };
  const performance = { now: () => clock.perf };
  const FakeDate = class extends Date {
    static now() {
      return clock.now;
    }
  };
  const ticks = [];
  const run = new Function(
    'window', 'localStorage', 'document', 'location', 'history', 'performance',
    'setInterval', 'setTimeout', 'requestAnimationFrame', 'Date',
    SRC
  );
  run(window, localStorage, document, location, history, performance, (f) => ticks.push(f), () => 0, () => 0, FakeDate);
  const ctm = window.__ctm;
  return {
    ctm,
    clock,
    store,
    // 脚本每 500ms 刷新一次（setInterval(render)）；测试里手动推进
    render: () => ticks[0](),
    advance(ms) {
      clock.now += ms;
      clock.perf += ms;
    },
    // 推进时间，期间每 500ms 刷新一次，和页面上一样
    wait(ms) {
      for (let t = 0; t < ms; t += 500) {
        this.advance(Math.min(500, ms - t));
        this.render();
      }
    },
    feed(...objs) {
      for (const o of objs) ctm.ingest(JSON.stringify(o));
    },
  };
}

// ---------------------------------------------------------------- 事件构造：Claude Code stream-json 的形状

let seq = 0;
const uid = (p) => p + '-' + ++seq;

// 实时流里包着 Anthropic API 流式事件的 stream_event；lane 为子代理的 parent_tool_use_id
const streamEvent = (event, lane = null) => ({ type: 'stream_event', uuid: uid('se'), parent_tool_use_id: lane, event });

const messageStart = (id, { model = 'claude-opus-5-5', input = 5, cacheRead = 0, cacheWrite = 0, lane = null } = {}) =>
  streamEvent(
    {
      type: 'message_start',
      message: { id, model, usage: { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, output_tokens: 1 } },
    },
    lane
  );
const blockStart = (index, type, lane) => streamEvent({ type: 'content_block_start', index, content_block: { type } }, lane);
const textDelta = (text, lane) => streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } }, lane);
const messageDelta = (output, lane) => streamEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: output } }, lane);
const messageStop = (lane) => streamEvent({ type: 'message_stop' }, lane);

// 完整的 assistant 消息（历史记录里、或每次请求结束时的那一条）
function assistant(id, { model = 'claude-opus-5-5', input = 5, cacheRead = 0, cacheWrite = 0, ttl = '1h', lane = null, timestamp, text = '' } = {}) {
  const cc = cacheWrite ? { [ttl === '5m' ? 'ephemeral_5m_input_tokens' : 'ephemeral_1h_input_tokens']: cacheWrite } : undefined;
  return {
    type: 'assistant',
    uuid: uid('a'),
    ...(timestamp ? { timestamp: new Date(timestamp).toISOString() } : {}),
    parent_tool_use_id: lane,
    message: {
      id,
      model,
      content: text ? [{ type: 'text', text }] : [],
      usage: { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, output_tokens: 2, cache_creation: cc },
    },
  };
}

// result：modelUsage / total_cost_usd 是这段运行的累计值。usage 是 { 模型: { input, output, cacheRead, cacheWrite, cost } }
function result(usage, { apiMs = 0, wallMs = 0, timestamp, turn } = {}) {
  const modelUsage = {};
  let cost = 0;
  for (const [model, u] of Object.entries(usage)) {
    modelUsage[model] = {
      inputTokens: u.input || 0,
      outputTokens: u.output || 0,
      cacheReadInputTokens: u.cacheRead || 0,
      cacheCreationInputTokens: u.cacheWrite || 0,
      costUSD: u.cost || 0,
      contextWindow: 1000000,
    };
    cost += u.cost || 0;
  }
  return {
    type: 'result',
    subtype: 'success',
    uuid: uid('r'),
    ...(timestamp ? { timestamp: new Date(timestamp).toISOString() } : {}),
    total_cost_usd: cost,
    duration_api_ms: apiMs,
    duration_ms: wallMs,
    usage: turn || { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage,
  };
}

// rate_limit_event：已用比例 0~1，重置时间为 unix 秒
const rateLimit = (windows) => ({
  type: 'rate_limit_event',
  uuid: uid('rl'),
  rate_limit_info: {
    unifiedWindows: Object.fromEntries(Object.entries(windows).map(([name, [utilization, resetsAt]]) => [name, { utilization, resetsAt }])),
  },
});

// claude.ai 用量接口的旧格式：百分比 0~100、ISO 重置时间
const usageApi = (windows) =>
  Object.fromEntries(Object.entries(windows).map(([name, [percent, resetsAtMs]]) => [name, { utilization: percent, resets_at: new Date(resetsAtMs).toISOString() }]));

module.exports = { load, streamEvent, messageStart, blockStart, textDelta, messageDelta, messageStop, assistant, result, rateLimit, usageApi };
