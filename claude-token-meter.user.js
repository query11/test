// ==UserScript==
// @name         Claude Token Meter
// @namespace    https://github.com/query11/test
// @version      1.3.0
// @description  在 claude.ai（含 Claude Code 网页端 claude.ai/code）实时显示 token 用量与生成速度
// @match        https://claude.ai/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * 原理：在页面上下文里挂钩 fetch / XMLHttpRequest / WebSocket / EventSource，
 * 从流经的数据里识别 Claude Code stream-json（以及 Anthropic API 流式）事件：
 *   - type:"result" 的 modelUsage / total_cost_usd → 会话累计用量与费用。CLI 的文档说明这两个字段是
 *     截至目前的累计值，应取最新一条而不是相加
 *   - type:"assistant" 的 message.usage             → 本轮还没结束时的输入/缓存用量（按 message.id 去重）。
 *     其中的 output_tokens 只是请求刚开始时的占位值（个位数），输出量改按正文长度估算
 *   - stream_event 包着的 message_start / content_block_delta / message_delta / message_stop
 *                                                    → 实时速度；message_delta 带精确输出数，用来校准估算
 *   - result.usage.output_tokens 与 duration_api_ms 的增量 → 上一轮的平均速度
 *   - get_context_usage 的响应                        → 上下文占用（网页端查询上下文时才有）
 *   - rate_limit_event 的 unifiedWindows             → 订阅额度（5 小时 / 7 天窗口的已用比例与重置时间）
 * 历史记录（一次加载多条）只计入用量，不计入速度。思考内容在网页端不可见，只能从精确数里看到。
 *
 * 控制台可用：__ctm.state 查看状态，__ctm.debug(true) 打印抓到的数据。
 */
