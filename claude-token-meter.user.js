// ==UserScript==
// @name         Claude Token Meter
// @namespace    https://github.com/query11/test
// @version      1.5.0
// @description  在 claude.ai（含 Claude Code 网页端 claude.ai/code）实时显示模型、推理强度、token 用量、生成速度、提示缓存与订阅额度
// @homepageURL  https://github.com/query11/test
// @downloadURL  https://raw.githubusercontent.com/query11/test/HEAD/claude-token-meter.user.js
// @updateURL    https://raw.githubusercontent.com/query11/test/HEAD/claude-token-meter.user.js
// @match        https://claude.ai/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * 原理：在页面上下文里挂钩 fetch / XMLHttpRequest / WebSocket / EventSource，
 * 从流经的数据里识别 Claude Code stream-json（以及 Anthropic API 流式）事件：
 *   - type:"result" 的 modelUsage / total_cost_usd → 会话累计用量与费用。这是当前这段运行的累计值，应取最新一条；
 *     /clear 之后（以及续接时没有存档）会从零重新开始，所以按段取各段最后一条再相加
 *   - type:"assistant" 的 message.usage / model       → 本轮还没结束时的输入/缓存用量（按 message.id 去重）、实际服务的模型。
 *     其中的 output_tokens 只是请求刚开始时的占位值（个位数），输出量改按正文长度估算
 *   - stream_event 包着的 message_start / content_block_delta / message_delta / message_stop
 *                                                    → 实时速度；message_delta 带精确输出数，用来校准估算
 *   - system/thinking_tokens                         → 看不见的思考的进度，思考时也能算出速度
 *   - system/init、会话元数据 external_metadata、get_settings 的响应、网页发出的 set_model / apply_flag_settings
 *                                                    → 模型、推理强度（effort）、快速模式
 *   - result.modelUsage 与 duration_api_ms 的增量    → 上一轮的输出量与平均速度
 *   - get_context_usage 的响应、会话元数据的 context_usage → 上下文占用
 *   - rate_limit_event 的 unifiedWindows、claude.ai 的用量接口 → 订阅额度（各窗口的已用比例与重置时间）
 * 历史记录（一次加载多条）只计入用量，不计入速度。思考内容在网页端不可见，只能从精确数里看到。
 * 对话内容（用户消息、工具调用与结果、正文）里的 JSON 不当成事件：读到的日志文件不能把统计带偏。
 *
 * 控制台可用：__ctm.state 查看状态，__ctm.debug(true) 打印抓到的数据，__ctm.diagnostics() 查看诊断信息。
 */
