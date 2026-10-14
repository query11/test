// ==UserScript==
// @name         Claude Token Meter
// @namespace    https://github.com/query11/test
// @version      1.1.0
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
        blocks: new Set(),
      };
      state.messages.set(id, m);
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
    state.results.push({
      ...stamp(ctx, end),
      cost,
      totals: models ? totals : null,
      window,
      turnOut: num(u.output_tokens),
      apiMs: num(o.duration_api_ms),
      wallMs: num(o.duration_ms),
    });
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
          const s = blockText(b);
          const sig = b.id || b.type + ':' + s.length + ':' + s.slice(0, 40);
          if (!s || m.blocks.has(sig)) continue;
          m.blocks.add(sig);
          m.blockEst += estimateTokens(s);
        }
        return true;
      }
      case 'result':
        recordResult(o, ctx);
        return true;
      default: {
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
      else if (typeof v === 'string' && v.length > 20 && (v[0] === '{' || v[0] === '[') && /tokens|delta|_start|_stop/i.test(v)) {
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
    walk(obj, { bulk: acc.n > 2, src }, 0);
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
    if (!/tokens|_delta|_start|_stop/i.test(text)) return; // message_stop / content_block_start 不含 tokens
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
    // duration_api_ms 是累计 API 耗时：优先取与上一条之差；本轮 API 耗时不会超过本轮总耗时
    for (const ms of [prev ? cur.apiMs - prev.apiMs : 0, cur.apiMs]) {
      if (ms > 0 && (!cur.wallMs || ms <= cur.wallMs)) return { tokens, ms, speed: tokens / (ms / 1000) };
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

  function el(tag, style, text) {
    const e = document.createElement(tag);
    if (style) Object.assign(e.style, style);
    if (text != null) e.textContent = text;
    return e;
  }

  const ui = {};

  function buildUI() {
    const root = el('div', {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      zIndex: '2147483647',
      width: '240px',
      background: 'rgba(24,24,27,0.92)',
      color: '#e4e4e7',
      font: '12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      borderRadius: '10px',
      boxShadow: '0 4px 20px rgba(0,0,0,0.35)',
      border: '1px solid rgba(255,255,255,0.08)',
      userSelect: 'none',
      backdropFilter: 'blur(6px)',
    });
    const pos = lsGet('ctm-pos');
    if (pos) {
      try {
        const { left, top } = JSON.parse(pos);
        Object.assign(root.style, { left: left + 'px', top: top + 'px', right: 'auto', bottom: 'auto' });
      } catch {}
    }

    const header = el('div', {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      padding: '6px 8px',
      cursor: 'move',
      borderBottom: '1px solid rgba(255,255,255,0.08)',
    });
    ui.dot = el('span', { width: '8px', height: '8px', borderRadius: '50%', background: '#52525b', flex: 'none' });
    ui.title = el('span', { flex: '1', fontWeight: '600' }, 'Token Meter');
    const btn = (label, tip, onClick) => {
      const b = el('button', {
        background: 'transparent',
        color: '#a1a1aa',
        border: '1px solid rgba(255,255,255,0.15)',
        borderRadius: '4px',
        padding: '0 5px',
        font: 'inherit',
        cursor: 'pointer',
      }, label);
      b.title = tip;
      b.addEventListener('mousedown', (e) => e.stopPropagation());
      b.addEventListener('click', onClick);
      return b;
    };
    ui.debugBtn = btn('dbg', '在控制台打印抓到的事件', () => {
      debug = !debug;
      lsSet('ctm-debug', debug ? '1' : '0');
      dirty = true;
    });
    const resetBtn = btn('↺', '清零', reset);
    ui.foldBtn = btn('–', '折叠/展开', () => {
      const folded = ui.body.style.display !== 'none';
      ui.body.style.display = folded ? 'none' : 'block';
      ui.foldBtn.textContent = folded ? '+' : '–';
      lsSet('ctm-folded', folded ? '1' : '0');
    });
    header.append(ui.dot, ui.title, ui.debugBtn, resetBtn, ui.foldBtn);

    ui.body = el('div', { padding: '6px 10px 8px' });
    const rows = [
      ['speed', '实时速度', '最近 2 秒可见输出的速度（按字符估算，并用精确值自动校准）'],
      ['cur', '当前请求', '正在流式输出的这次 API 请求'],
      ['last', '上次请求', '上一次 API 请求的输出 token 数与平均速度；有精确数时包含看不见的思考'],
      ['turn', '上轮均速', ''],
      ['peak', '峰值速度', ''],
      ['sep'],
      ['context', '上下文', '主对话最近一次请求的输入 token（含缓存）/ 模型上下文窗口'],
      ['bar'],
      ['input', '输入', '未命中缓存的输入 token'],
      ['output', '输出', '含思考 token。≈ 表示本轮还没结束，未结束部分按正文估算（看不到思考，会偏低）'],
      ['cacheRead', '缓存读取', ''],
      ['cacheWrite', '缓存写入', ''],
      ['total', '合计', '输入 + 输出 + 缓存读写'],
      ['cost', 'API 等价费用', 'Claude Code 按 API 标价估算的累计费用；订阅用户不按此计费'],
    ];
    for (const [key, label, tip] of rows) {
      if (key === 'sep') {
        ui.body.append(el('div', { borderTop: '1px solid rgba(255,255,255,0.08)', margin: '4px 0' }));
        continue;
      }
      if (key === 'bar') {
        const track = el('div', { height: '3px', borderRadius: '2px', background: 'rgba(255,255,255,0.1)', margin: '1px 0 4px' });
        ui.bar = el('div', { height: '100%', width: '0', borderRadius: '2px', background: '#60a5fa' });
        track.append(ui.bar);
        ui.body.append(track);
        continue;
      }
      const row = el('div', { display: 'flex', justifyContent: 'space-between', gap: '8px' });
      const v = el('span', { color: '#fafafa', textAlign: 'right' }, '–');
      row.append(el('span', { color: '#a1a1aa' }, label), v);
      if (tip) row.title = tip;
      ui[key] = v;
      ui[key + 'Row'] = row;
      ui.body.append(row);
    }
    ui.canvas = el('canvas', { width: '100%', height: '36px', marginTop: '6px', display: 'block' });
    ui.body.append(ui.canvas);
    if (lsGet('ctm-folded') === '1') {
      ui.body.style.display = 'none';
      ui.foldBtn.textContent = '+';
    }

    root.append(header, ui.body);
    ui.root = root;

    // 拖动
    header.addEventListener('mousedown', (e) => {
      const r = root.getBoundingClientRect();
      const dx = e.clientX - r.left;
      const dy = e.clientY - r.top;
      const move = (ev) => {
        const left = Math.min(Math.max(0, ev.clientX - dx), innerWidth - r.width);
        const top = Math.min(Math.max(0, ev.clientY - dy), innerHeight - 30);
        Object.assign(root.style, { left: left + 'px', top: top + 'px', right: 'auto', bottom: 'auto' });
      };
      const up = () => {
        removeEventListener('mousemove', move);
        removeEventListener('mouseup', up);
        lsSet('ctm-pos', JSON.stringify({ left: parseFloat(root.style.left), top: parseFloat(root.style.top) }));
      };
      addEventListener('mousemove', move);
      addEventListener('mouseup', up);
      e.preventDefault();
    });

    document.body.append(root);
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
    g.strokeStyle = 'rgba(255,255,255,0.08)';
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
    g.strokeStyle = '#f59e0b';
    g.lineWidth = 1.5;
    g.stroke();
    g.lineTo(w, h);
    g.lineTo(x0, h);
    g.closePath();
    g.fillStyle = 'rgba(245,158,11,0.15)';
    g.fill();
    g.fillStyle = '#71717a';
    g.fillText(Math.round(max) + ' tok/s', 2, 9);
  }

  function render() {
    const now = performance.now();
    for (const [lane, s] of state.lanes) if (now - (s.last || s.t0) > STALE_MS) closeLane(lane);
    let active = null; // 最近有动静的实时请求
    for (const s of state.lanes.values()) {
      if (!s.bulk && (!active || (s.last || s.t0) > (active.last || active.t0))) active = s;
    }
    const flowing = !!active && !!active.last && now - active.last < FLOW_MS;
    const speed = flowing ? currentSpeed(now, active) : 0;
    state.spark.push(speed);
    if (state.spark.length > SPARK_POINTS) state.spark.shift();
    if (speed > state.peak) state.peak = speed;
    if (!ui.root) return;

    ui.dot.style.background = flowing ? '#22c55e' : active ? '#f59e0b' : '#52525b';
    ui.dot.title = flowing ? '正在输出' : active ? '请求进行中：等待输出或在思考（思考内容不可见）' : '空闲';
    ui.debugBtn.style.color = debug ? '#f59e0b' : '#a1a1aa';
    if (ui.body.style.display === 'none') {
      ui.title.textContent = flowing ? fmtSpeed(speed) + ' tok/s' : active ? '思考中…' : 'Token Meter';
      return;
    }
    ui.title.textContent = 'Token Meter';
    drawSpark();
    if (!dirty && !active) return;
    dirty = false;

    ui.speed.textContent = flowing ? fmtSpeed(speed) + ' tok/s' : '–';
    if (active && active.first) {
      const dur = (active.last - active.first) / 1000;
      const tokens = active.exact || active.est;
      ui.cur.textContent = (active.exact ? '' : '≈') + fmt(tokens) + ' tok · ' + fmtSpeed(dur > 0.3 ? active.est / dur : null) + '/s';
    } else ui.cur.textContent = active ? '等待输出…' : '–';
    const lr = state.lastResp;
    ui.last.textContent = lr ? (lr.exact ? '' : '≈') + fmt(lr.tokens) + ' tok · ' + fmtSpeed(lr.speed) + '/s' : '–';
    const turn = lastTurn();
    ui.turn.textContent = turn ? (turn.speed ? fmtSpeed(turn.speed) + '/s · ' : '') + fmt(turn.tokens) + ' tok' : '–';
    ui.turnRow.title = turn && turn.ms
      ? `上一轮共输出 ${turn.tokens.toLocaleString()} tokens（含思考），API 耗时 ${(turn.ms / 1000).toFixed(1)} 秒。` +
        '包含每次请求的首字延迟，所以会比实时速度低。'
      : '上一轮的输出 token 数与平均速度';
    ui.peak.textContent = state.peak ? fmtSpeed(state.peak) + ' tok/s' : '–';

    const c = contextNow();
    const pct = c && c.max ? (c.used / c.max) * 100 : 0;
    ui.context.textContent = c ? fmt(c.used) + (c.max ? ' / ' + fmt(c.max) + ' · ' + Math.round(pct) + '%' : '') : '–';
    ui.bar.style.width = Math.min(100, pct) + '%';
    ui.bar.style.background = pct >= 80 ? '#f87171' : pct >= 60 ? '#f59e0b' : '#60a5fa';

    const t = sessionTotals();
    ui.input.textContent = fmt(t.input);
    ui.output.textContent = (t.approx ? '≈' : '') + fmt(t.output);
    ui.cacheRead.textContent = fmt(t.cacheRead);
    ui.cacheWrite.textContent = fmt(t.cacheWrite);
    ui.total.textContent = (t.approx ? '≈' : '') + fmt(t.input + t.output + t.cacheRead + t.cacheWrite);
    const r = state.results[state.results.length - 1];
    ui.costRow.style.display = r && r.cost ? 'flex' : 'none';
    ui.cost.textContent = r && r.cost ? '$' + r.cost.toFixed(r.cost >= 10 ? 2 : 4) : '';
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
    totals: sessionTotals,
    context: contextNow,
    reset,
    debug(on = true) {
      debug = !!on;
      lsSet('ctm-debug', debug ? '1' : '0');
    },
    ingest: ingestText, // 手动喂数据测试：__ctm.ingest('{"type":"assistant",...}')
  };
})();
