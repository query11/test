// ==UserScript==
// @name         Claude Token Meter
// @namespace    https://github.com/query11/test
// @version      1.0.0
// @description  在 claude.ai（含 Claude Code 网页端 claude.ai/code）实时显示 token 用量与生成速度
// @match        https://claude.ai/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * 原理：在页面上下文里挂钩 fetch / XMLHttpRequest / WebSocket / EventSource，
 * 从流经的数据里识别 Anthropic API / Claude Code stream-json 的事件：
 *   - message_start / message_delta 里的 usage           → 精确用量
 *   - content_block_delta 里的增量文本                    → 实时速度（估算，会用精确值自动校准）
 *   - type:"assistant" 事件里的 message.usage            → 每条消息用量（按 message.id 去重）
 *   - type:"result" 事件里的 total_cost_usd              → 费用
 * 一次性加载的大量历史事件只计入用量，不计入速度。
 *
 * 控制台可用：__ctm.state 查看状态，__ctm.debug(true) 打印抓到的数据。
 */
(function () {
  'use strict';

  const W = window;
  if (W.__ctm) return;

  const LIVE_IDLE_MS = 1500; // 超过这么久没有新 token 视为本次生成结束
  const SPEED_WINDOW_MS = 2000; // 实时速度的滑动窗口
  const HISTORY_AGE_MS = 60000; // 带时间戳且早于此的事件视为历史，不计入速度
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
      messages: new Map(), // message id -> { input, output, cacheRead, cacheWrite }
      deltaIds: new Set(), // 有逐字流式增量的 message id（避免速度重复计数）
      seen: new Set(), // 已处理的事件 uuid
      lastContext: 0,
      cost: null,
      live: null, // 当前/最近一次生成
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

  function startLive(id) {
    finalizeLive(true);
    state.live = { id, start: 0, last: 0, est: 0, exact: 0, done: false };
  }

  function addLiveTokens(n, id) {
    if (!(n > 0)) return;
    if (!state.live || state.live.done || state.live.id !== id) startLive(id);
    const now = performance.now();
    const live = state.live;
    if (!live.start) live.start = now;
    live.last = now;
    live.est += n;
    state.samples.push([now, n]);
    dirty = true;
  }

  function finalizeLive(force) {
    const live = state.live;
    if (!live || live.done || !live.last) return;
    if (!force && performance.now() - live.last < LIVE_IDLE_MS) return;
    live.done = true;
    const tokens = live.exact || live.est;
    const dur = (live.last - live.start) / 1000;
    state.lastResp = { tokens, speed: dur > 0.3 ? tokens / dur : null, exact: !!live.exact };
    dirty = true;
  }

  function recordUsage(id, u, ctx) {
    if (!id) id = 'anon-' + ++state.anon;
    const prev = state.messages.get(id);
    const cur = {
      input: Math.max(num(u.input_tokens), prev ? prev.input : 0),
      output: Math.max(num(u.output_tokens), prev ? prev.output : 0),
      cacheRead: Math.max(num(u.cache_read_input_tokens), prev ? prev.cacheRead : 0),
      cacheWrite: Math.max(num(u.cache_creation_input_tokens), prev ? prev.cacheWrite : 0),
    };
    // 没有逐字增量时，用同一消息 output_tokens 的增长来近似速度
    if (!ctx.bulk && prev && !state.deltaIds.has(id)) addLiveTokens(cur.output - prev.output, id);
    state.messages.set(id, cur);
    const ctxTokens = cur.input + cur.cacheRead + cur.cacheWrite;
    if (ctxTokens > 0) state.lastContext = ctxTokens;
    dirty = true;
  }

  // ---------------------------------------------------------------- 事件识别

  function isOld(o) {
    const ts = o.timestamp ?? o.created_at ?? o.createdAt;
    if (ts == null) return false;
    const t = typeof ts === 'number' ? (ts < 1e12 ? ts * 1000 : ts) : Date.parse(ts);
    return isFinite(t) && Date.now() - t > HISTORY_AGE_MS;
  }

  function handle(o, ctx) {
    switch (o.type) {
      case 'message_start': {
        const m = o.message || {};
        if (!ctx.bulk) {
          startLive(m.id);
          state.deltaIds.add(m.id);
        }
        if (m.usage) recordUsage(m.id, m.usage, ctx);
        return true;
      }
      case 'content_block_delta': {
        const d = o.delta || {};
        const txt = d.text ?? d.thinking ?? d.partial_json ?? '';
        if (txt && !ctx.bulk && state.live && !state.live.done) addLiveTokens(estimateTokens(txt), state.live.id);
        return true;
      }
      case 'message_delta': {
        const live = state.live;
        if (o.usage && live) {
          recordUsage(live.id, o.usage, ctx);
          const exact = num(o.usage.output_tokens);
          if (exact && !ctx.bulk) {
            live.exact = exact;
            if (live.est > 20) {
              const ratio = exact / (live.est / state.calib);
              if (ratio > 0.2 && ratio < 5) state.calib = state.calib * 0.7 + ratio * 0.3;
            }
          }
        }
        return true;
      }
      case 'assistant': {
        const m = o.message;
        if (m && m.usage) recordUsage(m.id || o.uuid, m.usage, ctx);
        return true;
      }
      case 'result':
        if (typeof o.total_cost_usd === 'number') {
          state.cost = o.total_cost_usd;
          dirty = true;
        }
        return true; // result.usage 是汇总值，不重复累计
      default: {
        const u = o.usage;
        if (u && typeof u === 'object' && ('output_tokens' in u || 'input_tokens' in u) && (o.id || o.uuid)) {
          recordUsage(o.id || o.uuid, u, ctx);
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
    if (!ctx.bulk && isOld(o)) ctx = { bulk: true };
    if (o.type && debug) log(ctx.bulk ? '(history)' : '(live)', o.type, o.event?.type || o.delta?.type || '');
    if (handle(o, ctx)) return;
    for (const k in o) {
      const v = o[k];
      if (v && typeof v === 'object') walk(v, ctx, depth + 1);
      else if (typeof v === 'string' && v.length > 20 && (v[0] === '{' || v[0] === '[') && /tokens|delta/.test(v)) {
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
    if (!/tokens|_delta/.test(text)) return;
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
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e4) return (n / 1e3).toFixed(1) + 'k';
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
      ['speed', '实时速度'],
      ['cur', '本次回复'],
      ['last', '上次回复'],
      ['peak', '峰值速度'],
      ['sep'],
      ['input', '输入'],
      ['output', '输出'],
      ['cacheRead', '缓存读取'],
      ['cacheWrite', '缓存写入'],
      ['total', '合计'],
      ['context', '当前上下文'],
      ['msgs', '消息数'],
      ['cost', '费用 (result)'],
    ];
    for (const [key, label] of rows) {
      if (key === 'sep') {
        ui.body.append(el('div', { borderTop: '1px solid rgba(255,255,255,0.08)', margin: '4px 0' }));
        continue;
      }
      const row = el('div', { display: 'flex', justifyContent: 'space-between', gap: '8px' });
      const v = el('span', { color: '#fafafa', textAlign: 'right' }, '–');
      row.append(el('span', { color: '#a1a1aa' }, label), v);
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

  function currentSpeed(now) {
    const cutoff = now - SPEED_WINDOW_MS;
    while (state.samples.length && state.samples[0][0] < cutoff) state.samples.shift();
    if (!state.samples.length) return 0;
    const sum = state.samples.reduce((a, s) => a + s[1], 0);
    const live = state.live;
    const span = Math.min(SPEED_WINDOW_MS, Math.max(1000, live && live.start ? now - live.start : SPEED_WINDOW_MS));
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
    finalizeLive(false);
    const live = state.live;
    const generating = live && !live.done && live.last && now - live.last < LIVE_IDLE_MS;
    const speed = generating ? currentSpeed(now) : 0;
    state.spark.push(speed);
    if (state.spark.length > SPARK_POINTS) state.spark.shift();
    if (speed > state.peak) state.peak = speed;
    if (!ui.root) return;

    ui.dot.style.background = generating ? '#22c55e' : '#52525b';
    ui.dot.title = generating ? '生成中' : '空闲';
    ui.debugBtn.style.color = debug ? '#f59e0b' : '#a1a1aa';
    if (ui.body.style.display === 'none') {
      ui.title.textContent = generating ? fmtSpeed(speed) + ' tok/s' : 'Token Meter';
      return;
    }
    ui.title.textContent = 'Token Meter';
    drawSpark();
    if (!dirty && !generating && !speed) return;
    dirty = false;

    ui.speed.textContent = generating ? fmtSpeed(speed) + ' tok/s' : '–';
    if (generating) {
      const dur = (live.last - live.start) / 1000;
      ui.cur.textContent = '≈' + fmt(live.exact || live.est) + ' · ' + fmtSpeed(dur > 0.3 ? (live.exact || live.est) / dur : null) + '/s';
    } else ui.cur.textContent = '–';
    const lr = state.lastResp;
    ui.last.textContent = lr ? (lr.exact ? '' : '≈') + fmt(lr.tokens) + ' · ' + fmtSpeed(lr.speed) + '/s' : '–';
    ui.peak.textContent = state.peak ? fmtSpeed(state.peak) + ' tok/s' : '–';

    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    for (const m of state.messages.values()) {
      input += m.input;
      output += m.output;
      cacheRead += m.cacheRead;
      cacheWrite += m.cacheWrite;
    }
    ui.input.textContent = fmt(input);
    ui.output.textContent = fmt(output);
    ui.cacheRead.textContent = fmt(cacheRead);
    ui.cacheWrite.textContent = fmt(cacheWrite);
    ui.total.textContent = fmt(input + output + cacheRead + cacheWrite);
    ui.context.textContent = fmt(state.lastContext);
    ui.msgs.textContent = String(state.messages.size);
    ui.costRow.style.display = state.cost == null ? 'none' : 'flex';
    ui.cost.textContent = state.cost == null ? '' : '$' + state.cost.toFixed(4);
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
    reset,
    debug(on = true) {
      debug = !!on;
      lsSet('ctm-debug', debug ? '1' : '0');
    },
    ingest: ingestText, // 手动喂数据测试：__ctm.ingest('{"type":"assistant",...}')
  };
})();