(function () {
  'use strict';

  const W = window;
  if (W.__ctm) return;

  const VERSION = '1.5.0';
  const FLOW_MS = 1500; // 这么久内收到过 token 视为“正在输出”
  const STALE_MS = 60000; // 流式请求这么久没动静就当作已结束（防止漏掉 message_stop）
  const SPEED_WINDOW_MS = 2000; // 实时速度的滑动窗口
  const HISTORY_AGE_MS = 600000; // 带时间戳且早于 10 分钟的事件视为历史（留出本机时钟误差）
  const SPARK_POINTS = 120; // 速度曲线保留的点数（每 500ms 一个）
  const KINDS = ['input', 'output', 'cacheRead', 'cacheWrite'];

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
  const lsJSON = (k, fallback) => {
    try {
      return JSON.parse(lsGet(k) || 'null') || fallback;
    } catch {
      return fallback;
    }
  };

  let debug = lsGet('ctm-debug') === '1';
  const log = (...a) => debug && console.log('[token-meter]', ...a);

  // ---------------------------------------------------------------- state

  function freshState() {
    return {
      seen: new Set(), // 已处理的事件 uuid
      seq: 0, // 到达顺序
      rev: 0, // result 和 /clear 记录的版本，分段结果按它缓存
      messages: new Map(), // message id -> 见 messageRecord()
      results: [], // result 快照，按先后排序
      resets: [], // /clear（conversation_reset）发生的位置：累计值从这里重新开始
      compacts: [], // 上下文压缩（compact_boundary）发生的位置：之后的缓存是重新建的
      readings: [], // 本会话收到的额度读数，用来估算额度折合多少钱
      info: {}, // 模型、推理强度、上下文读数等线索：项目 -> [记录]，用的时候取最新的一条
      metaSeen: {}, // 会话元数据里各项上一次的值
      lanes: new Map(), // 正在流式输出的请求：主对话为 'main'，子代理按 parent_tool_use_id 区分
      lastResp: null,
      samples: [], // [timestamp, tokens]
      spark: [],
      peak: 0,
      calib: 1, // 估算 → 精确 token 的校准系数
      anon: 0,
      types: {}, // 各类事件的数量，诊断用
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
    return { ts: ctx.ts || fallbackTs || 0, live: !ctx.bulk, seq: ++state.seq, at: Date.now() };
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
        model: '',
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        ttl: '', // 这次请求写入的缓存是 5 分钟（'5m'）还是 1 小时（'1h'）的
        fast: false, // 快速模式
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
    // 和 CLI 的判断一样：有 5 分钟的写入就是 5 分钟缓存，否则看有没有 1 小时的
    const cc = u.cache_creation;
    if (cc && typeof cc === 'object') {
      if (num(cc.ephemeral_5m_input_tokens) > 0) m.ttl = '5m';
      else if (num(cc.ephemeral_1h_input_tokens) > 0) m.ttl = '1h';
    }
    if (u.speed === 'fast') m.fast = true;
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
    const byModel = {}; // 各模型的累计值，包括费用和思考 token（已含在输出里）
    let thinking = 0;
    let window = 0;
    for (const name in o.modelUsage || {}) {
      const x = o.modelUsage[name] || {};
      const t = {
        input: num(x.inputTokens),
        output: num(x.outputTokens),
        cacheRead: num(x.cacheReadInputTokens),
        cacheWrite: num(x.cacheCreationInputTokens),
        thinking: num(x.thinkingTokens),
        cost: num(x.costUSD),
        window: num(x.contextWindow),
      };
      byModel[name] = t;
      for (const k of KINDS) totals[k] += t[k];
      thinking += t.thinking;
      window = Math.max(window, t.window);
    }
    const models = Object.keys(byModel).length;
    const cost = num(o.total_cost_usd);
    if (!models && !cost) return; // 出错或空操作的 result 带的是全零值
    const u = o.usage || {};
    // result 自身没有时间戳时，用“本轮开始时间 + 本轮耗时”推出结束时间
    const start = num(o.turn_started_wall_ms) || num(o.request_sent_wall_ms);
    const end = start && num(o.duration_ms) ? start + o.duration_ms : 0;
    const r = {
      ...stamp(ctx, end),
      cost,
      totals: models ? totals : null,
      byModel,
      thinking,
      window,
      // 本轮主对话的用量（不是累计值，也不含子代理）
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
    sortResults();
    if (o.fast_mode_state) addInfo('fast', o.fast_mode_state, 'result', ctx);
    if (!ctx.bulk) {
      // 一轮结束了，还开着的流也都结束了；额度刚变过，稍后刷新一次
      for (const lane of [...state.lanes.keys()]) closeLane(lane, performance.now());
      setTimeout(() => pollUsage(true), 4000);
    }
  }

  function sortResults() {
    state.results.sort((a, b) => compare(a, b, resultWeight));
    state.rev++;
    dirty = true;
  }

  // ---------------------------------------------------------------- 实时流

  const laneOf = (ctx) => ctx.lane || 'main';
  const newLane = (m, bulk) => ({ m, bulk, t0: performance.now(), first: 0, last: 0, est: 0, think: 0, thinkAt: 0, exact: 0, thinking: false });

  function closeLane(lane, end) {
    const s = state.lanes.get(lane);
    if (!s) return;
    state.lanes.delete(lane);
    if (s.bulk || !s.last) return;
    // 有精确数（含看不见的思考）时从 message_start 算起，否则只算收到增量的这段时间
    const tokens = s.exact || s.est + s.think;
    const dur = ((s.exact ? end || s.last : s.last) - (s.exact ? s.t0 : s.first)) / 1000;
    state.lastResp = { tokens, speed: dur > 0.3 ? tokens / dur : null, exact: !!s.exact };
    dirty = true;
  }

  // system/thinking_tokens：思考内容看不见，但 CLI 会报告估算的思考 token 数，用来算思考时的速度
  function thinkingProgress(o, ctx) {
    const d = num(o.estimated_tokens_delta);
    if (ctx.bulk || d <= 0) return;
    const now = performance.now();
    let s = state.lanes.get('main');
    if (!s) state.lanes.set('main', (s = newLane(null, false))); // 没有转发 stream_event 时也能显示
    if (!s.first) s.first = now;
    s.last = s.thinkAt = now;
    s.think = Math.max(s.think + d, num(o.estimated_tokens));
    s.thinking = true;
    state.samples.push([now, d]);
    dirty = true;
  }

  // ---------------------------------------------------------------- 模型与推理强度

  // 每条线索都记下来，用的时候取最新的一条：历史记录常常倒序加载，要等这批数据的时间戳补齐之后才能比较先后。
  // 会话元数据会被反复拉取，值没变就不算新线索，免得盖过之后实时到达的事件
  function addInfo(key, value, src, ctx) {
    if (src === 'metadata' || src === 'session') {
      const k = src + ':' + key;
      const v = JSON.stringify(value === undefined ? null : value);
      if (state.metaSeen[k] === v) return;
      state.metaSeen[k] = v;
    }
    const rec = { ...stamp(ctx), value, src };
    const list = (state.info[key] ||= []);
    list.push(rec);
    if (list.length > 2000) {
      list.sort((a, b) => compare(a, b, (x) => x.seq));
      list.splice(0, list.length - 500);
    }
    if (ctx.batch) ctx.batch.push(rec);
    dirty = true;
  }

  function latestInfo(key) {
    let best = null;
    for (const x of state.info[key] || []) if (!best || compare(x, best, (y) => y.seq) > 0) best = x;
    return best;
  }

  const isModelId = (v) => typeof v === 'string' && v.length > 1 && v.length < 120 && v[0] !== '<'; // <synthetic> 是 CLI 自己生成的消息
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  // claude-opus-5-5 → Opus 5.5；claude-sonnet-4-5-20250929 → Sonnet 4.5；claude-3-5-haiku → Haiku 3.5；
  // Bedrock / Vertex 的写法去掉前后缀；带 [1m] 的是 1M 上下文版本；opus 这类别名首字母大写
  function modelName(id) {
    if (!isModelId(id)) return '';
    let s = id.toLowerCase().trim();
    const oneM = /\[1m\]/.test(s);
    s = s
      .replace(/\[[^\]]*\]/g, '')
      .replace(/^.*?(?=claude-)/, '')
      .replace(/@.*$/, '')
      .replace(/-v\d+(:\d+)?$/, '')
      .replace(/-\d{8}$/, '');
    let m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?$/.exec(s);
    let name = m ? cap(m[1]) + ' ' + m[2] + (m[3] ? '.' + m[3] : '') : '';
    if (!name && (m = /^claude-(\d+)(?:-(\d))?-([a-z]+)$/.exec(s))) name = cap(m[3]) + ' ' + m[1] + (m[2] ? '.' + m[2] : '');
    if (!name) name = s === 'default' ? '默认模型' : /^[a-z]+$/.test(s) ? cap(s) : id;
    return name + (oneM ? ' 1M' : '');
  }

  const EFFORT_NAMES = { low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高' };
  const INFO_SOURCES = {
    init: '每轮开始时的 init 事件',
    assistant: '最近一次请求的响应',
    stream: '最近一次请求的响应',
    metadata: '会话元数据',
    session: '会话信息',
    settings: '会话设置（get_settings）',
    request: '网页发出的切换请求',
    context: '上下文查询',
    fallback: '拒答后换用的模型',
    result: 'result 事件',
  };

  // 当前模型：实际服务的模型和设置的模型取较新的一条（刚切换模型时设置的更新，降级重试时实际服务的更新）
  function modelInfo() {
    const served = latestInfo('served');
    const set = latestInfo('model');
    let cur = served && (!set || !isAfter(set, served)) ? served : set;
    if (cur === set && served && !/\d/.test(set.value)) cur = served; // default / opus 这类别名看不出具体版本
    const effort = latestInfo('effort');
    const fast = latestInfo('fast');
    const ultra = latestInfo('ultracode');
    const ev = effort && effort.value;
    return {
      id: cur ? cur.value : '',
      src: cur ? cur.src : '',
      served: served ? served.value : '',
      set: set ? set.value : '',
      effort: typeof ev === 'string' || typeof ev === 'number' ? String(ev) : '',
      effortNone: !!effort && ev === null, // 明确说了不发送推理强度（模型不支持）
      effortSrc: effort ? effort.src : '',
      fast: !!fast && fast.value === 'on',
      ultracode: !!ultra && ultra.value === true,
    };
  }

  // 网页发给会话的控制请求（切换模型、改推理强度）；历史记录里也可能有
  function handleRequest(r, ctx) {
    if (r.subtype === 'set_model') addInfo('model', isModelId(r.model) ? r.model : 'default', 'request', ctx);
    else if (r.subtype === 'apply_flag_settings' && r.settings && typeof r.settings === 'object') {
      const s = r.settings;
      // effortLevel 为 null 表示回到模型默认值，具体是多少这里不知道
      if ('effortLevel' in s) addInfo('effort', s.effortLevel == null ? undefined : s.effortLevel, 'request', ctx);
      if ('ultracode' in s) addInfo('ultracode', s.ultracode === true, 'request', ctx);
      if (isModelId(s.model)) addInfo('model', s.model, 'request', ctx);
    }
  }

  // 会话对象的 external_metadata：云端会话把当前模型、上次实际服务的模型、推理强度、上下文占用都写在这里
  function applyMetadata(md, ctx) {
    if (isModelId(md.model)) addInfo('model', md.model, 'metadata', ctx);
    if (isModelId(md.last_served_model)) addInfo('served', md.last_served_model, 'metadata', ctx);
    if ('effort_level' in md) addInfo('effort', md.effort_level, 'metadata', ctx);
    if ('is_ultracode_active' in md) addInfo('ultracode', md.is_ultracode_active === true, 'metadata', ctx);
    const cu = md.context_usage;
    if (cu && typeof cu === 'object' && num(cu.used_tokens)) {
      addInfo('ctx', { used: num(cu.used_tokens), max: num(cu.max_tokens) }, 'metadata', ctx);
    }
  }

  // 会话列表里有很多会话，只认当前页面这个：会话 id 去掉前缀（session_ / cse_）后应出现在地址里
  function isCurrentSession(o) {
    const id = o.id || o.session_id || o.uuid;
    if (id == null) return true;
    if (typeof id !== 'string') return false;
    const tail = id.replace(/^[a-z]+_/i, '');
    return tail.length >= 10 && location.pathname.includes(tail);
  }

  // ---------------------------------------------------------------- 订阅额度

  // [完整名称, 简称]；未列出的窗口直接显示原名
  const LIMIT_NAMES = {
    five_hour: ['5 小时额度', '5h'],
    seven_day: ['7 天额度', '7d'],
    seven_day_opus: ['7 天 Opus', '7d Opus'],
    seven_day_sonnet: ['7 天 Sonnet', '7d Sonnet'],
    seven_day_overage_included: ['7 天（含超额）', '7d+'],
    seven_day_oauth_apps: ['7 天（OAuth 应用）', '7d OAuth'],
  };

  function limitNames(name) {
    if (LIMIT_NAMES[name]) return LIMIT_NAMES[name];
    // 用量接口按模型或产品单独计的窗口：scoped:<分组>:<名称>
    const m = /^scoped:([^:]*):(.+)$/.exec(name);
    if (m) return m[1] === 'session' ? ['5 小时 ' + m[2], '5h ' + m[2]] : ['7 天 ' + m[2], '7d ' + m[2]];
    return [name, name];
  }

  // 额度是账号级的，不随会话清零，并存进 localStorage：刷新页面、打开别的会话时也能立刻显示。
  // name -> { utilization: 已用比例（0~1）, resetsAt: 重置时间（unix 秒，0 表示窗口还没开始）,
  //           status / severity: 服务端给的状态, at: 读数时间（毫秒）, src: 'event' | 'official' }
  let limits = lsJSON('ctm-limits', {});
  let extraUsage = lsJSON('ctm-extra', null); // 额外用量（超出订阅后按量付费）
  let officialAt = 0; // 最近一次从 claude.ai 用量接口拿到数据的时间

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
    const ev = state.seq + 1; // 同一个事件里各窗口的读数共用一个编号
    for (const name in windows) {
      const w = windows[name] || {};
      if (!num(w.resetsAt)) continue;
      const q = { ...stamp(ctx), name, resetsAt: num(w.resetsAt), u: num(w.utilization), ev };
      state.readings.push(q);
      if (ctx.batch) ctx.batch.push(q);
    }
  }

  // 各额度窗口的读数历史 { 窗口名: { resetsAt, pts: [[毫秒时间, 已用比例], ...] } }，按时间排好，用来算最近的消耗速度。
  // 存进 localStorage：刷新页面、换会话之后也能马上预测
  let usageHist = lsJSON('ctm-usage-hist', {});
  let histDirty = false;

  function notePoint(name, resetsAt, u, at) {
    if (!resetsAt || !at) return;
    let hist = usageHist[name];
    if (!hist || Math.abs(hist.resetsAt - resetsAt) > 300) {
      if (hist && resetsAt < hist.resetsAt) return; // 已经过去的窗口
      hist = usageHist[name] = { resetsAt, pts: [] };
    }
    const pts = hist.pts;
    const near = pts.find((p) => Math.abs(p[0] - at) < 60000); // 一分钟之内的读数只留一个
    if (near) {
      if (u <= near[1]) return;
      near[1] = u;
    } else if (pts.length >= 2 && at > pts[pts.length - 1][0] && pts[pts.length - 1][1] === u && pts[pts.length - 2][1] === u) {
      pts[pts.length - 1][0] = at; // 没变化的一段只留头尾
    } else {
      pts.push([at, u]);
      pts.sort((a, b) => a[0] - b[0]);
      if (pts.length > 400) pts.splice(0, pts.length - 400);
    }
    histDirty = true;
  }

  function saveHist() {
    if (!histDirty) return;
    histDirty = false;
    const now = Date.now() / 1000;
    for (const name in usageHist) if (!usageHist[name] || usageHist[name].resetsAt < now - 86400) delete usageHist[name];
    lsSet('ctm-usage-hist', JSON.stringify(usageHist));
  }

  // 同一窗口内用量只增不减，所以不论读数先后，同一重置时间取最大值；重置时间更晚的是新窗口。
  // 用量接口说窗口还没开始（重置时间为空）时，比它更早的读数都不再算数
  function mergeLimit(name, u, resetsAt, extra) {
    const cur = limits[name];
    const at = extra.at || 0;
    notePoint(name, resetsAt, u, at);
    if (!resetsAt) {
      if (u > 0 || !at || (cur && cur.at > at)) return false;
      if (cur && !cur.resetsAt) return void (cur.at = at);
      limits[name] = { utilization: 0, resetsAt: 0, at, src: extra.src };
      return true;
    }
    if (cur && !cur.resetsAt && (resetsAt * 1000 <= Date.now() || cur.at > at)) return false;
    const same = !!cur && !!cur.resetsAt && Math.abs(resetsAt - cur.resetsAt) <= 300;
    if (cur && cur.resetsAt && !same && resetsAt < cur.resetsAt) return false; // 已经过去的窗口
    const next = {
      utilization: same ? Math.max(u, cur.utilization) : u,
      resetsAt: same ? cur.resetsAt : resetsAt,
      status: extra.status || (same ? cur.status : undefined),
      severity: extra.severity || (same ? cur.severity : undefined),
      at: Math.max(at, (same && cur.at) || 0),
      src: extra.src === 'official' || !same ? extra.src : cur.src,
    };
    const changed = !same || next.utilization !== cur.utilization || next.status !== cur.status || next.severity !== cur.severity;
    limits[name] = next;
    return changed || next.src !== cur.src;
  }

  function saveLimits() {
    lsSet('ctm-limits', JSON.stringify(limits));
    dirty = true;
  }

  const windowMs = (name) =>
    name === 'five_hour' || /^scoped:session:/.test(name) ? 5 * 3600e3 : /^seven_day|^scoped:weekly:/.test(name) ? 7 * 864e5 : 0;

  // 预测额度什么时候用完。5 小时额度看最近的消耗速度：至少回看 30 分钟，涨不到 3 个百分点就看得更久（最多 90 分钟），
  // 读数不够时用这个窗口开始以来的平均速度。周额度用本周开始以来的平均速度，把不用的时候也算进去，
  // 否则按一阵忙碌的速度会预测得太早。返回 { text, level, tip }；数据不够时返回 null
  function forecast(l) {
    const span = windowMs(l.name);
    const now = Date.now();
    const resetIn = l.resetsAt * 1000 - now;
    if (!span || l.idle || l.expired || resetIn <= 0 || l.used >= 1) return null;
    let rate = -1; // 每毫秒涨多少（比例）
    let basis = '';
    if (span < 864e5) {
      const hist = usageHist[l.name];
      let top = 0;
      const pts = hist && Math.abs(hist.resetsAt - l.resetsAt) <= 300 ? hist.pts.map(([t, u]) => [t, (top = Math.max(top, u))]) : [];
      let anchor = null;
      for (const look of [30, 60, 90]) {
        const a = pts.filter((p) => p[0] <= now - look * 60000).pop();
        if (!a) break;
        anchor = a;
        if (l.used - a[1] >= 0.03) break;
      }
      if (!anchor && pts.length && now - pts[0][0] >= 600000) anchor = pts[0];
      if (anchor) {
        rate = Math.max(0, l.used - anchor[1]) / (now - anchor[0]);
        basis = '最近 ' + fmtSpan(now - anchor[0]) + '的速度';
      }
    }
    if (!basis) {
      const elapsed = now - (l.resetsAt * 1000 - span);
      if (elapsed < (span < 864e5 ? 900000 : 6 * 3600e3)) return null;
      rate = l.used / elapsed;
      basis = span < 864e5 ? '这个窗口开始以来的平均速度' : '本周开始以来的平均速度，含不用的时候';
    }
    const perHour = '（每小时约 +' + (rate * 3600e3 * 100).toFixed(1) + '%）';
    if (rate <= 0) return { text: '最近没有消耗', level: 'normal', tip: `按${basis}：这段时间没有上涨。` };
    const outIn = (1 - l.used) / rate;
    if (outIn < resetIn) {
      return {
        text: '约 ' + fmtSpanShort(outIn) + '后用完 · 早于重置 ' + fmtSpanShort(resetIn - outIn),
        level: outIn < 1800000 ? 'critical' : 'warning',
        tip: `按${basis}${perHour}，约 ${fmtSpan(outIn)}后用到 100%，比重置早 ${fmtSpan(resetIn - outIn)}。`,
      };
    }
    const end = l.used + rate * resetIn;
    return {
      text: '重置时约用到 ' + fmtPct(end),
      level: 'normal',
      tip: `按${basis}${perHour}，到重置时（还有 ${fmtSpan(resetIn)}）约用到 ${fmtPct(end)}，用不完。`,
    };
  }

  // rate_limit_event：每次请求后 CLI 报告的额度读数（已用比例 0~1，重置时间为 unix 秒）
  function recordLimits(info, ctx) {
    if (!info || typeof info !== 'object') return;
    const windows = windowsOf(info);
    const at = ctx.bulk ? ctx.ts || 0 : Date.now();
    let changed = false;
    for (const name in windows) {
      const w = windows[name] || {};
      const resetsAt = num(w.resetsAt);
      if (!resetsAt) continue;
      const status = w.status || (name === info.rateLimitType ? info.status : undefined);
      changed = mergeLimit(name, num(w.utilization), resetsAt, { src: 'event', status, at }) || changed;
    }
    if (changed) saveLimits();
  }

  const isoSec = (v) => {
    const t = typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : NaN;
    return isFinite(t) && t > 0 ? Math.round(t / 1000) : 0;
  };
  const LEGACY_WINDOWS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_oauth_apps'];
  const isWindow = (w) => !!w && typeof w === 'object' && 'utilization' in w && 'resets_at' in w;

  // claude.ai 的用量接口（设置里用量页面用的同一个接口）以及 /usage 的结构化结果：已用百分比（0~100）和 ISO 格式的重置时间。
  // 新格式是服务端排好的 limits[] 行，旧格式是 five_hour / seven_day 这些键
  function recordOfficial(o, at) {
    const rows = [];
    const list = o.limits;
    if (Array.isArray(list) && list.length && list.every((x) => x && typeof x === 'object' && 'kind' in x && 'percent' in x)) {
      for (const x of list) {
        const scope = x.scope || {};
        const who = (scope.model && scope.model.display_name) || (scope.surface && scope.surface.display_name) || '';
        const name =
          x.kind === 'session' && !who ? 'five_hour' : x.kind === 'weekly_all' && !who ? 'seven_day' : 'scoped:' + (x.group || '') + ':' + (who || x.kind);
        rows.push([name, num(x.percent) / 100, isoSec(x.resets_at), x.severity]);
      }
    } else {
      for (const k of LEGACY_WINDOWS) if (isWindow(o[k])) rows.push([k, num(o[k].utilization) / 100, isoSec(o[k].resets_at)]);
      for (const x of Array.isArray(o.model_scoped) ? o.model_scoped : []) {
        if (x && x.display_name && 'utilization' in x) rows.push(['scoped:weekly:' + x.display_name, num(x.utilization) / 100, isoSec(x.resets_at)]);
      }
    }
    const ex = o.extra_usage;
    const hasExtra = !!ex && typeof ex === 'object' && 'is_enabled' in ex;
    if (!rows.length && !hasExtra) return false;
    let changed = false;
    for (const [name, u, resetsAt, severity] of rows) {
      if (resetsAt || !u) changed = mergeLimit(name, u, resetsAt, { src: 'official', severity, at }) || changed;
    }
    if (hasExtra && at) {
      // 金额以货币的最小单位计（美元就是美分）
      extraUsage = { enabled: !!ex.is_enabled, limit: num(ex.monthly_limit), used: num(ex.used_credits), currency: ex.currency || 'USD', at };
      lsSet('ctm-extra', JSON.stringify(extraUsage));
    }
    if (at) officialAt = Math.max(officialAt, at);
    saveLimits();
    return true;
  }

  // 其他 claude.ai 标签页看到的额度也合并进来
  W.addEventListener('storage', (e) => {
    if (!e.newValue) return;
    try {
      if (e.key === 'ctm-limits') {
        const other = JSON.parse(e.newValue) || {};
        let changed = false;
        for (const name in other) {
          const x = other[name] || {};
          changed = mergeLimit(name, num(x.utilization), num(x.resetsAt), { ...x, at: num(x.at) }) || changed;
        }
        if (changed) dirty = true;
      } else if (e.key === 'ctm-extra') {
        extraUsage = JSON.parse(e.newValue);
        dirty = true;
      } else if (e.key === 'ctm-usage-hist') {
        const other = JSON.parse(e.newValue) || {};
        for (const name in other) for (const [t, u] of (other[name] && other[name].pts) || []) notePoint(name, other[name].resetsAt, u, t);
      }
    } catch {}
  });

  // ---------------------------------------------------------------- 事件识别

  function tsOf(o) {
    const v = o.timestamp ?? o.created_at ?? o.createdAt;
    if (v == null || typeof v === 'object') return 0;
    const t = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v);
    return isFinite(t) && t > 0 ? t : 0;
  }

  function handleSystem(o, ctx) {
    switch (o.subtype) {
      case 'init':
        if (isModelId(o.model)) addInfo('model', o.model, 'init', ctx);
        if ('effort' in o) addInfo('effort', o.effort, 'init', ctx);
        if (o.fast_mode_state) addInfo('fast', o.fast_mode_state, 'init', ctx);
        break;
      case 'thinking_tokens':
        thinkingProgress(o, ctx);
        break;
      case 'model_refusal_fallback':
        if (o.scope !== 'local' && isModelId(o.fallback_model)) addInfo('model', o.fallback_model, 'fallback', ctx);
        break;
      case 'compact_boundary': {
        // 压缩之后、下一次请求之前，上下文就是压缩后的大小；之后的缓存也要重新建
        const z = stamp(ctx);
        state.compacts.push(z);
        if (ctx.batch) ctx.batch.push(z);
        const post = num((o.compact_metadata || {}).post_tokens);
        if (post) addInfo('ctx', { used: post, max: 0 }, 'compact', ctx);
        break;
      }
      case 'session_metadata':
        if (o.metadata && typeof o.metadata === 'object') applyMetadata(o.metadata, ctx);
        break;
    }
    return true;
  }

  function handle(o, ctx) {
    switch (o.type) {
      case 'message_start': {
        const msg = o.message || {};
        const lane = laneOf(ctx);
        closeLane(lane);
        const m = messageRecord(msg.id || 'anon-' + ++state.anon, ctx, lane);
        if (msg.usage) recordUsage(m, msg.usage, false);
        if (isModelId(msg.model)) {
          m.model = msg.model;
          if (lane === 'main') addInfo('served', msg.model, 'stream', ctx);
        }
        state.lanes.set(lane, newLane(m, ctx.bulk));
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
        if (s.m) s.m.streamEst = s.est;
        state.samples.push([now, n]);
        dirty = true;
        return true;
      }
      case 'message_delta': {
        const s = state.lanes.get(laneOf(ctx));
        if (!s || !s.m || !o.usage) return true;
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
        // /context、/usage 的结果是 CLI 自己生成的消息，结构化的数据挂在消息外层
        if (o.context_usage && typeof o.context_usage === 'object') handle(o.context_usage, ctx);
        if (o.usage_report && o.usage_report.rate_limits && typeof o.usage_report.rate_limits === 'object') {
          recordOfficial(o.usage_report.rate_limits, ctx.bulk ? ctx.ts || 0 : Date.now());
        }
        const msg = o.message;
        if (!msg || !msg.usage || (typeof msg.model === 'string' && msg.model[0] === '<')) return true;
        const lane = o.parent_tool_use_id || 'main';
        const m = messageRecord(msg.id || o.uuid, ctx, lane);
        recordUsage(m, msg.usage, false);
        if (isModelId(msg.model)) {
          m.model = msg.model;
          if (lane === 'main') addInfo('served', msg.model, 'assistant', ctx);
        }
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
      case 'system':
        return handleSystem(o, ctx);
      case 'conversation_reset': {
        // /clear：累计值从零重新开始，之前的上下文也作废了
        const z = stamp(ctx);
        state.resets.push(z);
        if (ctx.batch) ctx.batch.push(z);
        state.rev++;
        dirty = true;
        return true;
      }
      case 'control_request':
        if (o.request && typeof o.request === 'object') handleRequest(o.request, ctx);
        return true;
      case 'rate_limit_event':
        recordLimits(o.rate_limit_info, ctx);
        recordReadings(o.rate_limit_info, ctx);
        return true;
      default: {
        if (o.rate_limit_info && typeof o.rate_limit_info === 'object') {
          recordLimits(o.rate_limit_info, ctx);
          recordReadings(o.rate_limit_info, ctx);
          return true;
        }
        // get_context_usage 的响应
        if (typeof o.totalTokens === 'number' && typeof o.maxTokens === 'number' && 'percentage' in o) {
          addInfo('ctx', { used: o.totalTokens, max: o.maxTokens, compactAt: num(o.autoCompactThreshold) }, 'query', ctx);
          if (isModelId(o.model)) addInfo('model', o.model, 'context', ctx);
          return true;
        }
        // /context 结果的结构化数据
        if (typeof o.total_tokens === 'number' && typeof o.raw_max_tokens === 'number' && 'percentage' in o) {
          addInfo('ctx', { used: o.total_tokens, max: o.raw_max_tokens }, 'query', ctx);
          if (isModelId(o.model)) addInfo('model', o.model, 'context', ctx);
          return true;
        }
        // get_settings 的响应：applied 是会话实际生效的模型和推理强度
        const ap = o.applied;
        if (ap && typeof ap === 'object' && ('effort' in ap || 'ultracode' in ap)) {
          if (isModelId(ap.model)) addInfo('model', ap.model, 'settings', ctx);
          if ('effort' in ap) addInfo('effort', ap.effort, 'settings', ctx);
          if ('ultracode' in ap) addInfo('ultracode', ap.ultracode === true, 'settings', ctx);
          return true;
        }
        // 会话对象（云端会话）
        const md = o.external_metadata;
        if (md && typeof md === 'object' && !Array.isArray(md)) {
          if (isCurrentSession(o)) {
            applyMetadata(md, ctx);
            const sc = o.session_context;
            if (sc && isModelId(sc.model)) addInfo('model', sc.model, 'session', ctx);
          }
          return true;
        }
        if (o.subtype === 'set_model' || o.subtype === 'apply_flag_settings') {
          handleRequest(o, ctx);
          return true;
        }
        // claude.ai 用量接口、get_usage 的响应
        if (
          (Array.isArray(o.limits) && o.limits.length && o.limits[0] && 'percent' in o.limits[0]) ||
          LEGACY_WINDOWS.some((k) => isWindow(o[k]))
        ) {
          return recordOfficial(o, ctx.bulk ? ctx.ts || 0 : Date.now());
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

  // 对话内容（用户消息、工具调用与结果、正文块）里可能有看起来像事件的 JSON（比如读到的日志文件），不往里找
  const CONTENT_TYPES = new Set([
    'user',
    'text',
    'thinking',
    'redacted_thinking',
    'tool_use',
    'tool_result',
    'server_tool_use',
    'mcp_tool_use',
    'mcp_tool_result',
    'web_search_tool_result',
    'web_fetch_tool_result',
    'code_execution_tool_result',
    'bash_code_execution_tool_result',
    'document',
    'image',
    'tool_progress',
    'tool_use_summary',
    'prompt_suggestion',
  ]);
  const NESTED_JSON = /tokens|delta|_start|_stop|rate_limit|"model"|effort|utilization|"subtype"/i;

  function countType(o) {
    const k = typeof o.type === 'string' ? o.type.slice(0, 40) + (typeof o.subtype === 'string' ? '/' + o.subtype.slice(0, 40) : '') : '';
    if (k && (k in state.types || Object.keys(state.types).length < 150)) state.types[k] = (state.types[k] || 0) + 1;
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
    if (o.type) {
      countType(o);
      if (debug) log(ctx.bulk ? '(history)' : '(live)', o.type, o.subtype || o.event?.type || o.delta?.type || '');
    }
    if (handle(o, ctx) || CONTENT_TYPES.has(o.type)) return;
    for (const k in o) {
      if (k === 'tool_use_result') continue; // 工具结果的结构化副本
      const v = o[k];
      if (v && typeof v === 'object') walk(v, ctx, depth + 1);
      else if (typeof v === 'string' && v.length > 20 && (v[0] === '{' || v[0] === '[') && NESTED_JSON.test(v)) {
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
    if (batch && batch.length) {
      fillBatchTimes(batch);
      sortResults(); // 时间戳补齐之后先后可能变了
    }
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

  // message_stop、content_block_start、rate_limit_event 里没有 tokens；会话对象、用量接口里也不一定有
  const WORTH_PARSING = /tokens|_delta|_start|_stop|rate_limit|external_metadata|effort|utilization|conversation_reset|"subtype"/i;

  function ingestText(text, src) {
    if (typeof text !== 'string' || !text || text.length > 50e6) return;
    if (!WORTH_PARSING.test(text)) return;
    try {
      ingestObj(JSON.parse(text), src);
      return;
    } catch {}
    for (const line of text.split('\n')) ingestLine(line, src);
  }

  // 网页发出去的数据只看切换模型、改推理强度这两种控制请求，别的一概不碰
  function ingestOutgoing(body) {
    if (typeof body !== 'string' || body.length > 2e6 || !/set_model|apply_flag_settings/.test(body)) return;
    try {
      findRequests(JSON.parse(body), 0);
    } catch {}
  }

  function findRequests(o, depth) {
    if (!o || typeof o !== 'object' || depth > 8 || CONTENT_TYPES.has(o.type)) return;
    if (Array.isArray(o)) return void o.forEach((v) => findRequests(v, depth + 1));
    if (o.subtype === 'set_model' || o.subtype === 'apply_flag_settings') return void handleRequest(o, { src: 'out' });
    for (const k in o) if (o[k] && typeof o[k] === 'object') findRequests(o[k], depth + 1);
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

  // 累计值在 /clear 之后、或者续接时没有存档的情况下会从零重新开始。按先后把 result 分成几段（同一段里
  // 累计值只增不减），各段最后一条相加才是整个会话的用量
  let runsCache = null;
  function runs() {
    if (runsCache && runsCache.state === state && runsCache.rev === state.rev) return runsCache.list;
    const list = [];
    let cur = null;
    let prev = null;
    for (const r of state.results) {
      if (prev && sameResult(prev, r)) continue; // 同一条 result 从两个通道各来了一次，或者是没有请求的一轮
      if (!prev || restarted(prev, r)) list.push((cur = []));
      cur.push(r);
      prev = r;
    }
    runsCache = { state, rev: state.rev, list };
    return list;
  }

  function sameResult(a, b) {
    if (Math.abs(a.cost - b.cost) > 1e-9 || !a.totals !== !b.totals) return false;
    return !a.totals || KINDS.every((k) => a.totals[k] === b.totals[k]);
  }

  function restarted(p, r) {
    if (r.cost < p.cost - 1e-6) return true;
    if (p.totals && r.totals) {
      for (const k of KINDS) if (r.totals[k] < p.totals[k]) return true;
      for (const name in p.byModel) if (!r.byModel[name]) return true; // 某个模型的累计值不见了
    }
    return state.resets.some((z) => isAfter(z, p) && isAfter(r, z)); // 两条之间有 /clear
  }

  function sessionTotals() {
    const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0, cost: 0, approx: false, approxCost: false, runs: 0, models: {} };
    let base = null; // 最后一条 result
    for (const run of runs()) {
      const r = run[run.length - 1];
      t.runs++;
      t.cost += r.cost;
      t.thinking += r.thinking;
      if (r.totals) for (const k of KINDS) t[k] += r.totals[k];
      for (const name in r.byModel) {
        const s = (t.models[modelName(name) || name] ||= { cost: 0, output: 0 });
        s.cost += r.byModel[name].cost;
        s.output += r.byModel[name].output;
      }
      base = r;
    }
    // 本轮还没结束的请求：用量按事件累加，费用按上一段的平均单价估算
    let pending = 0;
    for (const m of state.messages.values()) {
      if (base && !isAfter(m, base)) continue; // 已计入 result 的累计值
      const out = messageOutput(m);
      t.input += m.input;
      t.output += out;
      t.cacheRead += m.cacheRead;
      t.cacheWrite += m.cacheWrite;
      pending += weightOf(m, out);
      if (!m.exact) t.approx = true;
    }
    if (pending && base && base.totals && base.cost) {
      t.cost += (base.cost / weightOf(base.totals, base.totals.output)) * pending;
      t.approxCost = true;
    }
    t.requests = state.messages.size;
    return t;
  }

  // 上一轮：输出 token 数与平均速度
  function lastTurn() {
    const list = runs();
    const run = list[list.length - 1];
    if (!run) return null;
    const cur = run[run.length - 1];
    const prev = run[run.length - 2];
    let tokens = cur.turn.output;
    let ms = 0;
    if (prev) {
      // 同一段里相邻两条之差：本轮全部请求（含子代理）的输出和 API 耗时
      if (cur.totals && prev.totals && cur.totals.output > prev.totals.output) tokens = cur.totals.output - prev.totals.output;
      ms = cur.apiMs - prev.apiMs;
    } else if (cur.apiMs <= cur.wallMs * 1.1) ms = cur.apiMs; // 一段的第一条：duration_api_ms 不超过本轮时长时可能就是本轮的
    if (!tokens) return null;
    return ms > 0 ? { tokens, ms, speed: tokens / (ms / 1000) } : { tokens, ms: 0, speed: null };
  }

  function latestOf(list, weight) {
    let best = null;
    for (const x of list) if (!best || compare(x, best, weight) > 0) best = x;
    return best;
  }

  // 当前模型的上下文窗口：最近一条 result 里这个模型的 contextWindow；对不上时取最大的
  function windowFor(id) {
    const r = state.results[state.results.length - 1];
    if (!r) return 0;
    const want = modelName(id).replace(/ 1M$/, '');
    for (const name in r.byModel) if (want && modelName(name).replace(/ 1M$/, '') === want && r.byModel[name].window) return r.byModel[name].window;
    return r.window;
  }

  // 当前上下文：主对话最近一次请求的输入（含缓存），或者更新的明确读数（上下文查询、会话元数据、压缩边界）；/clear 之前的不算
  function contextNow() {
    const cut = latestOf(state.resets, (x) => x.seq);
    let best = null;
    const consider = (x, used, max) => {
      if (used <= 0 || (cut && !isAfter(x, cut))) return;
      if (!best || isAfter(x, best.x) || (!isAfter(best.x, x) && used > best.used)) best = { x, used, max };
    };
    for (const m of state.messages.values()) if (m.lane === 'main') consider(m, messageContext(m), 0);
    let compactAt = 0;
    for (const x of state.info.ctx || []) {
      consider(x, num(x.value.used), num(x.value.max));
      if (num(x.value.compactAt)) compactAt = x.value.compactAt;
    }
    if (!best) return null;
    return { used: best.used, max: best.max || windowFor(modelInfo().id), compactAt, src: best.x.src || 'request' };
  }

  // ---------------------------------------------------------------- 提示缓存

  // 主对话每次请求都会读上一次请求留下的提示缓存。缓存在最后一次使用之后按 TTL 过期：Claude Code 给订阅用户的
  // 主对话用 1 小时，用到额外用量时是 5 分钟。过期之后，或者切换了模型、推理强度、快速模式，下一次请求要把整个
  // 上下文按缓存写入价重新写一遍，比命中缓存贵得多，也照样消耗订阅额度

  // 每百万 token 的输入单价和缓存读取单价（美元，2026 年 10 月的 API 标价）。缓存写入是输入单价的 2 倍（1 小时）
  // 或 1.25 倍（5 分钟），快速模式整体翻倍；Haiku 5.5 的提示超过 10 万 token 时单价是 5 倍。没列出的模型按本会话的花费反推
  const CACHE_PRICES = [
    [/fable-5-1|mythos-5-1/, 10, 0.25],
    [/fable|mythos/, 10, 1],
    [/opus-5-5/, 4, 0.2],
    [/opus-(5|4-[5-9])\b/, 5, 0.5],
    [/opus/, 15, 1.5],
    [/sonnet-5/, 2, 0.2],
    [/sonnet/, 3, 0.3],
    [/haiku-5/, 0.1, 0.01, 100000, 5],
    [/haiku-4/, 1, 0.1],
    [/haiku/, 0.8, 0.08],
  ];
  const TTL_MS = { '5m': 300000, '1h': 3600000 };

  // 每个 token 的价格：{ write: 缓存写入, read: 缓存读取, input: 不走缓存的输入, listed: 是否来自价目表 }
  function cachePrices(model, tokens, ttl, fast) {
    const row = CACHE_PRICES.find(([re]) => re.test(String(model || '').toLowerCase()));
    let input;
    let read;
    if (row) {
      const tier = row[3] && tokens > row[3] ? row[4] : 1;
      input = row[1] * tier;
      read = row[2] * tier;
    } else {
      const r = state.results[state.results.length - 1];
      const want = modelName(model).replace(/ 1M$/, '');
      const name = r && Object.keys(r.byModel).find((k) => modelName(k).replace(/ 1M$/, '') === want);
      const x = name && r.byModel[name];
      const w = x ? weightOf(x, x.output) : 0;
      if (!w || !x.cost) return null;
      input = (x.cost / w) * 1e6;
      read = input * PRICE_RATIO.cacheRead;
    }
    const k = (fast ? 2 : 1) / 1e6;
    return { write: input * (ttl === '5m' ? 1.25 : 2) * k, read: read * k, input: input * k, listed: !!row };
  }

  const wallOf = (x) => (x.live ? x.at : x.ts); // 实时事件用到达时间，历史记录用事件时间
  const between = (list, a, b) => list.some((z) => isAfter(z, a) && isAfter(b, z));

  // 某项设置（推理强度、快速模式）在 a 之后、b 之前有没有变过；a 之前不知道是什么值时说不清，算没变
  function changedBetween(key, a, b) {
    const list = state.info[key] || [];
    let before = null;
    for (const x of list) if (!isAfter(x, a) && (!before || compare(x, before, (y) => y.seq) > 0)) before = x;
    return !!before && list.some((x) => isAfter(x, a) && isAfter(b, x) && x.value !== before.value);
  }

  // { ttl, ttlKnown, warmAt, expiresAt, tokens: 下一次请求的上下文, nextExtra: 缓存过期后下一次请求多花的钱,
  //   listed, rebuilds: [{ t, tokens, cause, expected, extra }] }
  function cacheState() {
    const main = [];
    for (const m of state.messages.values()) if (m.lane === 'main' && orderKey(m) != null && messageContext(m) > 0) main.push(m);
    if (!main.length) return null;
    main.sort((a, b) => orderKey(a) - orderKey(b));
    let ttl = '';
    for (let i = main.length - 1; i >= 0 && !ttl; i--) ttl = main[i].ttl;
    const ttlKnown = !!ttl;
    ttl ||= '1h'; // 请求的用量里没有写入明细时，按订阅用户的默认值

    // 缓存重建：上一次请求的整个提示本该从缓存读出来，读到的少很多就是重建了。/clear、压缩之后的重建是正常的，不算多花
    const rebuilds = [];
    for (let i = 1; i < main.length; i++) {
      const p = main[i - 1];
      const m = main[i];
      const prev = messageContext(p);
      const missed = prev - m.cacheRead;
      if (missed < Math.max(20000, prev * 0.2)) continue;
      const gap = wallOf(m) - wallOf(p);
      let cause;
      let expected = false;
      if (between(state.resets, p, m)) [cause, expected] = ['/clear 之后的新对话', true];
      else if (between(state.compacts, p, m) || messageContext(m) < prev * 0.6) [cause, expected] = ['上下文压缩后重建', true];
      else if (gap > TTL_MS[p.ttl || ttl]) cause = '闲置 ' + fmtSpan(gap) + '，缓存过期';
      else if (p.model && m.model && modelName(p.model) !== modelName(m.model)) cause = '切换了模型';
      else if (changedBetween('effort', p, m)) cause = '改了推理强度';
      else if (p.fast !== m.fast || changedBetween('fast', p, m)) cause = '切换了快速模式';
      else cause = '原因不明：工具、系统提示或较早的消息变了';
      const pr = cachePrices(m.model, prev, m.ttl || ttl, m.fast);
      const extra = expected || !pr ? 0 : missed * ((m.cacheWrite >= missed / 2 ? pr.write : pr.input) - pr.read);
      rebuilds.push({ t: wallOf(m), tokens: missed, cause, expected, extra });
    }

    const last = main[main.length - 1];
    const cut = latestOf(state.resets, (x) => x.seq);
    const c = contextNow();
    const tokens = c && !(cut && isAfter(cut, last)) ? c.used : 0; // /clear 之后旧缓存用不上了
    const mi = modelInfo();
    const pr = cachePrices(last.model || mi.id, tokens, ttl, mi.fast);
    return {
      ttl,
      ttlKnown,
      warmAt: wallOf(last),
      expiresAt: wallOf(last) + TTL_MS[last.ttl || ttl],
      tokens,
      nextExtra: pr && tokens ? tokens * (pr.write - pr.read) : 0,
      listed: !!pr && pr.listed,
      rebuilds,
    };
  }

  // ---------------------------------------------------------------- 额度折合多少钱

  // 思路：本会话每次请求花了多少钱是知道的；额度每涨一个百分点时会话累计花了多少，也能对上。
  // 相邻两次跳变之间的花费 ÷ 跳过的百分点数，就是“每 1% 折合多少美元”。这假设这段时间账号没有
  // 别处的使用，所以各段取中位数，偶尔混进别处的使用也不至于带偏。

  // 各类 token 的相对价格（以输入为 1）。只用来在一轮之内分摊花费，每轮总花费以 result 为准
  const PRICE_RATIO = { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 2 };
  const SIG_TOKENS = 0.24; // 思考签名每个字符大约对应的思考 token 数
  const IDLE_GAP_MS = 300000; // 会话闲置超过 5 分钟，前后的读数不配对：期间别处的使用会混进来
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
    const prevOf = new Map(); // result -> 同一段里的上一条（段落第一条为 null；重复的 result 不在里面）
    for (const run of runs()) run.forEach((r, i) => prevOf.set(r, i ? run[i - 1] : null));

    // 第一遍：按 result 分轮，把每轮的花费按 token 权重分到各次请求上
    const cost = new Map();
    let pending = [];
    let scale = 0; // 每单位权重折合的美元，用最近一轮校准，估算还没结束的这一轮
    let apiSec = 0;
    let apiCost = 0;
    for (const [, kind, x] of items) {
      if (kind === 0) pending.push(x);
      if (kind !== 1 || !prevOf.has(x)) continue;
      const p = prevOf.get(x);
      // 本轮花费：同一段里相邻两条 result 的累计费用之差，包括子代理、压缩等本轮的全部请求。
      // 一段的第一条没有可比的上一条，只能按本轮用量估算；result.usage 只含主对话，所以本轮有子代理时不估
      let turnCost = 0;
      let outTotal = x.turn.output;
      if (p) {
        turnCost = Math.max(0, x.cost - p.cost);
        if (x.totals && p.totals) outTotal = Math.max(0, x.totals.output - p.totals.output);
      } else if (x.totals && pending.every((m) => m.lane === 'main')) {
        turnCost = (x.cost / weightOf(x.totals, x.totals.output)) * weightOf(x.turn, x.turn.output);
      }
      // 本轮的输出数分到各次请求：有精确值的直接用，其余按正文长度和思考签名长度分
      const rest = Math.max(0, outTotal - pending.reduce((s, m) => s + (m.exact ? m.output : 0), 0));
      const share = (m) => (m.exact ? 0 : m.blockEst + SIG_TOKENS * m.sig + 1);
      const shares = pending.reduce((s, m) => s + share(m), 0);
      const w = pending.map((m) => weightOf(m, m.exact ? m.output : (rest * share(m)) / shares));
      const total = w.reduce((s, v) => s + v, 0);
      if (turnCost && total) {
        pending.forEach((m, i) => cost.set(m, (turnCost * w[i]) / total));
        scale = turnCost / total;
      }
      // 模型运行时间：duration_api_ms 是累计值，取同一段里的差；一段的第一条只在不超过本轮时长时才当作本轮的
      const ms = p ? x.apiMs - p.apiMs : x.apiMs <= x.wallMs * 1.1 ? x.apiMs : 0;
      if (turnCost && ms > 0) {
        apiSec += ms / 1000;
        apiCost += turnCost;
      }
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
    let gap = 0; // 遇到算不出花费的请求或长时间闲置，之后的读数不能和之前的配对
    let lastWall = 0;
    for (const [, kind, x] of items) {
      const wall = x.live ? x.at : x.ts; // 实时事件用到达时间，历史记录用事件时间
      if (lastWall && wall - lastWall > IDLE_GAP_MS) gap++;
      lastWall = wall;
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
      let prev = null; // [目前为止的最大读数, 段号]
      let step = null;
      for (const [u, c, g] of groups[key]) {
        // 读数偶尔会回落一格再回来（不同请求带回的值不完全一致），所以只有超过之前最大值才算“刚跨过一格”。
        // 还要和上一个读数在同一段连续使用里：闲置之后的第一个读数可能早就跨过去了（别处用的），不能当起点
        if (prev && prev[1] === g && u > prev[0]) {
          const pts = step && step[2] === g ? Math.round((u - step[0]) * 100) : 0;
          if (pts > 0 && c > step[1]) (samples[name] ||= []).push([(c - step[1]) / pts, pts, step[1], c]);
          step = [u, c, g];
        }
        prev = [prev ? Math.max(prev[0], u) : u, g];
      }
    }
    // 别处的使用表现为“一次跳好几格、本会话却没花多少”，这种段的单价明显低于中位数。它同时影响所有
    // 窗口，但在 7 天这种粗刻度上看不出来，所以按会话花费的区间，把其他窗口里同一段也排除掉
    const outside = [];
    for (const name in samples) {
      // 中位数不按格数加权：否则一次跳很多格的异常段自己就成了中位数
      const med = weightedMedian(samples[name].map(([v]) => [v, 1]));
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

    // 两个额度的涨幅之比：同一事件里 5 小时额度和其他额度的读数一起看，同一对窗口内各取首个读数和最大值。
    // 这和花费无关，别处的使用也会让两者按同样比例上涨，所以闲置期间的数据也能用
    const events = new Map();
    for (const q of state.readings) {
      if (orderKey(q) == null) continue;
      if (!events.has(q.ev)) events.set(q.ev, { k: orderKey(q) });
      events.get(q.ev)[q.name] = q;
    }
    const spans = {};
    for (const e of [...events.values()].sort((a, b) => a.k - b.k)) {
      const f = e.five_hour;
      if (!f) continue;
      for (const name in e) {
        const q = e[name];
        if (name === 'k' || name === 'five_hour') continue;
        const key = name + '|' + Math.round(f.resetsAt / 600) + '|' + Math.round(q.resetsAt / 600);
        const sp = (spans[key] ||= [name, f.u, f.u, q.u, q.u]);
        sp[2] = Math.max(sp[2], f.u);
        sp[4] = Math.max(sp[4], q.u);
      }
    }
    const ratio = {};
    for (const [name, f0, f1, q0, q1] of Object.values(spans)) {
      const r = (ratio[name] ||= [0, 0]);
      r[0] += Math.round((f1 - f0) * 100);
      r[1] += Math.round((q1 - q0) * 100);
    }
    for (const name in ratio) if (ratio[name][0] || ratio[name][1]) (rates.ratio ||= {})[name] = ratio[name];
    return rates;
  }

  // 每个会话的估算按会话路径存进 localStorage，显示时把最近各会话的结果合起来，
  // 这样换到新会话也能立刻看到，用得越多越准
  // v4：之前版本在子代理较多的轮次里把本轮花费算少了，估出的单价偏低，直接丢弃
  const RATE_KEY = 'ctm-rates-v4';
  let rateStore = {};
  try {
    for (const k of ['ctm-rates', 'ctm-rates-v2', 'ctm-rates-v3']) localStorage.removeItem(k);
    rateStore = JSON.parse(lsGet(RATE_KEY) || '{}') || {};
  } catch {}
  let quotaCache = null;
  let quotaAt = 0;
  W.addEventListener('storage', (e) => {
    if (e.key !== RATE_KEY || !e.newValue) return;
    try {
      rateStore = JSON.parse(e.newValue) || {};
      quotaCache = null;
      dirty = true;
    } catch {}
  });

  // { 窗口名: { perPoint: 每 1% 美元数, points: 依据的百分点数, dollars: 依据的花费 }, secPerDollar: 每美元对应的模型运行秒数 }
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
      lsSet(RATE_KEY, JSON.stringify(rateStore));
    }
    const acc = {};
    const ratios = {};
    let sec = 0;
    let dollars = 0;
    for (const k in rateStore) {
      const r = (rateStore[k] && rateStore[k].r) || {};
      for (const name in r.ratio || {}) {
        const s = (ratios[name] ||= [0, 0]);
        s[0] += num(r.ratio[name][0]);
        s[1] += num(r.ratio[name][1]);
      }
      for (const name in r) {
        if (name === 'ratio') continue;
        const [a, b] = r[name] || [];
        if (name === 'sec') {
          sec += num(a);
          dollars += num(b);
        } else if (num(a) > 0 && num(b) > 0) {
          // 各会话按花费加权：被别处使用污染的会话“格数多、花费少”，按格数加权会被它带偏
          const s = (acc[name] ||= { sum: 0, dollars: 0, points: 0 });
          s.sum += a * a * b;
          s.dollars += a * b;
          s.points += b;
        }
      }
    }
    const out = {};
    for (const name in acc) {
      const a = acc[name];
      out[name] = { perPoint: a.sum / a.dollars, points: a.points, dollars: a.dollars };
    }
    // 5 小时以外的额度另有一种算法：5 小时额度的单价 × 两者涨幅之比。它不用分摊花费，闲置期间的数据
    // 也能用，但 7 天额度涨得慢、取整误差大。两者互相核对：相差不到 40% 时用直接估算（每格更精确），
    // 差得多说明直接估算被带偏了（7 天额度每格要好几美元，一个会话里只有两三个样本），改用比例法
    const five = out.five_hour;
    for (const name in ratios) {
      const [d5, dn] = ratios[name];
      if (!five || dn < 3 || !d5) continue;
      const viaRatio = (five.perPoint * d5) / dn;
      const direct = out[name];
      if (!direct || direct.perPoint < viaRatio / 1.4 || direct.perPoint > viaRatio * 1.4) {
        out[name] = { perPoint: viaRatio, points: dn, ratio: d5 / dn };
      }
    }
    if (sec > 0 && dollars > 0) out.secPerDollar = sec / dollars;
    return (quotaCache = out);
  }

  // ---------------------------------------------------------------- 网络挂钩

  const TAP_TYPES = /json|event-stream|ndjson|text\/plain/i;
  const STREAM_TYPES = /event-stream|ndjson|jsonl/i;
  let orgId = ''; // 当前组织，查询用量接口要用

  function noteUrl(url) {
    const m = /\/api\/organizations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(url || '');
    if (m) orgId = m[1];
  }

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
    W.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : input && (input.url || String(input));
      safe(() => {
        noteUrl(url);
        if (init && typeof init.body === 'string') ingestOutgoing(init.body);
      })();
      const p = origFetch.apply(this, arguments);
      p.then(
        safe((res) => {
          const ct = res.headers.get('content-type') || '';
          if (!res.body || !TAP_TYPES.test(ct)) return;
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
    const origOpen = XHR.open;
    XHR.open = function (method, url) {
      safe(noteUrl)(String(url));
      return origOpen.apply(this, arguments);
    };
    const origSend = XHR.send;
    XHR.send = function (body) {
      safe(ingestOutgoing)(body);
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
      const send = ws.send;
      ws.send = function (data) {
        safe(ingestOutgoing)(data);
        return send.apply(this, arguments);
      };
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

  // ---------------------------------------------------------------- 主动刷新额度

  // 额度读数平时只随请求更新：两轮之间、在别的设备上用过之后都会过时，窗口重置后也要等下一次请求。
  // claude.ai 设置里的用量页面有个只读接口，这里低频地查一下：页面可见时每 3 分钟，一轮结束后、展开面板时
  // 最多每分钟一次；多个标签页共用一次结果。连续失败 3 次就停下（接口变了），可以在面板底部关掉
  const POLL_MS = 180000;
  let pollOn = lsGet('ctm-poll') !== '0';
  let pollFails = 0;
  let pollBusy = false;
  let pollAt = 0;
  let pollErr = '';

  function currentOrg() {
    if (orgId) return orgId;
    const m = /(?:^|;\s*)lastActiveOrg=([0-9a-f-]{36})/i.exec(document.cookie || '');
    return m ? m[1] : '';
  }

  async function pollUsage(soon) {
    if (!pollOn || pollBusy || pollFails >= 3 || !origFetch || document.visibilityState === 'hidden') return;
    const now = Date.now();
    if (now - Math.max(pollAt, +lsGet('ctm-poll-at') || 0) < (soon ? 60000 : POLL_MS)) return;
    const org = currentOrg();
    if (!org) return;
    pollBusy = true;
    pollAt = now;
    lsSet('ctm-poll-at', String(now));
    try {
      const res = await origFetch.call(W, '/api/organizations/' + org + '/usage', {
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      if (!recordOfficial(await res.json(), Date.now())) throw new Error('无法识别的返回格式');
      pollFails = 0;
      pollErr = '';
      log('usage poll ok');
    } catch (e) {
      pollFails++;
      pollErr = String((e && e.message) || e);
      log('usage poll failed', e);
    } finally {
      pollBusy = false;
      dirty = true;
    }
  }
  document.addEventListener('visibilitychange', () => pollUsage(false));

  // ---------------------------------------------------------------- 诊断

  function diagnostics() {
    const pick = (k) => {
      const x = latestInfo(k);
      return x ? { value: x.value === undefined ? null : x.value, src: x.src, live: x.live } : null;
    };
    return {
      version: VERSION,
      time: new Date().toISOString(),
      page: location.pathname.replace(/[A-Za-z0-9_-]{16,}/g, '<id>'),
      model: pick('model'),
      served: pick('served'),
      effort: pick('effort'),
      fast: pick('fast'),
      ultracode: pick('ultracode'),
      runs: runs().map((run) => {
        const r = run[run.length - 1];
        return { results: run.length, cost: +r.cost.toFixed(4), totals: r.totals, models: Object.keys(r.byModel) };
      }),
      totals: sessionTotals(),
      lastTurn: lastTurn(),
      context: contextNow(),
      cache: (() => {
        const cs = cacheState();
        if (!cs) return null;
        const { rebuilds, ...rest } = cs;
        return { ...rest, expiresIn: Math.round((cs.expiresAt - Date.now()) / 1000), rebuilds: rebuilds.map(({ t, ...r }) => ({ ...r, ago: Math.round((Date.now() - t) / 1000) })) };
      })(),
      limits,
      forecasts: Object.fromEntries(limitViews().map((l) => [l.name, forecast(l)])),
      usageHist: Object.fromEntries(Object.entries(usageHist).map(([k, x]) => [k, x.pts.length])),
      extraUsage,
      quota: quotaRates(),
      poll: { on: pollOn, fails: pollFails, error: pollErr, org: !!currentOrg(), at: pollAt ? new Date(pollAt).toISOString() : null },
      counts: {
        messages: state.messages.size,
        results: state.results.length,
        readings: state.readings.length,
        resets: state.resets.length,
        lanes: state.lanes.size,
      },
      calib: +state.calib.toFixed(3),
      types: state.types,
    };
  }

  // ---------------------------------------------------------------- UI

  const fmt = (n) => {
    n = Math.round(n || 0);
    if (n >= 1e6) return +(n / 1e6).toFixed(2) + 'M';
    if (n >= 1e4) return +(n / 1e3).toFixed(1) + 'k';
    return n.toLocaleString();
  };
  const fmtSpeed = (s) => (s == null ? '–' : s.toFixed(1));
  const fmtPct = (f) => Math.round(f * 100) + '%';
  const fmtCost = (c, short) => '$' + c.toFixed(c >= 1 || (short && c >= 0.1) ? 2 : short || c >= 0.1 ? 3 : 4);
  const fmtUsd = (v, precise) => '$' + (precise ? v.toFixed(2) : v >= 10 ? Math.round(v).toLocaleString() : v.toFixed(1));
  const fmtHours = (h) => (h < 1 ? Math.max(1, Math.round(h * 60)) + ' 分钟' : (h < 10 ? h.toFixed(1) : Math.round(h)) + ' 小时');

  // 时长：45 秒、4 分 31 秒、1 小时 5 分
  function fmtDur(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + ' 秒';
    if (s < 3600) return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
    return Math.floor(s / 3600) + ' 小时 ' + Math.floor((s % 3600) / 60) + ' 分';
  }

  // 较长的时间段：45 秒、42 分钟、1 小时 15 分钟、2.3 天
  function fmtSpan(ms) {
    const m = Math.round(Math.max(0, ms) / 60000);
    if (m < 1) return Math.round(Math.max(0, ms) / 1000) + ' 秒';
    if (m < 60) return m + ' 分钟';
    if (m < 1440) return Math.floor(m / 60) + ' 小时' + (m % 60 ? ' ' + (m % 60) + ' 分钟' : '');
    return +(m / 1440).toFixed(1) + ' 天';
  }

  // 放在窄的一行里：42 分钟、1.5 小时、2.3 天
  const fmtSpanShort = (ms) => (ms < 3600e3 ? fmtSpan(ms) : ms < 864e5 ? +(ms / 3600e3).toFixed(1) + ' 小时' : +(ms / 864e5).toFixed(1) + ' 天');

  function fmtAgo(ms) {
    const m = Math.round((Date.now() - ms) / 60000);
    return m < 1 ? '刚刚' : m < 60 ? m + ' 分钟前' : m < 1440 ? Math.round(m / 60) + ' 小时前' : Math.round(m / 1440) + ' 天前';
  }

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
      surface: 'rgba(252,252,251,0.97)',
      ink: '#0b0b0b',
      ink2: '#52514e',
      muted: '#898781',
      hair: 'rgba(11,11,11,0.10)',
      control: 'rgba(11,11,11,0.06)',
      shadow: '0 6px 24px rgba(0,0,0,0.12), 0 1px 3px rgba(0,0,0,0.08)',
      accent: '#2a78d6',
      chipBg: 'rgba(42,120,214,0.12)',
      chipInk: '#1f62b5',
      trackAlpha: 0.16,
    },
    dark: {
      surface: 'rgba(30,30,29,0.96)',
      ink: '#f0efec',
      ink2: '#c3c2b7',
      muted: '#8f8d86',
      hair: 'rgba(255,255,255,0.10)',
      control: 'rgba(255,255,255,0.08)',
      shadow: '0 8px 28px rgba(0,0,0,0.5)',
      accent: '#3987e5',
      chipBg: 'rgba(57,135,229,0.22)',
      chipInk: '#9cc4f7',
      trackAlpha: 0.26,
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
    for (const k in theme) if (typeof theme[k] === 'string') ui.root.style.setProperty('--' + k, theme[k]);
    ui.root.style.colorScheme = name;
    pillKey = '';
    dirty = true;
  }

  // 面板放在 shadow DOM 里，和页面的样式互不影响。样式表用 adoptedStyleSheets 加载，不受页面 CSP 对内联样式的限制
  const CSS = `
    .root { font: 12px/1.5 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      color: var(--ink); background: var(--surface); border: 1px solid var(--hair); border-radius: 12px;
      box-shadow: var(--shadow); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
      user-select: none; -webkit-user-select: none; font-variant-numeric: tabular-nums; letter-spacing: normal;
      text-align: left; overflow: hidden; }
    .root.compact { border-radius: 999px; }
    .pill { display: none; align-items: center; gap: 7px; padding: 4px 12px 4px 10px; cursor: pointer; white-space: nowrap; }
    .compact .pill { display: flex; }
    .full { display: none; width: 268px; }
    .root:not(.compact) .full { display: block; }
    .pill-text { display: flex; align-items: center; gap: 6px; }
    .pill-text b { font-weight: 600; }
    .muted { color: var(--muted); }
    .sq { display: inline-block; width: 7px; height: 7px; border-radius: 2px; margin-right: 4px; vertical-align: 1px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; transition: opacity .3s, background-color .3s; }
    .head { display: flex; align-items: center; gap: 8px; padding: 7px 6px 7px 12px; cursor: move; border-bottom: 1px solid var(--hair); }
    .title { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; }
    .model { font-weight: 600; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .chips { display: flex; gap: 4px; flex: none; }
    .chip { font-size: 11px; line-height: 17px; padding: 0 7px; border-radius: 999px; background: var(--chipBg);
      color: var(--chipInk); font-weight: 500; white-space: nowrap; }
    .chip.alt { background: var(--control); color: var(--ink2); }
    .icon { flex: none; width: 24px; height: 24px; display: grid; place-items: center; padding: 0; border: 0;
      border-radius: 6px; background: transparent; color: var(--ink2); font: 14px/1 system-ui, sans-serif; cursor: pointer; }
    .icon:hover { background: var(--control); color: var(--ink); }
    button:focus-visible, .pill:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .body { padding: 10px 12px; }
    .hero { display: flex; align-items: baseline; gap: 5px; }
    .big { font-size: 22px; line-height: 26px; font-weight: 600; letter-spacing: -0.02em; }
    .big.dim { color: var(--ink2); }
    .unit { color: var(--muted); }
    .state { margin-left: auto; color: var(--ink2); font-size: 11px; white-space: nowrap; }
    .cap { color: var(--muted); font-size: 11px; line-height: 16px; min-height: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .spark { display: block; width: 100%; height: 30px; margin-top: 6px; }
    .rule { height: 1px; background: var(--hair); margin: 10px 0; }
    .row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
    .label { color: var(--ink2); white-space: nowrap; }
    .value { text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .strong { font-weight: 600; }
    .block { margin-bottom: 8px; }
    .track { position: relative; height: 4px; border-radius: 2px; margin-top: 4px; }
    .fill { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 2px; transition: width .4s ease; }
    .mark { position: absolute; top: -2px; bottom: -2px; width: 2px; margin-left: -1px; border-radius: 1px; background: var(--ink2); opacity: .5; }
    .est { color: var(--muted); font-size: 11px; line-height: 15px; text-align: right; margin-top: 3px; }
    .track + .row { margin-top: 6px; }
    .grid { display: grid; grid-template-columns: auto 1fr auto 1fr; column-gap: 8px; row-gap: 1px; margin-top: 4px; }
    .k { color: var(--ink2); white-space: nowrap; }
    .k.second { padding-left: 8px; }
    .v { text-align: right; white-space: nowrap; }
    .models { color: var(--muted); font-size: 11px; line-height: 16px; margin-top: 6px; }
    .foot { display: flex; align-items: center; gap: 2px; padding: 3px 6px; border-top: 1px solid var(--hair); font-size: 11px; color: var(--muted); }
    .link { border: 0; background: transparent; color: inherit; font: inherit; padding: 2px 6px; border-radius: 5px; cursor: pointer; }
    .link:hover { background: var(--control); color: var(--ink); }
    .link.on { color: var(--accent); }
    .ver { margin-left: auto; padding-right: 6px; }
  `;

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function addRow(parent, label, tip) {
    const row = h('div', 'row');
    const value = h('span', 'value', '–');
    row.append(h('span', 'label', label), value);
    if (tip) row.title = tip;
    parent.append(row);
    return { row, value };
  }

  // 比例条：填充色表示程度（正常用强调色，偏高用警告色，接近上限用危险色），底槽是同一色调的浅色
  function meter(parent) {
    const track = h('div', 'track');
    const fill = h('div', 'fill');
    const mark = h('div', 'mark');
    mark.style.display = 'none';
    track.append(fill, mark);
    parent.append(track);
    return { track, fill, mark };
  }

  function setMeter(m, frac, level, markAt) {
    const color = level === 'normal' ? theme.accent : STATUS[level];
    m.fill.style.width = Math.max(0, Math.min(1, frac)) * 100 + '%';
    m.fill.style.background = color;
    m.track.style.background = tint(color, theme.trackAlpha);
    m.mark.style.display = markAt > 0 && markAt < 1 ? 'block' : 'none';
    m.mark.style.left = markAt * 100 + '%';
  }

  const levelOf = (frac, warn, crit) => (frac >= crit ? 'critical' : frac >= warn ? 'warning' : 'normal');
  const SEVERITY = { warning: 'warning', critical: 'critical', error: 'critical' };

  function limitViews() {
    const now = Date.now() / 1000;
    const order = Object.keys(LIMIT_NAMES);
    const rank = (name) => order.indexOf(name) + 1 || 50;
    const main = (name) => name === 'five_hour' || name === 'seven_day';
    return Object.keys(limits)
      .filter((name) => {
        const l = limits[name];
        if (!l) return false;
        // 没开始的窗口只显示主要的两个；其他窗口过期一天以上就不显示了
        if (!num(l.resetsAt)) return main(name) && !!l.at;
        return main(name) || now - l.resetsAt < 86400;
      })
      .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
      .map((name) => {
        const l = limits[name];
        const idle = !num(l.resetsAt);
        const expired = !idle && now >= l.resetsAt;
        const used = idle || expired ? 0 : num(l.utilization);
        const level =
          idle || expired
            ? 'normal'
            : SEVERITY[l.severity] ||
              (l.status === 'rejected' || used >= 0.9 ? 'critical' : l.status === 'allowed_warning' || used >= 0.75 ? 'warning' : 'normal');
        const [label, short] = limitNames(name);
        return { name, label, short, used, idle, expired, level, resetsAt: l.resetsAt, at: l.at, src: l.src };
      });
  }

  const limitShort = (l) => (l.expired ? '已重置' : fmtPct(l.used));

  const ui = { limitRows: {} };
  let mode = lsGet('ctm-mode') === 'full' ? 'full' : 'compact';
  let pos = { h: 'right', x: 16, v: 'bottom', y: 16 }; // 贴着哪个角、离两边多远
  try {
    const p = JSON.parse(lsGet('ctm-anchor') || 'null');
    if (p && /^(left|right)$/.test(p.h) && /^(top|bottom)$/.test(p.v)) pos = { h: p.h, x: num(p.x), v: p.v, y: num(p.y) };
  } catch {}

  function applyPos() {
    const s = ui.host.style;
    s.left = s.right = s.top = s.bottom = 'auto';
    s[pos.h] = pos.x + 'px';
    s[pos.v] = pos.y + 'px';
  }

  // 窗口变小或面板展开后超出视口时临时收回来，不改保存的位置
  function keepInView() {
    const r = ui.host.getBoundingClientRect();
    const s = ui.host.style;
    s[pos.h] = Math.max(0, Math.min(pos.x, innerWidth - r.width)) + 'px';
    s[pos.v] = Math.max(0, Math.min(pos.y, innerHeight - r.height)) + 'px';
  }

  // 拖动移动；没拖动就当作点击
  function draggable(handle, onClick) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const r = ui.host.getBoundingClientRect();
      const sx = e.clientX;
      const sy = e.clientY;
      let moved = false;
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => {
        if (!moved && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 4) return;
        moved = true;
        const left = Math.min(Math.max(0, r.left + ev.clientX - sx), innerWidth - r.width);
        const top = Math.min(Math.max(0, r.top + ev.clientY - sy), innerHeight - r.height);
        Object.assign(ui.host.style, { left: left + 'px', top: top + 'px', right: 'auto', bottom: 'auto' });
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        if (!moved) return onClick && onClick();
        // 按离得最近的角保存位置，展开、收起时朝远离这个角的方向伸缩
        const b = ui.host.getBoundingClientRect();
        const hh = b.left + b.width / 2 > innerWidth / 2 ? 'right' : 'left';
        const v = b.top + b.height / 2 > innerHeight / 2 ? 'bottom' : 'top';
        pos = {
          h: hh,
          x: Math.round(hh === 'right' ? innerWidth - b.right : b.left),
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
    ui.root.classList.toggle('compact', m === 'compact');
    pillKey = '';
    paint(true);
    applyPos();
    keepInView();
    if (m === 'full') pollUsage(true);
  }

  function copyDiagnostics() {
    const text = JSON.stringify(diagnostics(), null, 2);
    const done = (ok) => {
      ui.copyBtn.textContent = ok ? '已复制' : '复制失败，已打印到控制台';
      if (!ok) console.log(text);
      setTimeout(() => (ui.copyBtn.textContent = '复制诊断'), 1600);
    };
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text;
      Object.assign(ta.style, { position: 'fixed', opacity: '0', top: '0' });
      document.body.append(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {}
      ta.remove();
      done(ok);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => done(true), fallback);
    else fallback();
  }

  function buildUI() {
    const host = (ui.host = document.createElement('div'));
    host.style.cssText = 'all: initial; display: block; position: fixed; z-index: 2147483647;'; // 不受页面样式影响
    const shadow = host.attachShadow({ mode: 'open' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      shadow.adoptedStyleSheets = [sheet];
    } catch {
      shadow.append(h('style', null, CSS));
    }
    const root = (ui.root = h('div', 'root'));

    // 紧凑模式：一行摘要，点击展开
    const pill = (ui.pill = h('div', 'pill'));
    pill.tabIndex = 0;
    pill.setAttribute('role', 'button');
    pill.title = '模型 · 速度（空闲时为上轮均速）· 上下文 · 订阅额度 · API 等价费用\n点击展开，拖动可移动';
    ui.pillDot = h('span', 'dot');
    ui.pillText = h('span', 'pill-text');
    pill.append(ui.pillDot, ui.pillText);
    pill.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      setMode('full');
    });
    draggable(pill, () => setMode('full'));

    // 完整面板：标题栏是模型和推理强度
    const full = h('div', 'full');
    const head = h('div', 'head');
    ui.dot = h('span', 'dot');
    const title = h('div', 'title');
    ui.model = h('span', 'model', 'Token Meter');
    ui.chips = h('span', 'chips');
    title.append(ui.model, ui.chips);
    const iconBtn = (label, tip, onClick) => {
      const b = h('button', 'icon', label);
      b.type = 'button';
      b.title = tip;
      b.setAttribute('aria-label', tip);
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.addEventListener('click', onClick);
      return b;
    };
    head.append(ui.dot, title, iconBtn('↺', '清零本会话的统计（订阅额度不清）', reset), iconBtn('–', '收起成一行', () => setMode('compact')));
    draggable(head);

    const body = h('div', 'body');
    // 速度
    const hero = h('div', 'hero');
    ui.big = h('span', 'big', '–');
    ui.unit = h('span', 'unit', 'tok/s');
    ui.state = h('span', 'state');
    hero.append(ui.big, ui.unit, ui.state);
    ui.cap = h('div', 'cap');
    ui.canvas = h('canvas', 'spark');
    body.append(hero, ui.cap, ui.canvas, h('div', 'rule'));

    // 上下文与订阅额度
    const ctxBlock = h('div', 'block');
    ui.context = addRow(ctxBlock, '上下文');
    ui.ctxMeter = meter(ctxBlock);
    ui.cache = addRow(ctxBlock, '提示缓存');
    ui.cacheEst = h('div', 'est');
    ctxBlock.append(ui.cacheEst);
    ui.limitsBox = h('div');
    body.append(ctxBlock, ui.limitsBox);
    ui.extra = addRow(body, '额外用量', '超出订阅额度后按量付费的部分（本月）');
    ui.extra.row.classList.add('block');
    body.append(h('div', 'rule'));

    // 本会话累计
    ui.cost = addRow(body, 'API 等价费用');
    ui.cost.value.classList.add('strong');
    const grid = h('div', 'grid');
    const cell = (label, tip, second) => {
      const k = h('span', second ? 'k second' : 'k', label);
      const v = h('span', 'v', '–');
      k.title = v.title = tip;
      grid.append(k, v);
      return v;
    };
    ui.output = cell('输出', '含思考 token。≈ 表示本轮还没结束，未结束部分按正文估算（看不到思考，会偏低）');
    ui.thinking = cell('思考', '输出里看不见的思考 token（CLI 记录的精确值，只统计已结束的轮次）', true);
    ui.input = cell('输入', '未命中缓存的输入 token');
    ui.requests = cell('请求', '本页面看到的 API 请求次数，含子代理', true);
    ui.cacheRead = cell('缓存读', '从提示缓存读取的输入 token，单价约为输入的 1/10 到 1/20');
    ui.cacheWrite = cell('缓存写', '写入提示缓存的输入 token，单价高于普通输入', true);
    body.append(grid);
    ui.models = h('div', 'models');
    body.append(ui.models);

    // 底栏：调试和设置
    const foot = h('div', 'foot');
    const link = (label, tip, onClick) => {
      const b = h('button', 'link', label);
      b.type = 'button';
      b.title = tip;
      b.addEventListener('click', onClick);
      return b;
    };
    ui.copyBtn = link('复制诊断', '复制解析状态（不含对话内容），报告“数字不准”时附上', copyDiagnostics);
    ui.debugBtn = link('调试', '在控制台打印抓到的事件', () => {
      debug = !debug;
      lsSet('ctm-debug', debug ? '1' : '0');
      dirty = true;
    });
    ui.pollBtn = link('额度刷新', '', () => {
      if (!pollOn || pollFails < 3) pollOn = !pollOn; // 失败停下时点一下是重试
      pollFails = 0;
      lsSet('ctm-poll', pollOn ? '1' : '0');
      if (pollOn) pollUsage(true);
      dirty = true;
    });
    foot.append(ui.copyBtn, ui.debugBtn, ui.pollBtn, h('span', 'ver', 'v' + VERSION));

    full.append(head, body, foot);
    root.append(pill, full);
    shadow.append(root);
    document.body.append(host);
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
      const block = h('div', 'block');
      r = addRow(block, l.label, '');
      r.block = block;
      r.meter = meter(block);
      r.est = h('div', 'est');
      block.append(r.est);
      ui.limitsBox.append(block);
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

  // 速度曲线：只在最近有过输出时显示
  function drawSpark() {
    const c = ui.canvas;
    const data = state.spark;
    const show = data.some((v) => v > 0);
    c.style.display = show ? 'block' : 'none';
    if (!show) return;
    const dpr = W.devicePixelRatio || 1;
    const w = c.clientWidth;
    const hh = c.clientHeight;
    if (!w) return;
    if (c.width !== Math.round(w * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(hh * dpr);
    }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hh);
    const max = Math.max(10, ...data);
    g.strokeStyle = theme.hair;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, hh - 0.5);
    g.lineTo(w, hh - 0.5);
    g.stroke();
    if (data.length < 2) return;
    const step = w / (SPARK_POINTS - 1);
    const x0 = w - (data.length - 1) * step;
    g.beginPath();
    data.forEach((v, i) => {
      const x = x0 + i * step;
      const y = hh - 2 - (v / max) * (hh - 12);
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    });
    g.strokeStyle = theme.accent;
    g.lineWidth = 1.5;
    g.stroke();
    g.lineTo(w, hh);
    g.lineTo(x0, hh);
    g.closePath();
    g.fillStyle = tint(theme.accent, 0.14);
    g.fill();
    g.fillStyle = theme.muted;
    g.font = '10px system-ui, sans-serif';
    g.fillText(Math.round(max) + ' tok/s', 0, 9);
  }

  let live = { active: null, flowing: false, thinking: false, speed: 0 };
  let tick = 0;
  let paintedAt = 0;
  let pillKey = '';
  let chipKey = '';

  function render() {
    const now = performance.now();
    for (const [lane, s] of state.lanes) if (now - (s.last || s.t0) > STALE_MS) closeLane(lane);
    let active = null; // 最近有动静的实时请求
    for (const s of state.lanes.values()) {
      if (!s.bulk && (!active || (s.last || s.t0) > (active.last || active.t0))) active = s;
    }
    const flowing = !!active && !!active.last && now - active.last < FLOW_MS;
    live = { active, flowing, thinking: flowing && now - active.thinkAt < FLOW_MS, speed: flowing ? currentSpeed(now, active) : 0 };
    state.spark.push(live.speed);
    if (state.spark.length > SPARK_POINTS) state.spark.shift();
    if (live.speed > state.peak) state.peak = live.speed;
    if (!ui.root) return;
    if (!ui.host.isConnected && document.body) document.body.append(ui.host); // 页面重建 body 内容时放回去
    if (tick++ % 4 === 0) applyTheme(pageIsDark() ? 'dark' : 'light');
    paint(false);
    // 收起时也定期算一次并存下来，下次换会话时能直接用
    if (state.readings.length && Date.now() - quotaAt > 30000) quotaRates();
    if (tick % 20 === 0) pollUsage(false);
    if (tick % 10 === 0) saveHist();
  }

  function paint(force) {
    const now = performance.now();
    const { active, flowing } = live;
    const dotColor = flowing ? STATUS.good : active ? theme.accent : theme.muted;
    const dotTitle = flowing ? (live.thinking ? '正在思考' : '正在输出') : active ? '请求进行中：等待输出或在思考（思考内容不可见）' : '空闲';
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
    const v = { ...live, turn: lastTurn(), c: contextNow(), lims: limitViews(), t: sessionTotals(), mi: modelInfo(), cache: cacheState() };
    if (mode === 'compact') paintCompact(v);
    else paintFull(v);
  }

  function paintCompact(v) {
    const parts = []; // [文字, 程度, 附加文字]
    if (v.mi.id) parts.push([modelName(v.mi.id), 'model', v.mi.effort + (v.mi.fast ? ' fast' : '')]);
    if (v.flowing) parts.push([(v.thinking ? '思考 ' : '') + fmtSpeed(v.speed) + ' tok/s']);
    else if (v.active) parts.push(['思考中…']);
    else if (v.turn && v.turn.speed) parts.push([fmtSpeed(v.turn.speed) + ' tok/s']);
    if (v.c) parts.push([fmt(v.c.used) + (v.c.max ? '/' + fmt(v.c.max) : ''), v.c.max ? levelOf(v.c.used / v.c.max, 0.7, 0.9) : '']);
    for (const l of v.lims) {
      // 5 小时额度总是显示；其他窗口用到一半以上才显示
      if (l.name === 'five_hour' || l.used >= 0.5 || l.level !== 'normal') parts.push([l.short + ' ' + limitShort(l), l.level]);
    }
    // 缓存快过期时提醒：上下文大的时候，过期后的第一条消息要多花不少
    const left = v.cache && !v.active && v.cache.tokens >= 50000 ? v.cache.expiresAt - Date.now() : 0;
    if (left > 0 && left <= 600000) parts.push(['缓存 ' + fmtSpan(left), 'warning']);
    if (v.t.cost) parts.push([(v.t.approxCost ? '≈' : '') + fmtCost(v.t.cost, true)]);
    if (!parts.length) parts.push(['Token Meter']);
    const key = JSON.stringify(parts);
    if (key === pillKey) return;
    pillKey = key;
    ui.pillText.textContent = '';
    parts.forEach(([text, level, extra], i) => {
      if (i) ui.pillText.append(h('span', 'muted', '·'));
      const span = h('span');
      if (level === 'model') {
        span.append(h('b', null, text));
        if (extra.trim()) span.append(' ', h('span', 'muted', extra.trim()));
      } else {
        // 偏高时在旁边加个状态色小方块；数字本身一直显示，颜色不单独表达含义
        if (level && level !== 'normal') {
          const sq = h('span', 'sq');
          sq.style.background = STATUS[level];
          span.append(sq);
        }
        span.append(text);
      }
      ui.pillText.append(span);
    });
  }

  function modelTip(mi) {
    const lines = [];
    if (mi.id) lines.push('模型：' + mi.id + '（来自' + (INFO_SOURCES[mi.src] || mi.src) + '）');
    if (mi.served && mi.set && modelName(mi.served) !== modelName(mi.set)) {
      lines.push('设置的模型：' + mi.set + '；上一次请求由 ' + mi.served + ' 完成');
    }
    if (mi.effort) {
      lines.push('推理强度：' + mi.effort + (EFFORT_NAMES[mi.effort] ? '（' + EFFORT_NAMES[mi.effort] + '）' : '') + '，来自' + (INFO_SOURCES[mi.effortSrc] || mi.effortSrc));
    } else if (mi.effortNone) lines.push('推理强度：这个模型不使用推理强度参数');
    else lines.push('推理强度：未知（这个会话的数据里还没出现，在网页上切换一次就能看到）');
    if (mi.fast) lines.push('快速模式：开（按更高的单价计费）');
    if (mi.ultracode) lines.push('ultracode：开');
    return lines.join('\n');
  }

  function paintHeader(mi) {
    ui.model.textContent = modelName(mi.id) || 'Token Meter';
    ui.model.title = modelTip(mi);
    const chips = [];
    if (mi.effort) chips.push([mi.effort, '', '推理强度 ' + mi.effort + (EFFORT_NAMES[mi.effort] ? '（' + EFFORT_NAMES[mi.effort] + '）' : '')]);
    if (mi.fast) chips.push(['fast', 'alt', '快速模式：输出更快，单价更高']);
    if (mi.ultracode) chips.push(['ultracode', 'alt', 'ultracode：持续编排动态工作流']);
    const key = JSON.stringify(chips) + ui.model.title;
    if (key === chipKey) return;
    chipKey = key;
    ui.chips.textContent = '';
    for (const [text, cls, tip] of chips) {
      const c = h('span', 'chip' + (cls ? ' ' + cls : ''), text);
      c.title = tip + '\n' + ui.model.title;
      ui.chips.append(c);
    }
  }

  function paintHero(v) {
    const { active, flowing, thinking, speed, turn } = v;
    const lr = state.lastResp;
    let big = '–';
    let unit = 'tok/s';
    let st = '';
    let cap = '';
    let dim = false;
    if (flowing) {
      big = fmtSpeed(speed);
      st = thinking ? '思考中' : '输出中';
      const tokens = active.exact || active.est + active.think;
      const dur = (active.last - active.first) / 1000;
      cap = '本次请求 ' + (active.exact ? '' : '≈') + fmt(tokens) + ' tok · 平均 ' + fmtSpeed(dur > 0.3 ? (active.est + active.think) / dur : null) + '/s';
    } else if (active) {
      // 还没有输出：显示已经等了多久，像秒表
      const s = Math.floor((performance.now() - active.t0) / 1000);
      big = s < 60 ? String(s) : Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
      unit = s < 60 ? '秒' : '';
      st = '等待输出';
      cap = '请求进行中，多半在思考（思考内容不可见）';
    } else if (turn && turn.speed) {
      big = fmtSpeed(turn.speed);
      dim = true;
      st = '上轮均速';
      cap = '上轮输出 ' + fmt(turn.tokens) + ' tok · API 耗时 ' + fmtDur(turn.ms);
    } else if (lr && lr.speed) {
      big = fmtSpeed(lr.speed);
      dim = true;
      st = '上次请求';
      cap = '上次请求输出 ' + (lr.exact ? '' : '≈') + fmt(lr.tokens) + ' tok';
    } else {
      unit = '';
      cap = turn ? '上轮输出 ' + fmt(turn.tokens) + ' tok' : '等待数据：发一条消息或打开一个会话';
    }
    ui.big.textContent = big;
    ui.big.classList.toggle('dim', dim);
    ui.unit.textContent = unit;
    ui.state.textContent = st;
    ui.cap.textContent = cap;
    const tips = [];
    if (turn) {
      tips.push(
        `上一轮共输出 ${turn.tokens.toLocaleString()} tokens（含思考和子代理）` +
          (turn.ms ? `，API 耗时 ${(turn.ms / 1000).toFixed(1)} 秒。包含每次请求的首字延迟，所以会比实时速度低。` : '。')
      );
    }
    if (lr) tips.push(`上次请求：${(lr.exact ? '' : '≈') + lr.tokens.toLocaleString()} tokens · ${fmtSpeed(lr.speed)} tok/s`);
    if (state.peak) tips.push(`本页面看到的峰值速度：${fmtSpeed(state.peak)} tok/s`);
    ui.cap.title = ui.big.title = tips.join('\n');
  }

  // 文字前面按程度加个状态色小方块；文字本身一直显示，颜色不单独表达含义
  function setText(el, text, level) {
    el.textContent = '';
    if (level && level !== 'normal') {
      const sq = h('span', 'sq');
      sq.style.background = STATUS[level];
      el.append(sq);
    }
    el.append(text);
  }

  const fmtDollars = (v) => fmtUsd(v, v < 100);

  function paintCache(cs, active) {
    const show = !!cs && cs.tokens > 0;
    const wasted = show ? cs.rebuilds.filter((r) => !r.expected) : [];
    ui.cache.row.style.display = show ? '' : 'none';
    ui.cacheEst.style.display = wasted.length ? '' : 'none';
    if (!show) return;
    const left = cs.expiresAt - Date.now();
    const ttlName = cs.ttl === '5m' ? '5 分钟' : '1 小时';
    if (active) setText(ui.cache.value, '使用中');
    else if (left > 0) setText(ui.cache.value, '还剩 ' + fmtSpan(left), left <= 600000 ? 'warning' : 'normal');
    else setText(ui.cache.value, cs.nextExtra ? '已过期 · 下条约多花 ' + fmtDollars(cs.nextExtra) : '已过期', 'warning');
    ui.cache.row.title =
      `主对话的提示缓存是 ${ttlName}的（${cs.ttlKnown ? '来自请求的用量数据' : '推测，订阅用户的默认值'}），最后一次请求之后 ${ttlName}过期。\n` +
      `过期之后，或者切换了模型、推理强度、快速模式，下一条消息要把整个上下文（${fmt(cs.tokens)} token）按缓存写入价重写一遍` +
      (cs.nextExtra ? `，比命中缓存多花约 ${fmtDollars(cs.nextExtra)}${cs.listed ? '' : '（单价按本会话的花费推算）'}` : '') +
      '，也照样消耗订阅额度。';
    if (wasted.length) {
      const sum = wasted.reduce((s, r) => s + r.extra, 0);
      ui.cacheEst.textContent = '本会话缓存重建 ' + wasted.length + ' 次' + (sum ? ' · 约多花 ' + fmtDollars(sum) : '');
      ui.cacheEst.title =
        '/clear 和上下文压缩之后的重建是正常的，不算在内。最近几次：\n' +
        wasted
          .slice(-8)
          .reverse()
          .map((r) => fmtReset(r.t / 1000) + ' · ' + r.cause + ' · 重写 ' + fmt(r.tokens) + (r.extra ? ' · 约 ' + fmtDollars(r.extra) : ''))
          .join('\n');
    }
  }

  function paintLimits(lims) {
    const rates = lims.length ? quotaRates() : {};
    const shown = new Set();
    for (const l of lims) {
      shown.add(l.name);
      const r = limitRow(l);
      r.block.style.display = '';
      const q = rates[l.name];
      const fresh = l.at ? '\n读数时间：' + fmtAgo(l.at) + (l.src === 'official' ? '（claude.ai 用量接口）' : '（请求返回的额度信息）') : '';
      if (l.idle) {
        r.value.textContent = '0% · 未开始';
        r.row.title = '这个窗口里还没有用量，第一次请求时开始计时。' + fresh;
      } else if (l.expired) {
        r.value.textContent = '已重置 · 待更新';
        r.row.title = '已过重置时间，新窗口的用量要等下一次请求或额度刷新后才知道。' + fresh;
      } else {
        r.value.textContent = fmtPct(l.used) + ' · ' + fmtReset(l.resetsAt) + ' 重置';
        r.row.title = `还有 ${fmtLeft(l.resetsAt)}重置。数值是这里观察到的最大值。` + fresh;
      }
      // 下面一行是预测什么时候用完；折合美元的剩余量放在悬停提示里，预测不出来时才显示在这一行
      let dollars = '';
      let dollarsTip = '';
      if (q && !(l.used >= 1)) {
        const full = q.perPoint * 100; // 整个窗口折合的美元
        const left = Math.max(0, 1 - l.used) * full;
        const hours = rates.secPerDollar ? (left * rates.secPerDollar) / 3600 : null;
        dollars = '约剩 ' + fmtUsd(left) + (hours == null ? '' : ' · ' + fmtHours(hours));
        dollarsTip =
          `${dollars}：按 API 标价折算，整个 ${l.label}约 ${fmtUsd(full)}（每 1% ≈ ${fmtUsd(q.perPoint, true)}` +
          (q.ratio
            ? `：5 小时额度每 1% ≈ ${fmtUsd(rates.five_hour.perPoint, true)}，这项额度每涨 1%，5 小时额度大约涨 ${q.ratio.toFixed(1)}%，依据 ${q.points} 个百分点的变化）`
            : `，依据 ${q.points} 个百分点、${fmtUsd(q.dollars)} 的花费）`) +
          (rates.secPerDollar ? `；按你最近的用法，模型每运行 1 小时约花 ${fmtUsd(3600 / rates.secPerDollar)}` : '') +
          '。只是估算：假设统计期间账号没有别处的使用；换模型或用法差别很大时会不准。';
      }
      const fc = forecast(l);
      if (fc) {
        setText(r.est, fc.text, fc.level);
        r.est.title = fc.tip + (dollarsTip ? '\n\n' + dollarsTip : '');
      } else if (l.used >= 1) {
        setText(r.est, '已用完');
        r.est.title = '';
      } else if (dollars) {
        setText(r.est, dollars);
        r.est.title = dollarsTip;
      } else if (LIMIT_NAMES[l.name] && !l.idle) {
        setText(r.est, l.expired ? '' : '剩余：估算中');
        r.est.title = '再观察一阵用量的变化（5 小时额度约 10 分钟，周额度约 6 小时）后，就能预测什么时候用完';
      } else {
        setText(r.est, '');
        r.est.title = '';
      }
      r.est.style.display = r.est.textContent ? '' : 'none';
      setMeter(r.meter, l.used, l.level);
    }
    for (const name in ui.limitRows) if (!shown.has(name)) ui.limitRows[name].block.style.display = 'none';
    const ex = extraUsage;
    const showExtra = !!ex && ex.enabled && ex.limit > 0;
    ui.extra.row.style.display = showExtra ? '' : 'none';
    if (showExtra) {
      const unit = ex.currency === 'USD' ? '$' : ex.currency + ' ';
      ui.extra.value.textContent = unit + (ex.used / 100).toFixed(2) + ' / ' + unit + Math.round(ex.limit / 100);
    }
  }

  function paintFull(v) {
    const { c, lims, t, mi } = v;
    paintHeader(mi);
    paintHero(v);

    const frac = c && c.max ? c.used / c.max : 0;
    ui.context.value.textContent = c ? fmt(c.used) + (c.max ? ' / ' + fmt(c.max) + ' · ' + fmtPct(frac) : '') : '–';
    ui.context.row.title =
      '主对话最近一次请求的输入 token（含缓存）/ 模型上下文窗口' + (c && c.compactAt ? `\n竖线是自动压缩阈值（约 ${fmt(c.compactAt)}）` : '');
    setMeter(ui.ctxMeter, frac, levelOf(frac, 0.7, 0.9), c && c.compactAt && c.max ? c.compactAt / c.max : 0);
    paintCache(v.cache, v.active);
    paintLimits(lims);

    ui.cost.value.textContent = t.cost ? (t.approxCost ? '≈' : '') + fmtCost(t.cost) : '–';
    ui.cost.row.title =
      'Claude Code 按 API 标价估算的累计费用，订阅用户不按此计费。' +
      (t.runs > 1 ? `\n这个会话里累计值重新开始过 ${t.runs - 1} 次（/clear 或续接），已分段相加。` : '') +
      (t.approxCost ? '\n≈：本轮还没结束，未结束部分按最近的平均单价估算。' : '');
    ui.output.textContent = (t.approx ? '≈' : '') + fmt(t.output);
    ui.thinking.textContent = t.thinking ? fmt(t.thinking) : '–';
    ui.input.textContent = fmt(t.input);
    ui.requests.textContent = t.requests ? fmt(t.requests) : '–';
    ui.cacheRead.textContent = fmt(t.cacheRead);
    ui.cacheWrite.textContent = fmt(t.cacheWrite);
    const models = Object.entries(t.models).sort((a, b) => b[1].cost - a[1].cost);
    ui.models.textContent = models.length > 1 ? models.map(([name, x]) => name + ' ' + fmtCost(x.cost, true)).join(' · ') : '';
    ui.models.title = models.length > 1 ? '各模型的累计费用（子代理、压缩等也会用到其他模型）' : '';
    ui.models.style.display = ui.models.textContent ? '' : 'none';

    ui.debugBtn.classList.toggle('on', debug);
    ui.debugBtn.textContent = debug ? '调试：开' : '调试';
    ui.pollBtn.classList.toggle('on', pollOn && pollFails < 3);
    ui.pollBtn.textContent = '额度刷新：' + (!pollOn ? '关' : pollFails >= 3 ? '失败' : '开');
    ui.pollBtn.title =
      '每 3 分钟从 claude.ai 的用量接口（设置 → 用量页面用的同一个只读接口）刷新一次订阅额度，点击开关。' +
      (officialAt ? '\n上次成功：' + fmtAgo(officialAt) : '') +
      (pollErr ? '\n上次失败：' + pollErr : '');
  }

  function boot() {
    if (!document.body) return void requestAnimationFrame(boot);
    buildUI();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  setInterval(safe(render), 500);

  W.__ctm = {
    version: VERSION,
    get state() {
      return state;
    },
    get limits() {
      return limits;
    },
    totals: sessionTotals,
    runs,
    context: contextNow,
    cache: cacheState,
    forecast: () => Object.fromEntries(limitViews().map((l) => [l.name, forecast(l)])),
    model: modelInfo,
    lastTurn,
    quota: () => ({ session: sessionQuotaRates(), combined: quotaRates() }),
    diagnostics,
    pollUsage: () => pollUsage(true),
    mode: (m) => setMode(m === 'full' ? 'full' : 'compact'),
    reset,
    debug(on = true) {
      debug = !!on;
      lsSet('ctm-debug', debug ? '1' : '0');
    },
    ingest: ingestText, // 手动喂数据测试：__ctm.ingest('{"type":"assistant",...}')
  };
})();