(function () {
  'use strict';

  const W = window;
  if (W.__ctm) return;

  const FLOW_MS = 1500; // 这么久内收到过 token 视为“正在输出”
  const STALE_MS = 60000; // 流式请求这么久没动静就当作已结束（防止漏掉 message_stop）
  const SPEED_WINDOW_MS = 2000; // 实时速度的滑动窗口
  const HISTORY_AGE_MS = 600000; // 带时间戳且早于 10 分钟的事件视为历史（留出本机时钟误差）
  const SPARK_POINTS = 120; // 速度曲线保留的点数（每 500ms 一个）

  const lsGet = (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  };
  const lsSet = (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  };

  let debug = lsGet('ctm-debug') === '1';
  const log = (...a) => debug && console.log('[token-meter]', ...a);

  // ---------------------------------------------------------------- state

  function freshState() {
    return {
      seen: new Set(), // 已处理的事件 uuid
      seq: 0, // 到达顺序
      messages: new Map(), // message id -> 见 messageRecord()
      results: [], // result 快照，按先后排序
      readings: [], // 本会话收到的额度读数，用来估算额度折合多少钱
      lanes: new Map(), // 正在流式输出的请求：主对话为 'main'，子代理按 parent_tool_use_id 区分
      ctxUsage: null, // get_context_usage 的响应
      lastResp: null,
      samples: [], // [timestamp, tokens]
      spark: [],
      peak: 0,
      calib: 1, // 估算 → 精确 token 的校准系数
      anon: 0,
    };
  }
  let state = freshState();
  let dirty = true;

  function reset() {
    const calib = state.calib;
    state = freshState();
    state.calib = calib;
    quotaCache = null;
    dirty = true;
  }

  // ---------------------------------------------------------------- 先后顺序

  // 每条记录带 live（实时到达而非历史加载）、到达序号 seq 和 ts（事件自带的时间戳，可能没有）。
  // 实时事件按到达顺序；历史记录常常是倒序加载的，只能看时间戳。
  function stamp(ctx, fallbackTs) {
    return { ts: ctx.ts || fallbackTs || 0, live: !ctx.bulk, seq: ++state.seq };
  }

  // a 是否确定晚于 b；判断不了时返回 false
  function isAfter(a, b) {
    if (a.live && b.live) return a.seq > b.seq;
    if (a.live !== b.live) return a.live;
    return !!(a.ts && b.ts) && a.ts > b.ts;
  }

  // 排序用；先后判断不了时按 weight（累计值、上下文这类一般只增不减的量）
  function compare(a, b, weight) {
    if (isAfter(a, b)) return 1;
    if (isAfter(b, a)) return -1;
    return weight(a) - weight(b);
  }

  // ---------------------------------------------------------------- token 计数

  function estimateTokens(s) {
    let ascii = 0;
    let cjk = 0;
    let other = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 128) ascii++;
      else if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xff00 && c <= 0xffef)) cjk++;
      else other++;
    }
    return (ascii / 3.8 + cjk * 0.9 + other * 0.5) * state.calib;
  }

  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);

  function messageRecord(id, ctx, lane) {
    let m = state.messages.get(id);
    if (!m) {
      m = {
        ...stamp(ctx),
        lane: lane || 'main',
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        exact: false, // output 是否来自 message_delta 的精确值
        streamEst: 0, // 按流式增量估算的输出
        blockEst: 0, // 按 assistant 事件正文估算的输出
        sig: 0, // 思考块签名的字符数，和看不见的思考 token 数大致成正比
        blocks: new Set(),
      };
      state.messages.set(id, m);
      if (ctx.batch) ctx.batch.push(m);
    } else if (!m.ts && ctx.ts) m.ts = ctx.ts;
    return m;
  }

  function recordUsage(m, u, exact) {
    m.input = Math.max(m.input, num(u.input_tokens));
    m.output = Math.max(m.output, num(u.output_tokens));
    m.cacheRead = Math.max(m.cacheRead, num(u.cache_read_input_tokens));
    m.cacheWrite = Math.max(m.cacheWrite, num(u.cache_creation_input_tokens));
    if (exact && num(u.output_tokens)) m.exact = true;
    dirty = true;
  }

  const messageOutput = (m) => (m.exact ? m.output : Math.max(m.output, Math.round(Math.max(m.streamEst, m.blockEst))));
  const messageContext = (m) => m.input + m.cacheRead + m.cacheWrite;
  const resultWeight = (r) => r.cost || (r.totals ? r.totals.output : 0);

  function blockText(b) {
    if (!b) return '';
    if (b.type === 'text') return b.text || '';
    if (b.type === 'thinking') return b.thinking || ''; // 网页端通常只给签名，正文为空
    if (b.type === 'tool_use' || b.type === 'server_tool_use') return JSON.stringify(b.input || {});
    return '';
  }

  function recordResult(o, ctx) {
    const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let window = 0;
    let models = 0;
    for (const name in o.modelUsage || {}) {
      const x = o.modelUsage[name] || {};
      totals.input += num(x.inputTokens);
      totals.output += num(x.outputTokens);
      totals.cacheRead += num(x.cacheReadInputTokens);
      totals.cacheWrite += num(x.cacheCreationInputTokens);
      window = Math.max(window, num(x.contextWindow));
      models++;
    }
    const cost = num(o.total_cost_usd);
    if (!models && !cost) return; // 出错或空操作的 result 带的是全零值
    const u = o.usage || {};
    // result 自身没有时间戳时，用“本轮开始时间 + 本轮耗时”推出结束时间
    const end = num(o.turn_started_wall_ms) && num(o.duration_ms) ? o.turn_started_wall_ms + o.duration_ms : 0;
    const r = {
      ...stamp(ctx, end),
      cost,
      totals: models ? totals : null,
      window,
      turnOut: num(u.output_tokens),
      // 本轮的用量（不是累计值）
      turn: {
        input: num(u.input_tokens),
        output: num(u.output_tokens),
        cacheRead: num(u.cache_read_input_tokens),
        cacheWrite: num(u.cache_creation_input_tokens),
      },
      apiMs: num(o.duration_api_ms),
      wallMs: num(o.duration_ms),
    };
    state.results.push(r);
    if (ctx.batch) ctx.batch.push(r);
    state.results.sort((a, b) => compare(a, b, resultWeight));
    dirty = true;
  }

  // ---------------------------------------------------------------- 实时流

  const laneOf = (ctx) => ctx.lane || 'main';

  function closeLane(lane, end) {
    const s = state.lanes.get(lane);
    if (!s) return;
    state.lanes.delete(lane);
    if (s.bulk || !s.last) return;
    // 有精确数（含看不见的思考）时从 message_start 算起，否则只算可见增量的时间
    const tokens = s.exact || s.est;
    const dur = ((s.exact ? end || s.last : s.last) - (s.exact ? s.t0 : s.first)) / 1000;
    state.lastResp = { tokens, speed: dur > 0.3 ? tokens / dur : null, exact: !!s.exact };
    dirty = true;
  }

  // ---------------------------------------------------------------- 订阅额度

  // [完整名称, 简称]；未列出的窗口直接显示原名
  const LIMIT_NAMES = {
    five_hour: ['5 小时额度', '5h'],
    seven_day: ['7 天额度', '7d'],
    seven_day_opus: ['7 天 Opus', '7d Opus'],
    seven_day_sonnet: ['7 天 Sonnet', '7d Sonnet'],
    seven_day_overage_included: ['7 天（含超额）', '7d+'],
  };

  // 额度是账号级的，不随会话清零，并存进 localStorage：刷新页面、打开别的会话时也能立刻显示。
  // name -> { utilization: 已用比例（通常 0~1）, resetsAt: 重置时间（unix 秒）, status }
  let limits = {};
  try {
    limits = JSON.parse(lsGet('ctm-limits') || '{}') || {};
  } catch {}

  function windowsOf(info) {
    const windows = { ...(info.unifiedWindows || {}) };
    // 顶层字段描述的是当前起限制作用的那个窗口（旧版 CLI 只有这一份），可能是 overage 这类不是额度窗口的类型
    if (LIMIT_NAMES[info.rateLimitType] && !windows[info.rateLimitType] && info.resetsAt) {
      windows[info.rateLimitType] = { utilization: info.utilization, resetsAt: info.resetsAt };
    }
    return windows;
  }

  // 记下本会话看到的每个读数及其先后，估算额度折合多少钱时要和会话的花费对齐
  function recordReadings(info, ctx) {
    if (!info || typeof info !== 'object') return;
    const windows = windowsOf(info);
    for (const name in windows) {
      const w = windows[name] || {};
      if (!num(w.resetsAt)) continue;
      const q = { ...stamp(ctx), name, resetsAt: num(w.resetsAt), u: num(w.utilization) };
      state.readings.push(q);
      if (ctx.batch) ctx.batch.push(q);
    }
  }

  // 同一窗口内用量只增不减，所以不论事件先后，同一 resetsAt 取最大值；resetsAt 更晚的是新窗口
  function recordLimits(info) {
    if (!info || typeof info !== 'object') return;
    const windows = windowsOf(info);
    let changed = false;
    for (const name in windows) {
      const w = windows[name] || {};
      const resetsAt = num(w.resetsAt);
      if (!resetsAt) continue;
      const utilization = num(w.utilization);
      const cur = limits[name];
      const same = !!cur && Math.abs(resetsAt - cur.resetsAt) <= 60;
      if (cur && (same ? utilization < cur.utilization : resetsAt < cur.resetsAt)) continue;
      const status = w.status || (name === info.rateLimitType ? info.status : same ? cur.status : undefined);
      if (same && utilization === cur.utilization && status === cur.status) continue;
      limits[name] = { utilization, resetsAt, status };
      changed = true;
    }
    if (changed) {
      lsSet('ctm-limits', JSON.stringify(limits));
      dirty = true;
    }
  }

  // 其他 claude.ai 标签页看到的额度也合并进来
  W.addEventListener('storage', (e) => {
    if (e.key !== 'ctm-limits' || !e.newValue) return;
    try {
      recordLimits({ unifiedWindows: JSON.parse(e.newValue) });
    } catch {}
  });

  // ---------------------------------------------------------------- 事件识别

  function tsOf(o) {
    const v = o.timestamp ?? o.created_at ?? o.createdAt;
    if (v == null || typeof v === 'object') return 0;
    const t = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v);
    return isFinite(t) && t > 0 ? t : 0;
  }

  function handle(o, ctx) {
    switch (o.type) {
      case 'message_start': {
        const msg = o.message || {};
        const lane = laneOf(ctx);
        closeLane(lane);
        const m = messageRecord(msg.id || 'anon-' + ++state.anon, ctx, lane);
        if (msg.usage) recordUsage(m, msg.usage, false);
        state.lanes.set(lane, { m, bulk: ctx.bulk, t0: performance.now(), first: 0, last: 0, est: 0, exact: 0, thinking: false });
        return true;
      }
      case 'content_block_start': {
        const s = state.lanes.get(laneOf(ctx));
        const t = o.content_block && o.content_block.type;
        if (s && (t === 'thinking' || t === 'redacted_thinking')) s.thinking = true;
        return true;
      }
      case 'content_block_delta': {
        const s = state.lanes.get(laneOf(ctx));
        const d = o.delta || {};
        const txt = d.text ?? d.thinking ?? d.partial_json ?? '';
        if (!s || s.bulk || ctx.bulk || !txt) return true;
        const n = estimateTokens(txt);
        const now = performance.now();
        if (!s.first) s.first = now;
        s.last = now;
        s.est += n;
        s.m.streamEst = s.est;
        state.samples.push([now, n]);
        dirty = true;
        return true;
      }
      case 'message_delta': {
        const s = state.lanes.get(laneOf(ctx));
        if (!s || !o.usage) return true;
        recordUsage(s.m, o.usage, true);
        const exact = num(o.usage.output_tokens);
        if (exact && !s.bulk && !ctx.bulk) {
          // 有思考的请求，精确数里包含看不见的思考 token，不能拿来校准
          if (!s.thinking && s.est > 20) {
            const ratio = exact / (s.est / state.calib);
            if (ratio > 0.2 && ratio < 5) state.calib = state.calib * 0.7 + ratio * 0.3;
          }
          s.exact = exact;
        }
        return true;
      }
      case 'message_stop':
        closeLane(laneOf(ctx), performance.now());
        return true;
      case 'assistant': {
        const msg = o.message;
        if (!msg || !msg.usage) return true;
        const m = messageRecord(msg.id || o.uuid, ctx, o.parent_tool_use_id || 'main');
        recordUsage(m, msg.usage, false);
        for (const b of msg.content || []) {
          if (!b) continue;
          const s = blockText(b);
          const signature = b.type === 'thinking' ? b.signature || '' : b.type === 'redacted_thinking' ? b.data || '' : '';
          const key = b.id || b.type + ':' + (s.length + signature.length) + ':' + (s || signature).slice(0, 40);
          if ((!s && !signature) || m.blocks.has(key)) continue;
          m.blocks.add(key);
          if (s) m.blockEst += estimateTokens(s);
          m.sig += signature.length;
        }
        return true;
      }
      case 'result':
        recordResult(o, ctx);
        return true;
      case 'rate_limit_event':
        recordLimits(o.rate_limit_info);
        recordReadings(o.rate_limit_info, ctx);
        return true;
      default: {
        if (o.rate_limit_info && typeof o.rate_limit_info === 'object') {
          recordLimits(o.rate_limit_info);
          recordReadings(o.rate_limit_info, ctx);
          return true;
        }
        if (typeof o.totalTokens === 'number' && typeof o.maxTokens === 'number' && 'percentage' in o) {
          state.ctxUsage = { ...stamp(ctx), used: o.totalTokens, max: o.maxTokens };
          dirty = true;
          return true;
        }
        const u = o.usage;
        if (u && typeof u === 'object' && ('output_tokens' in u || 'input_tokens' in u) && (o.id || o.uuid)) {
          recordUsage(messageRecord(o.id || o.uuid, ctx, 'main'), u, false);
          return true;
        }
        return false;
      }
    }
  }

  function walk(o, ctx, depth) {
    if (!o || typeof o !== 'object' || depth > 12) return;
    if (Array.isArray(o)) {
      for (const v of o) walk(v, ctx, depth + 1);
      return;
    }
    if (typeof o.uuid === 'string' && o.type) {
      if (state.seen.has(o.uuid)) return;
      if (state.seen.size > 100000) state.seen.clear();
      state.seen.add(o.uuid);
    }
    const ts = tsOf(o);
    if (ts || o.type === 'stream_event') {
      ctx = { ...ctx };
      if (ts) {
        ctx.ts = ts;
        if (Date.now() - ts > HISTORY_AGE_MS) ctx.bulk = true;
      }
      if (o.type === 'stream_event') ctx.lane = o.parent_tool_use_id || 'main';
    }
    if (o.type && debug) log(ctx.bulk ? '(history)' : '(live)', o.type, o.event?.type || o.delta?.type || '');
    if (handle(o, ctx)) return;
    for (const k in o) {
      const v = o[k];
      if (v && typeof v === 'object') walk(v, ctx, depth + 1);
      else if (typeof v === 'string' && v.length > 20 && (v[0] === '{' || v[0] === '[') && /tokens|delta|_start|_stop|rate_limit/i.test(v)) {
        try {
          walk(JSON.parse(v), ctx, depth + 1);
        } catch {}
      }
    }
  }

  // 一次带来多条 assistant/user/result 的数据视为历史记录加载
  function countTurns(o, depth, acc) {
    if (!o || typeof o !== 'object' || depth > 8 || acc.n > 2) return;
    if (Array.isArray(o)) {
      for (const v of o) countTurns(v, depth + 1, acc);
      return;
    }
    if (o.type === 'assistant' || o.type === 'user' || o.type === 'result') acc.n++;
    for (const k in o) if (o[k] && typeof o[k] === 'object') countTurns(o[k], depth + 1, acc);
  }

  function ingestObj(obj, src) {
    const acc = { n: 0 };
    countTurns(obj, 0, acc);
    const bulk = acc.n > 2;
    const batch = bulk ? [] : null; // 这批历史记录里新建的记录，按出现顺序
    walk(obj, { bulk, src, batch }, 0);
    if (batch) fillBatchTimes(batch);
  }

  // 历史记录里有些事件自己没有时间戳（比如 rate_limit_event）。同一批数据里事件的先后是可靠的，
  // 只是可能整体倒序，所以按位置借用前一个事件的时间戳，排在它后面
  function fillBatchTimes(batch) {
    const timed = batch.filter((x) => x.ts);
    if (timed.length < 2) return;
    const list = timed[0].ts > timed[timed.length - 1].ts ? batch.slice().reverse() : batch;
    let last = 0;
    for (const x of list) {
      if (x.ts) last = x.ts;
      else if (last) x.ts = ++last; // 连续几个没有时间戳的事件依次排开
    }
  }

  function ingestLine(line, src) {
    line = line.trim();
    if (line.startsWith('data:')) line = line.slice(5).trim();
    if (line[0] !== '{' && line[0] !== '[') return;
    try {
      ingestObj(JSON.parse(line), src);
    } catch {}
  }

  function ingestText(text, src) {
    if (typeof text !== 'string' || !text || text.length > 50e6) return;
    if (!/tokens|_delta|_start|_stop|rate_limit/i.test(text)) return; // message_stop、content_block_start、rate_limit_event 里没有 tokens
    try {
      ingestObj(JSON.parse(text), src);
      return;
    } catch {}
    for (const line of text.split('\n')) ingestLine(line, src);
  }

  function safe(fn) {
    return function () {
      try {
        return fn.apply(this, arguments);
      } catch (e) {
        log('error', e);
      }
    };
  }

  // ---------------------------------------------------------------- 统计

  function sessionTotals() {
    let base = null; // 最新一条带 modelUsage 的 result
    for (let i = state.results.length - 1; i >= 0 && !base; i--) if (state.results[i].totals) base = state.results[i];
    const t = base ? { ...base.totals } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    t.approx = false;
    for (const m of state.messages.values()) {
      if (base && !isAfter(m, base)) continue; // 已计入 result 的累计值
      t.input += m.input;
      t.output += messageOutput(m);
      t.cacheRead += m.cacheRead;
      t.cacheWrite += m.cacheWrite;
      if (!m.exact) t.approx = true;
    }
    return t;
  }

  // 上一轮：输出 token 数与平均速度
  function lastTurn() {
    const rs = state.results;
    const cur = rs[rs.length - 1];
    if (!cur) return null;
    const prev = rs[rs.length - 2];
    // usage.output_tokens 应是本轮值；再和累计值之差取小者，哪种语义都不会算多
    const delta = prev && prev.totals && cur.totals ? cur.totals.output - prev.totals.output : 0;
    const tokens = cur.turnOut > 0 && delta > 0 ? Math.min(cur.turnOut, delta) : cur.turnOut || Math.max(delta, 0);
    if (!tokens) return null;
    // duration_api_ms 是累计 API 耗时：优先取与上一条之差；本轮 API 耗时不会明显超过本轮总耗时
    // （留 10% 余量：轮次之间的后台小请求会被算进下一轮）
    for (const ms of [prev ? cur.apiMs - prev.apiMs : 0, cur.apiMs]) {
      if (ms > 0 && (!cur.wallMs || ms <= cur.wallMs * 1.1)) return { tokens, ms, speed: tokens / (ms / 1000) };
    }
    return { tokens, ms: 0, speed: null };
  }

  // 当前上下文：主对话最近一次请求的输入（含缓存）
  function contextNow() {
    let best = null;
    const consider = (x, used) => {
      if (used > 0 && (!best || isAfter(x, best.x) || (!isAfter(best.x, x) && used > best.used))) best = { x, used };
    };
    for (const m of state.messages.values()) if (m.lane === 'main') consider(m, messageContext(m));
    if (state.ctxUsage) consider(state.ctxUsage, state.ctxUsage.used);
    const r = state.results[state.results.length - 1];
    const max = (state.ctxUsage && state.ctxUsage.max) || (r && r.window) || 0;
    return best ? { used: best.used, max } : null;
  }

  // ---------------------------------------------------------------- 额度折合多少钱

  // 思路：本会话每次请求花了多少钱是知道的；额度每涨一个百分点时会话累计花了多少，也能对上。
  // 相邻两次跳变之间的花费 ÷ 跳过的百分点数，就是“每 1% 折合多少美元”。这假设这段时间账号没有
  // 别处的使用，所以各段取中位数，偶尔混进别处的使用也不至于带偏。

  // 各类 token 的相对价格（以输入为 1）。只用来在一轮之内分摊花费，每轮总花费以 result 为准
  const PRICE_RATIO = { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 2 };
  const SIG_TOKENS = 0.24; // 思考签名每个字符大约对应的思考 token 数
  const weightOf = (x, out) =>
    x.input * PRICE_RATIO.input +
    out * PRICE_RATIO.output +
    x.cacheRead * PRICE_RATIO.cacheRead +
    x.cacheWrite * PRICE_RATIO.cacheWrite;
  // 实时事件按到达顺序排在所有历史记录之后；排不了序的历史记录不参与
  const orderKey = (x) => (x.live ? 1e15 + x.seq : x.ts || null);

  function weightedMedian(list) {
    // list: [[值, 权重]]
    list.sort((a, b) => a[0] - b[0]);
    const half = list.reduce((s, x) => s + x[1], 0) / 2;
    let acc = 0;
    for (let i = 0; i < list.length; i++) {
      acc += list[i][1];
      if (acc > half) return list[i][0];
      if (acc === half) return list[i + 1] ? (list[i][0] + list[i + 1][0]) / 2 : list[i][0];
    }
    return 0;
  }

  // 只看本会话：{ 窗口名: [每 1% 美元数, 依据的百分点数], sec: [模型运行秒数, 对应花费] }
  function sessionQuotaRates() {
    const items = [];
    for (const m of state.messages.values()) if (orderKey(m) != null) items.push([orderKey(m), 0, m]);
    for (const r of state.results) if (orderKey(r) != null) items.push([orderKey(r), 1, r]);
    for (const q of state.readings) if (orderKey(q) != null) items.push([orderKey(q), 2, q]);
    items.sort((a, b) => a[0] - b[0]);

    // 第一遍：按 result 分轮，把每轮的花费按 token 权重分到各次请求上
    const cost = new Map();
    let pending = [];
    let prev = null;
    let scale = 0; // 每单位权重折合的美元，用最近一轮校准，估算还没结束的这一轮
    let apiSec = 0;
    let apiCost = 0;
    for (const [, kind, x] of items) {
      if (kind === 0) pending.push(x);
      if (kind !== 1) continue;
      // 本轮花费优先用相邻两条 result 的累计费用之差；和按本轮用量算的差太多（漏了 result、/clear 过）就用后者
      const unit = x.totals ? x.cost / weightOf(x.totals, x.totals.output) : 0;
      const byUsage = unit * weightOf(x.turn, x.turn.output);
      let turnCost = prev && x.cost > prev.cost ? x.cost - prev.cost : 0;
      if (byUsage && !(turnCost > byUsage / 1.5 && turnCost < byUsage * 1.5)) turnCost = byUsage;
      // 本轮的输出数分到各次请求：有精确值的直接用，其余按正文长度和思考签名长度分
      const rest = Math.max(0, x.turnOut - pending.reduce((s, m) => s + (m.exact ? m.output : 0), 0));
      const share = (m) => (m.exact ? 0 : m.blockEst + SIG_TOKENS * m.sig + 1);
      const shares = pending.reduce((s, m) => s + share(m), 0);
      const w = pending.map((m) => weightOf(m, m.exact ? m.output : (rest * share(m)) / shares));
      const total = w.reduce((s, v) => s + v, 0);
      if (turnCost && total) {
        pending.forEach((m, i) => cost.set(m, (turnCost * w[i]) / total));
        scale = turnCost / total;
      }
      // 模型运行时间：duration_api_ms 是累计值，取差；本轮 API 时间不会明显超过本轮总时长
      for (const ms of [prev ? x.apiMs - prev.apiMs : 0, x.apiMs]) {
        if (turnCost && ms > 0 && (!x.wallMs || ms <= x.wallMs * 1.1)) {
          apiSec += ms / 1000;
          apiCost += turnCost;
          break;
        }
      }
      prev = x;
      pending = [];
    }
    if (scale) {
      for (const m of pending) {
        const out = m.exact ? m.output : Math.max(m.output, m.streamEst, m.blockEst + SIG_TOKENS * m.sig);
        cost.set(m, scale * weightOf(m, out));
      }
    }

    // 第二遍：每个读数对应的会话累计花费。读数在一次请求结束时发出，反映的是这次请求之前的用量
    const groups = {};
    let cum = 0;
    let before = 0;
    let afterResult = false;
    let gap = 0; // 遇到算不出花费的请求，之后的读数不能和之前的配对
    for (const [, kind, x] of items) {
      if (kind === 0) {
        if (!cost.has(x)) gap++;
        before = cum;
        cum += cost.get(x) || 0;
        afterResult = false;
      } else if (kind === 1) afterResult = true;
      else (groups[x.name + '@' + Math.round(x.resetsAt / 600)] ||= []).push([x.u, afterResult ? cum : before, gap]);
    }

    // 同一窗口里相邻两次“用量涨了一格”之间：花费差 ÷ 涨过的百分点数
    const samples = {};
    for (const key in groups) {
      const name = key.split('@')[0];
      let prevU = null;
      let step = null;
      for (const [u, c, g] of groups[key]) {
        if (prevU != null && u > prevU) {
          const pts = step && step[2] === g ? Math.round((u - step[0]) * 100) : 0;
          if (pts > 0 && c > step[1]) (samples[name] ||= []).push([(c - step[1]) / pts, pts, step[1], c]);
          step = [u, c, g];
        }
        prevU = u;
      }
    }
    // 别处的使用表现为“一次跳好几格、本会话却没花多少”，这种段的单价明显低于中位数。它同时影响所有
    // 窗口，但在 7 天这种粗刻度上看不出来，所以按会话花费的区间，把其他窗口里同一段也排除掉
    const outside = [];
    for (const name in samples) {
      const med = weightedMedian(samples[name].map(([v, w]) => [v, w]));
      for (const [v, w, c0, c1] of samples[name]) if (w > 1 && v < med / 2) outside.push([c0, c1]);
    }
    // 其余各段加权平均（等于总花费 ÷ 总百分点数）；单格的段有量化误差，前后会互相抵消
    const rates = {};
    for (const name in samples) {
      const kept = samples[name].filter(([, , c0, c1]) => !outside.some(([o0, o1]) => c0 < o1 && o0 < c1));
      const points = kept.reduce((s, x) => s + x[1], 0);
      if (points) rates[name] = [kept.reduce((s, [v, w]) => s + v * w, 0) / points, points];
    }
    if (apiCost) rates.sec = [apiSec, apiCost];
    return rates;
  }

  // 每个会话的估算按会话路径存进 localStorage，显示时把最近各会话的结果合起来，
  // 这样换到新会话也能立刻看到，用得越多越准
  let rateStore = {};
  try {
    rateStore = JSON.parse(lsGet('ctm-rates') || '{}') || {};
  } catch {}
  let quotaCache = null;
  let quotaAt = 0;
  W.addEventListener('storage', (e) => {
    if (e.key !== 'ctm-rates' || !e.newValue) return;
    try {
      rateStore = JSON.parse(e.newValue) || {};
      quotaCache = null;
      dirty = true;
    } catch {}
  });

  // { 窗口名: { perPoint: 每 1% 美元数, points: 依据的百分点数 }, secPerDollar: 每美元对应的模型运行秒数 }
  function quotaRates() {
    const now = Date.now();
    if (quotaCache && now - quotaAt < 3000) return quotaCache;
    quotaAt = now;
    const mine = sessionQuotaRates();
    const key = location.pathname;
    if (Object.keys(mine).length && JSON.stringify(mine) !== JSON.stringify(rateStore[key] && rateStore[key].r)) {
      rateStore[key] = { t: now, r: mine };
      // 只留最近 30 个会话、45 天以内的
      const keep = Object.keys(rateStore)
        .filter((k) => rateStore[k] && now - rateStore[k].t < 45 * 864e5)
        .sort((a, b) => rateStore[b].t - rateStore[a].t)
        .slice(0, 30);
      rateStore = Object.fromEntries(keep.map((k) => [k, rateStore[k]]));
      lsSet('ctm-rates', JSON.stringify(rateStore));
    }
    const acc = {};
    let sec = 0;
    let dollars = 0;
    for (const k in rateStore) {
      const r = (rateStore[k] && rateStore[k].r) || {};
      for (const name in r) {
        const [a, b] = r[name] || [];
        if (name === 'sec') {
          sec += num(a);
          dollars += num(b);
        } else if (num(a) > 0 && num(b) > 0) {
          const s = (acc[name] ||= { sum: 0, points: 0 });
          s.sum += a * b;
          s.points += b;
        }
      }
    }
    const out = {};
    for (const name in acc) out[name] = { perPoint: acc[name].sum / acc[name].points, points: acc[name].points };
    if (sec > 0 && dollars > 0) out.secPerDollar = sec / dollars;
    return (quotaCache = out);
  }

  // ---------------------------------------------------------------- 网络挂钩

  const TAP_TYPES = /json|event-stream|ndjson|text\/plain/i;
  const STREAM_TYPES = /event-stream|ndjson|jsonl/i;

  async function readStream(body, src) {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const i = buf.lastIndexOf('\n');
      if (i >= 0) {
        for (const line of buf.slice(0, i).split('\n')) safe(ingestLine)(line, src);
        buf = buf.slice(i + 1);
      }
    }
    if (buf) safe(ingestLine)(buf, src);
  }

  const origFetch = W.fetch;
  if (origFetch) {
    W.fetch = function (input) {
      const p = origFetch.apply(this, arguments);
      p.then(
        safe((res) => {
          const ct = res.headers.get('content-type') || '';
          if (!res.body || !TAP_TYPES.test(ct)) return;
          const url = typeof input === 'string' ? input : input && input.url;
          const copy = res.clone();
          log('fetch', ct, url);
          if (STREAM_TYPES.test(ct)) readStream(copy.body, url).catch(() => {});
          else copy.text().then(safe((t) => ingestText(t, url)), () => {});
        }),
        () => {}
      );
      return p;
    };
  }

  const XHR = W.XMLHttpRequest && W.XMLHttpRequest.prototype;
  if (XHR) {
    const origSend = XHR.send;
    XHR.send = function () {
      let pos = 0;
      let buf = '';
      const xhr = this;
      const pump = safe((final) => {
        if (xhr.responseType && xhr.responseType !== 'text') return;
        const txt = xhr.responseText || '';
        if (final && pos === 0) return ingestText(txt, 'xhr');
        buf += txt.slice(pos);
        pos = txt.length;
        const i = buf.lastIndexOf('\n');
        if (i >= 0) {
          for (const line of buf.slice(0, i).split('\n')) ingestLine(line, 'xhr');
          buf = buf.slice(i + 1);
        }
        if (final && buf) ingestLine(buf, 'xhr');
      });
      this.addEventListener('progress', () => {
        const ct = xhr.getResponseHeader('content-type') || '';
        if (STREAM_TYPES.test(ct)) pump(false);
      });
      this.addEventListener('load', () => pump(true));
      return origSend.apply(this, arguments);
    };
  }

  function ingestBinaryOrText(data, src) {
    if (typeof data === 'string') return ingestText(data, src);
    if (data instanceof ArrayBuffer) return ingestText(new TextDecoder().decode(data), src);
    if (typeof Blob !== 'undefined' && data instanceof Blob) data.text().then(safe((t) => ingestText(t, src)), () => {});
  }

  const OrigWS = W.WebSocket;
  if (OrigWS) {
    const WS = function (url, protocols) {
      const ws = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
      log('websocket', url);
      ws.addEventListener('message', safe((e) => ingestBinaryOrText(e.data, 'ws')));
      return ws;
    };
    WS.prototype = OrigWS.prototype;
    Object.setPrototypeOf(WS, OrigWS);
    W.WebSocket = WS;
  }

  const OrigES = W.EventSource;
  if (OrigES) {
    const origAdd = OrigES.prototype.addEventListener;
    const tap = safe((e) => ingestText(e.data, 'sse'));
    const ES = function (url, init) {
      const es = new OrigES(url, init);
      log('eventsource', url);
      es.__ctmTypes = new Set(['message']);
      origAdd.call(es, 'message', tap);
      return es;
    };
    // 具名 SSE 事件只有被监听时才能拿到，所以跟着页面一起监听
    OrigES.prototype.addEventListener = function (type, fn, opt) {
      if (this.__ctmTypes && !this.__ctmTypes.has(type) && type !== 'open' && type !== 'error') {
        this.__ctmTypes.add(type);
        origAdd.call(this, type, tap);
      }
      return origAdd.call(this, type, fn, opt);
    };
    ES.prototype = OrigES.prototype;
    Object.setPrototypeOf(ES, OrigES);
    W.EventSource = ES;
  }

  // 切换会话（SPA 路由变化）时清零
  let lastPath = location.pathname;
  const onNav = () => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      reset();
    }
  };
  for (const m of ['pushState', 'replaceState']) {
    const orig = history[m];
    history[m] = function () {
      const r = orig.apply(this, arguments);
      onNav();
      return r;
    };
  }
  W.addEventListener('popstate', onNav);

  // ---------------------------------------------------------------- UI

  const fmt = (n) => {
    n = Math.round(n || 0);
    if (n >= 1e6) return +(n / 1e6).toFixed(2) + 'M';
    if (n >= 1e4) return +(n / 1e3).toFixed(1) + 'k';
    return n.toLocaleString();
  };
  const fmtSpeed = (s) => (s == null ? '–' : s.toFixed(1));
  const fmtPct = (f) => Math.round(f * 100) + '%';
  const fmtCost = (c, short) => '$' + c.toFixed(short ? (c < 0.1 ? 3 : 2) : c >= 10 ? 2 : 4);
  const fmtUsd = (v, precise) => '$' + (precise ? v.toFixed(2) : v >= 10 ? Math.round(v).toLocaleString() : v.toFixed(1));
  const fmtHours = (h) => (h < 1 ? Math.max(1, Math.round(h * 60)) + ' 分钟' : (h < 10 ? h.toFixed(1) : Math.round(h)) + ' 小时');

  function fmtReset(sec) {
    const d = new Date(sec * 1000);
    const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((day(d) - day(new Date())) / 864e5);
    return days === 0 ? hm : days === 1 ? '明天 ' + hm : d.getMonth() + 1 + '/' + d.getDate() + ' ' + hm;
  }

  function fmtLeft(sec) {
    const m = Math.max(0, Math.round((sec * 1000 - Date.now()) / 60000));
    const d = Math.floor(m / 1440);
    const h = Math.floor((m % 1440) / 60);
    if (d) return (d + ' 天 ' + (h ? h + ' 小时' : '')).trim();
    return (h ? h + ' 小时 ' : '') + (m % 60) + ' 分钟';
  }

  // 颜色取自 dataviz 参考调色板：浅色、深色各自选定的墨色与表面色；状态色固定，不随主题变
  const THEMES = {
    light: {
      surface: 'rgba(252,252,251,0.96)',
      ink: '#0b0b0b',
      ink2: '#52514e',
      muted: '#898781',
      hair: 'rgba(11,11,11,0.10)',
      control: 'rgba(11,11,11,0.18)',
      shadow: '0 4px 16px rgba(0,0,0,0.12)',
      accent: '#2a78d6',
      trackAlpha: 0.18,
    },
    dark: {
      surface: 'rgba(26,26,25,0.94)',
      ink: '#f0efec',
      ink2: '#c3c2b7',
      muted: '#898781',
      hair: 'rgba(255,255,255,0.10)',
      control: 'rgba(255,255,255,0.18)',
      shadow: '0 4px 20px rgba(0,0,0,0.45)',
      accent: '#3987e5',
      trackAlpha: 0.28,
    },
  };
  const STATUS = { good: '#0ca30c', warning: '#fab219', critical: '#d03b3b' };
  let theme = THEMES.dark;
  let themeName = '';

  const tint = (hex, a) =>
    `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;

  // 返回颜色的亮度（0~1）；透明或解析不了时返回 null。用 1 像素画布换算，任何 CSS 颜色写法都能处理
  let probe = null;
  function luminance(color) {
    if (!probe) {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      probe = c.getContext('2d', { willReadFrequently: true });
    }
    probe.fillStyle = '#010203';
    probe.fillStyle = color;
    if (probe.fillStyle === '#010203') return null;
    probe.clearRect(0, 0, 1, 1);
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
    return a < 128 ? null : (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }

  // 看页面实际的背景色：claude.ai 的主题可以和系统设置不一样
  function pageIsDark() {
    for (const n of [document.body, document.documentElement]) {
      const l = n && luminance(getComputedStyle(n).backgroundColor);
      if (l != null) return l < 0.5;
    }
    const h = document.documentElement;
    const hint = h.className + ' ' + (h.dataset.theme || '') + ' ' + (h.dataset.mode || '');
    if (/\bdark\b/i.test(hint)) return true;
    if (/\blight\b/i.test(hint)) return false;
    return W.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function applyTheme(name) {
    if (name === themeName) return;
    themeName = name;
    theme = THEMES[name];
    for (const k in theme) if (typeof theme[k] === 'string') ui.root.style.setProperty('--ctm-' + k, theme[k]);
    ui.root.style.colorScheme = name;
    pillKey = '';
    dirty = true;
  }

  function el(tag, style, text) {
    const e = document.createElement(tag);
    if (style) Object.assign(e.style, style);
    if (text != null) e.textContent = text;
    return e;
  }

  const dot = () => el('span', { width: '8px', height: '8px', borderRadius: '50%', flex: 'none', transition: 'opacity .3s' });

  function addRow(parent, label, tip) {
    const row = el('div', { display: 'flex', justifyContent: 'space-between', gap: '8px' });
    const value = el('span', { color: 'var(--ctm-ink)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }, '–');
    row.append(el('span', { color: 'var(--ctm-ink2)', whiteSpace: 'nowrap' }, label), value);
    if (tip) row.title = tip;
    parent.append(row);
    return { row, value };
  }

  // 比例条：填充色表示程度（正常用强调色，偏高用警告色，接近上限用危险色），底槽是同一色调的浅色
  function meter(parent) {
    const track = el('div', { height: '4px', borderRadius: '2px', margin: '1px 0 5px', overflow: 'hidden' });
    const fill = el('div', { height: '100%', width: '0', borderRadius: '2px' });
    track.append(fill);
    parent.append(track);
    return { track, fill };
  }

  function setMeter(m, frac, level) {
    const color = level === 'normal' ? theme.accent : STATUS[level];
    m.fill.style.width = Math.max(0, Math.min(1, frac)) * 100 + '%';
    m.fill.style.background = color;
    m.track.style.background = tint(color, theme.trackAlpha);
  }

  const levelOf = (frac, warn, crit) => (frac >= crit ? 'critical' : frac >= warn ? 'warning' : 'normal');

  function limitViews() {
    const now = Date.now() / 1000;
    const order = Object.keys(LIMIT_NAMES);
    const rank = (name) => order.indexOf(name) + 1 || 99;
    return Object.keys(limits)
      .filter((name) => limits[name] && num(limits[name].resetsAt))
      .sort((a, b) => rank(a) - rank(b))
      .map((name) => {
        const l = limits[name];
        const expired = now >= l.resetsAt;
        const used = expired ? 0 : num(l.utilization);
        const level = expired
          ? 'normal'
          : l.status === 'rejected' || used >= 0.9
            ? 'critical'
            : l.status === 'allowed_warning' || used >= 0.75
              ? 'warning'
              : 'normal';
        const [label, short] = LIMIT_NAMES[name] || [name, name];
        return { name, label, short, used, expired, level, resetsAt: l.resetsAt };
      });
  }

  const ui = { limitRows: {} };
  let mode = lsGet('ctm-mode') === 'full' ? 'full' : 'compact';
  let pos = { h: 'right', x: 16, v: 'bottom', y: 16 }; // 贴着哪个角、离两边多远
  try {
    const p = JSON.parse(lsGet('ctm-anchor') || 'null');
    if (p && /^(left|right)$/.test(p.h) && /^(top|bottom)$/.test(p.v)) pos = { h: p.h, x: num(p.x), v: p.v, y: num(p.y) };
  } catch {}

  function applyPos() {
    const s = ui.root.style;
    s.left = s.right = s.top = s.bottom = 'auto';
    s[pos.h] = pos.x + 'px';
    s[pos.v] = pos.y + 'px';
  }

  // 窗口变小或面板展开后超出视口时临时收回来，不改保存的位置
  function keepInView() {
    const r = ui.root.getBoundingClientRect();
    const s = ui.root.style;
    s[pos.h] = Math.max(0, Math.min(pos.x, innerWidth - r.width)) + 'px';
    s[pos.v] = Math.max(0, Math.min(pos.y, innerHeight - r.height)) + 'px';
  }

  // 拖动移动；没拖动就当作点击
  function draggable(handle, onClick) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const r = ui.root.getBoundingClientRect();
      const sx = e.clientX;
      const sy = e.clientY;
      let moved = false;
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => {
        if (!moved && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 4) return;
        moved = true;
        const left = Math.min(Math.max(0, r.left + ev.clientX - sx), innerWidth - r.width);
        const top = Math.min(Math.max(0, r.top + ev.clientY - sy), innerHeight - r.height);
        Object.assign(ui.root.style, { left: left + 'px', top: top + 'px', right: 'auto', bottom: 'auto' });
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        if (!moved) return onClick && onClick();
        // 按离得最近的角保存位置，展开、收起时朝远离这个角的方向伸缩
        const b = ui.root.getBoundingClientRect();
        const h = b.left + b.width / 2 > innerWidth / 2 ? 'right' : 'left';
        const v = b.top + b.height / 2 > innerHeight / 2 ? 'bottom' : 'top';
        pos = {
          h,
          x: Math.round(h === 'right' ? innerWidth - b.right : b.left),
          v,
          y: Math.round(v === 'bottom' ? innerHeight - b.bottom : b.top),
        };
        lsSet('ctm-anchor', JSON.stringify(pos));
        applyPos();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
      e.preventDefault();
    });
  }

  function setMode(m) {
    mode = m;
    lsSet('ctm-mode', m);
    ui.pill.style.display = m === 'compact' ? 'flex' : 'none';
    ui.full.style.display = m === 'full' ? 'block' : 'none';
    ui.root.style.borderRadius = m === 'compact' ? '999px' : '10px';
    pillKey = '';
    paint(true);
    applyPos();
    keepInView();
  }

  function buildUI() {
    const root = el('div', {
      position: 'fixed',
      zIndex: '2147483647',
      background: 'var(--ctm-surface)',
      color: 'var(--ctm-ink)',
      font: '12px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
      border: '1px solid var(--ctm-hair)',
      boxShadow: 'var(--ctm-shadow)',
      userSelect: 'none',
      backdropFilter: 'blur(6px)',
    });
    ui.root = root;

    // 紧凑模式：一行摘要，点击展开
    ui.pill = el('div', {
      alignItems: 'center',
      gap: '6px',
      padding: '3px 10px',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
      fontVariantNumeric: 'tabular-nums',
    });
    ui.pill.tabIndex = 0;
    ui.pill.setAttribute('role', 'button');
    ui.pill.title = '速度（空闲时为上轮均速）· 上下文 · 订阅额度 · API 等价费用\n点击展开，拖动可移动';
    ui.pillDot = dot();
    ui.pillText = el('span', { display: 'flex', alignItems: 'center', gap: '5px' });
    ui.pill.append(ui.pillDot, ui.pillText);
    ui.pill.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      setMode('full');
    });
    draggable(ui.pill, () => setMode('full'));

    // 完整面板
    ui.full = el('div', { width: '240px' });
    const header = el('div', {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      padding: '6px 8px',
      cursor: 'move',
      borderBottom: '1px solid var(--ctm-hair)',
    });
    ui.dot = dot();
    const btn = (label, tip, onClick) => {
      const b = el('button', {
        background: 'transparent',
        color: 'var(--ctm-ink2)',
        border: '1px solid var(--ctm-control)',
        borderRadius: '4px',
        padding: '0 5px',
        font: 'inherit',
        cursor: 'pointer',
      }, label);
      b.title = tip;
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.addEventListener('click', onClick);
      return b;
    };
    ui.debugBtn = btn('dbg', '在控制台打印抓到的事件', () => {
      debug = !debug;
      lsSet('ctm-debug', debug ? '1' : '0');
      dirty = true;
    });
    header.append(
      ui.dot,
      el('span', { flex: '1', fontWeight: '600' }, 'Token Meter'),
      ui.debugBtn,
      btn('↺', '清零（订阅额度不清）', reset),
      btn('–', '收起成一行', () => setMode('compact'))
    );
    draggable(header);

    const body = el('div', { padding: '6px 10px 8px' });
    const sep = () => body.append(el('div', { borderTop: '1px solid var(--ctm-hair)', margin: '4px 0' }));
    const row = (key, label, tip) => {
      const r = addRow(body, label, tip);
      ui[key] = r.value;
      ui[key + 'Row'] = r.row;
    };
    row('speed', '实时速度', '最近 2 秒可见输出的速度（按字符估算，并用精确值自动校准）');
    row('cur', '当前请求', '正在流式输出的这次 API 请求');
    row('last', '上次请求', '上一次 API 请求的输出 token 数与平均速度；有精确数时包含看不见的思考');
    row('turn', '上轮均速', '');
    row('peak', '峰值速度', '');
    sep();
    row('context', '上下文', '主对话最近一次请求的输入 token（含缓存）/ 模型上下文窗口');
    ui.ctxMeter = meter(body);
    ui.limitsBox = el('div');
    body.append(ui.limitsBox);
    sep();
    row('input', '输入', '未命中缓存的输入 token');
    row('output', '输出', '含思考 token。≈ 表示本轮还没结束，未结束部分按正文估算（看不到思考，会偏低）');
    row('cacheRead', '缓存读取', '');
    row('cacheWrite', '缓存写入', '');
    row('total', '合计', '输入 + 输出 + 缓存读写');
    row('cost', 'API 等价费用', 'Claude Code 按 API 标价估算的累计费用；订阅用户不按此计费');
    ui.canvas = el('canvas', { width: '100%', height: '36px', marginTop: '6px', display: 'block' });
    body.append(ui.canvas);

    ui.full.append(header, body);
    root.append(ui.pill, ui.full);
    document.body.append(root);
    applyTheme(pageIsDark() ? 'dark' : 'light');
    setMode(mode);
    W.addEventListener('resize', () => {
      applyPos();
      keepInView();
    });
  }

  function limitRow(l) {
    let r = ui.limitRows[l.name];
    if (!r) {
      r = addRow(ui.limitsBox, l.label, '');
      r.meter = meter(ui.limitsBox);
      r.est = el('div', {
        color: 'var(--ctm-ink2)',
        fontSize: '11px',
        textAlign: 'right',
        margin: '-3px 0 4px',
        fontVariantNumeric: 'tabular-nums',
      });
      ui.limitsBox.append(r.est);
      ui.limitRows[l.name] = r;
    }
    return r;
  }

  function currentSpeed(now, active) {
    const cutoff = now - SPEED_WINDOW_MS;
    while (state.samples.length && state.samples[0][0] < cutoff) state.samples.shift();
    if (!state.samples.length) return 0;
    const sum = state.samples.reduce((a, s) => a + s[1], 0);
    const span = Math.min(SPEED_WINDOW_MS, Math.max(500, active.first ? now - active.first : SPEED_WINDOW_MS));
    return (sum / span) * 1000;
  }

  function drawSpark() {
    const c = ui.canvas;
    const dpr = W.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w) return;
    if (c.width !== w * dpr) {
      c.width = w * dpr;
      c.height = h * dpr;
    }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const data = state.spark;
    const max = Math.max(10, ...data);
    g.strokeStyle = theme.hair;
    g.beginPath();
    g.moveTo(0, h - 0.5);
    g.lineTo(w, h - 0.5);
    g.stroke();
    if (data.length < 2) return;
    const step = w / (SPARK_POINTS - 1);
    const x0 = w - (data.length - 1) * step;
    g.beginPath();
    data.forEach((v, i) => {
      const x = x0 + i * step;
      const y = h - 2 - (v / max) * (h - 6);
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    });
    g.strokeStyle = theme.accent;
    g.lineWidth = 1.5;
    g.stroke();
    g.lineTo(w, h);
    g.lineTo(x0, h);
    g.closePath();
    g.fillStyle = tint(theme.accent, 0.15);
    g.fill();
    g.fillStyle = theme.muted;
    g.fillText(Math.round(max) + ' tok/s', 2, 9);
  }

  let live = { active: null, flowing: false, speed: 0 };
  let tick = 0;
  let paintedAt = 0;
  let pillKey = '';

  function render() {
    const now = performance.now();
    for (const [lane, s] of state.lanes) if (now - (s.last || s.t0) > STALE_MS) closeLane(lane);
    let active = null; // 最近有动静的实时请求
    for (const s of state.lanes.values()) {
      if (!s.bulk && (!active || (s.last || s.t0) > (active.last || active.t0))) active = s;
    }
    const flowing = !!active && !!active.last && now - active.last < FLOW_MS;
    live = { active, flowing, speed: flowing ? currentSpeed(now, active) : 0 };
    state.spark.push(live.speed);
    if (state.spark.length > SPARK_POINTS) state.spark.shift();
    if (live.speed > state.peak) state.peak = live.speed;
    if (!ui.root) return;
    if (tick++ % 4 === 0) applyTheme(pageIsDark() ? 'dark' : 'light');
    paint(false);
    // 收起时也定期算一次并存下来，下次换会话时能直接用
    if (state.readings.length && Date.now() - quotaAt > 30000) quotaRates();
  }

  function paint(force) {
    const now = performance.now();
    const { active, flowing, speed } = live;
    const dotColor = flowing ? STATUS.good : active ? theme.accent : theme.muted;
    const dotTitle = flowing ? '正在输出' : active ? '请求进行中：等待输出或在思考（思考内容不可见）' : '空闲';
    for (const d of [ui.dot, ui.pillDot]) {
      d.style.background = dotColor;
      d.style.opacity = active && !flowing && tick % 2 ? '0.35' : '1';
      d.title = dotTitle;
    }
    if (mode === 'full') drawSpark();
    // 额度重置这类随时间变化的内容，至少 15 秒刷新一次
    if (!force && !dirty && !active && now - paintedAt < 15000) return;
    dirty = false;
    paintedAt = now;
    const r = state.results[state.results.length - 1];
    const v = { active, flowing, speed, turn: lastTurn(), c: contextNow(), lims: limitViews(), cost: r ? r.cost : 0 };
    if (mode === 'compact') paintCompact(v);
    else paintFull(v);
  }

  function paintCompact(v) {
    const parts = []; // [文字, 程度]
    if (v.flowing) parts.push([fmtSpeed(v.speed) + ' tok/s']);
    else if (v.active) parts.push(['思考中…']);
    else if (v.turn && v.turn.speed) parts.push([fmtSpeed(v.turn.speed) + ' tok/s']);
    if (v.c) parts.push([fmt(v.c.used) + (v.c.max ? '/' + fmt(v.c.max) : '')]);
    for (const l of v.lims) {
      // 5 小时额度总是显示；其他窗口用到一半以上才显示
      if (l.name === 'five_hour' || l.used >= 0.5 || l.level !== 'normal') {
        parts.push([l.short + ' ' + (l.expired ? '已重置' : fmtPct(l.used)), l.level]);
      }
    }
    if (v.cost) parts.push([fmtCost(v.cost, true)]);
    if (!parts.length) parts.push(['Token Meter']);
    const key = JSON.stringify(parts);
    if (key === pillKey) return;
    pillKey = key;
    ui.pillText.textContent = '';
    parts.forEach(([text, level], i) => {
      if (i) ui.pillText.append(el('span', { color: 'var(--ctm-muted)' }, '·'));
      const span = el('span', { display: 'inline-flex', alignItems: 'center', gap: '4px' });
      // 额度偏高时在旁边加个状态色小方块；数字本身一直显示，颜色不单独表达含义
      if (level && level !== 'normal') span.append(el('span', { width: '7px', height: '7px', borderRadius: '2px', background: STATUS[level] }));
      span.append(text);
      ui.pillText.append(span);
    });
  }

  function paintFull(v) {
    const { active, flowing, speed, turn, c, lims, cost } = v;
    ui.debugBtn.style.color = debug ? 'var(--ctm-accent)' : 'var(--ctm-ink2)';
    ui.speed.textContent = flowing ? fmtSpeed(speed) + ' tok/s' : '–';
    if (active && active.first) {
      const dur = (active.last - active.first) / 1000;
      const tokens = active.exact || active.est;
      ui.cur.textContent = (active.exact ? '' : '≈') + fmt(tokens) + ' tok · ' + fmtSpeed(dur > 0.3 ? active.est / dur : null) + '/s';
    } else ui.cur.textContent = active ? '等待输出…' : '–';
    const lr = state.lastResp;
    ui.last.textContent = lr ? (lr.exact ? '' : '≈') + fmt(lr.tokens) + ' tok · ' + fmtSpeed(lr.speed) + '/s' : '–';
    ui.turn.textContent = turn ? (turn.speed ? fmtSpeed(turn.speed) + '/s · ' : '') + fmt(turn.tokens) + ' tok' : '–';
    ui.turnRow.title = turn && turn.ms
      ? `上一轮共输出 ${turn.tokens.toLocaleString()} tokens（含思考），API 耗时 ${(turn.ms / 1000).toFixed(1)} 秒。` +
        '包含每次请求的首字延迟，所以会比实时速度低。'
      : '上一轮的输出 token 数与平均速度';
    ui.peak.textContent = state.peak ? fmtSpeed(state.peak) + ' tok/s' : '–';

    const frac = c && c.max ? c.used / c.max : 0;
    ui.context.textContent = c ? fmt(c.used) + (c.max ? ' / ' + fmt(c.max) + ' · ' + fmtPct(frac) : '') : '–';
    setMeter(ui.ctxMeter, frac, levelOf(frac, 0.7, 0.9));

    const rates = lims.length ? quotaRates() : {};
    for (const l of lims) {
      const r = limitRow(l);
      const q = rates[l.name];
      if (q) {
        const full = q.perPoint * 100; // 整个窗口折合的美元
        const left = Math.max(0, 1 - l.used) * full;
        const hours = rates.secPerDollar ? (left * rates.secPerDollar) / 3600 : null;
        r.est.textContent = l.used >= 1 ? '已用完' : '约剩 ' + fmtUsd(left) + (hours == null ? '' : ' · ' + fmtHours(hours));
        r.est.title =
          `按 API 标价折算，整个 ${l.label}约 ${fmtUsd(full)}（每 1% ≈ ${fmtUsd(q.perPoint, true)}，依据 ${q.points} 个百分点的变化）` +
          (rates.secPerDollar ? `；按你最近的用法，模型每运行 1 小时约花 ${fmtUsd(3600 / rates.secPerDollar)}` : '') +
          '。只是估算：假设统计期间账号没有别处的使用；换模型或用法差别很大时会不准。';
      } else {
        r.est.textContent = '剩余：估算中';
        r.est.title = '这个页面看到这项额度涨过至少两次后，才能估算它折合多少钱';
      }
      r.value.textContent = l.expired ? '已重置' : fmtPct(l.used) + ' · ' + fmtReset(l.resetsAt) + ' 重置';
      r.row.title = l.expired
        ? '已过重置时间，下一次请求后显示新窗口的用量'
        : `还有 ${fmtLeft(l.resetsAt)}重置。数值是这里观察到的最大值，` +
          '在其他设备或 App 上的用量要等这里下一次请求后才会更新。';
      setMeter(r.meter, l.used, l.level);
    }

    const t = sessionTotals();
    ui.input.textContent = fmt(t.input);
    ui.output.textContent = (t.approx ? '≈' : '') + fmt(t.output);
    ui.cacheRead.textContent = fmt(t.cacheRead);
    ui.cacheWrite.textContent = fmt(t.cacheWrite);
    ui.total.textContent = (t.approx ? '≈' : '') + fmt(t.input + t.output + t.cacheRead + t.cacheWrite);
    ui.costRow.style.display = cost ? 'flex' : 'none';
    ui.cost.textContent = cost ? fmtCost(cost) : '';
  }

  function boot() {
    if (!document.body) return void requestAnimationFrame(boot);
    buildUI();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  setInterval(safe(render), 500);

  W.__ctm = {
    get state() {
      return state;
    },
    get limits() {
      return limits;
    },
    totals: sessionTotals,
    context: contextNow,
    quota: () => ({ session: sessionQuotaRates(), combined: quotaRates() }),
    mode: (m) => setMode(m === 'full' ? 'full' : 'compact'),
    reset,
    debug(on = true) {
      debug = !!on;
      lsSet('ctm-debug', debug ? '1' : '0');
    },
    ingest: ingestText, // 手动喂数据测试：__ctm.ingest('{"type":"assistant",...}')
  };
})();
