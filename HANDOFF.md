# 交接文档

写于 2026-10-20，同一天做完 1.6.0 后更新。接手时先读这份，做完一项就更新这里（全部做完可以删掉）。

## 现状

- 仓库只有一个油猴脚本 `claude-token-meter.user.js`（单文件，约 3080 行）、`README.md`、截图 `shot.png`，以及 `tests/`。
- 默认分支是 `claude/clever-mendel-97x9jy`。README 里的安装链接和 Tampermonkey 的自动更新都指向默认分支（`@updateURL` 用的是 `HEAD`），合并进去用户才会收到新版本。
- 1.5.1（分支 `claude/brave-mayer-qf593f`）和 1.6.0（分支 `claude/gallant-shannon-8k18g1`，基于 1.5.1）已经在 2026-10-20 快进合并进默认分支，安装链接和自动更新拿到的就是 1.6.0。之后的工作从默认分支开始。

### 1.5.1 做了什么

1. **长时间没有增量时，这次请求后面的输出会丢**：超时只影响显示（还没有输出时最多等 10 分钟 `WAIT_MS`，输出过之后 60 秒 `STALE_MS`），这一路的统计一直保留，真正结束以 `message_stop`、同一路的下一个 `message_start` 或 `result` 为准。全零的 `result` 也会结束进行中的请求；到 `result` 才关掉时，速度按最后一次增量的时间算。
2. **额度预测在闲置之后偏乐观**：回看起点落在读数没变化的一段中间时，取“截止时刻 + 这段的值”。
3. **用量接口的新格式被预筛挡掉**：只有 `limits[]` 行的响应现在能过 `WORTH_PARSING`。
4. 新增 `__ctm.live` 和 `tests/` 测试台。

### 1.6.0 做了什么：按天 / 周 / 月汇总

用户的原话：“当天或者这一周，这一个月用了多少 token，分别是什么模型，等价多少钱”。

开工前和用户确认过的点（都按建议的默认值）：

- 本周是自然周，周一开始；
- 一行摘要里**不**显示“今日 $x”；
- “当前 7 天额度窗口内”这一栏**先不做**（见待办 4）；
- 两个可选项都做了：导出 CSV，`diagnostics()` 里加账本统计。

实现（`claude-token-meter.user.js` 的“用量账本”一节，README 的“用量汇总”一节有面向用户的说明）：

- **记账**：`render()` 发现 `state.rev` 变了就调 `updateLedger()`。每一轮 = `runs()` 同一段里相邻两条 `result` 的累计值之差，记到 `ts || at` 那天（本地时区，`dayKey()`）。轮数只记在这一轮花费最多的模型上，各模型的轮数相加才是总轮数。
- **去重**：每个会话一条水位线 `{ id, t, c }`（最后记过账的 `result` 的 uuid、时间、各模型累计值），键是 `state.path`（`freshState()` 时的 `location.pathname`，等锁期间切换了会话也记在原来的会话名下）。先按 uuid 找水位线那条，只记它后面的；找不到时按“时间比它晚、累计值又不一样”判断。看不到同一段里的上一条时，累计值各项都不小于水位线的减去水位线，否则从零算。
- **多标签页**：在 `navigator.locks.request('ctm-ledger', …)` 里每次从 localStorage 重新读、改、写；没有 Web Locks 时不加锁直接做（Node 里的测试走这条）。其他标签页靠 `storage` 事件刷新显示。
- **保留**：按天的记录留本月和之前 12 个月；水位线留 60 天（`LEDGER_KEEP_MS`），没有水位线的会话，60 天以前的 `result` 不记。
- **展示**：底栏第一个按钮“汇总”切到汇总视图（再点“返回”）。顶部“今天 / 本周 / 本月”，主数字是等价费用，下面日期范围、轮数、日均；近 30 天每天费用的柱状图（本栏的几天用强调色，整列都是悬停范围，键盘聚焦后可以用左右方向键）；输出 / 输入 / 缓存读 / 缓存写；按 `modelName()` 合并后每个模型一行；底部是“只统计在这个浏览器打开过的会话”（悬停有完整说明）和“导出 CSV”。
- **控制台**：`__ctm.usage('day' | 'week' | 'month')`、`__ctm.ledger`、`__ctm.usageCsv()`；`diagnostics().ledger` 只有天数、会话数、最后更新时间、字节数，不含会话路径。
- 顺带的小改动：`recordResult` 存了 `id`（result 的 uuid）；`runs(s)` / `restarted(p, r, resets)` 可以传入别的状态；`paintHeader` 和底栏（新的 `paintFoot()`）从 `paintFull` 里拿出来，两个视图共用。

账本格式（`ctm-ledger`）：

```json
{
  "v": 1,
  "at": 1792461600000,
  "days": { "2026-10-20": { "claude-opus-5-5": [输入, 输出, 缓存读, 缓存写, 美元, 轮数] } },
  "sessions": { "/code/session_…": { "id": "<result uuid>", "t": 1792461600000, "c": { "claude-opus-5-5": [输入, 输出, 缓存读, 缓存写, 美元] } } }
}
```

没有 `modelUsage`、只有 `total_cost_usd` 的 result 记在空字符串模型名下，显示为“未知模型”，CSV 里写 `unknown`。

### 测试

在仓库根目录运行 `node --test`（Node 20 以上，不用装依赖），目前 36 个用例全部通过。

- `tests/harness.js`：在 Node 里加载脚本，桩掉浏览器对象，时间由测试控制（`advance` / `wait`），不建 UI。1.6.0 起：`opts.storage` 传 `Map` 时直接共用（模拟同一浏览器的几个标签页），传对象时拷贝一份；`opts.locks` 可以给一个 `navigator.locks` 的替身；脚本里不带参数的 `new Date()` 也跟着测试的时钟走。
- `streaming.test.js`、`forecast.test.js`、`totals.test.js`、`quota.test.js`：实时流、额度预测、累计值、额度合并与每 1% 折合美元。
- `ledger.test.js`（14 个）：实时只记一次、刷新后不重复；uuid 对不上时按时间和累计值判断；本机时钟比服务端快时靠 uuid；`/clear` 两段和子代理；只加载后半段历史；只看到 `/clear` 之后的新一段；同一会话两个标签页交替；两个标签页不同会话不互相覆盖；加锁路径；跨午夜；60 天保留期；账本清理；今天 / 本周 / 本月的范围和模型合并；CSV 和诊断。
- `CTM_SCRIPT=<文件> node --test` 可以拿别的版本跑同一组用例。账本的每个保护都单独去掉验证过，去掉之后对应用例会失败：减去水位线、每次重新读 localStorage、60 天规则、uuid 对不上时的累计值比较、按 uuid 找水位线、轮数只记一次。
- 事件是照着脚本解析的格式手工构造的，**不是录下来的真实数据**。
- 界面没有自动化测试。1.6.0 是用 Playwright 手动看的：`page.route('https://claude.ai/**', …)` 返回一个空页面，`page.addInitScript` 先往 localStorage 里放一份假账本再注入脚本，`__ctm.ingest` 喂几条 result，点“汇总”后截图（浅色、深色、悬停、空账本、底栏打开调试时的宽度）。容器里有 Chromium（`/opt/pw-browsers`）和全局的 `playwright` 包（`NODE_PATH=$(npm root -g)`）。

## 代码地图（行号以 1.6.0 为准）

| 位置（`claude-token-meter.user.js`） | 内容 |
| --- | --- |
| `:74` state | `freshState()`：每个会话的内存状态（`path` 是它属于哪个会话）；切换会话时 `reset()` 清零 |
| `:110` 先后顺序 | `stamp` / `isAfter` / `compare`：实时事件按到达顺序，历史记录按时间戳 |
| `:202` `recordResult` | `result` 事件 → `state.results`（uuid、各模型累计值、`total_cost_usd`、`duration_api_ms`） |
| `:266` 实时流 | 每一路（主对话 `main`、子代理按 `parent_tool_use_id`）的速度统计，`closeLane` |
| `:420` 订阅额度 | `mergeLimit`（同一窗口取最大值）、`notePoint`（读数历史）、`forecast`（预测用完时间）、`recordOfficial`（用量接口） |
| `:677` 事件识别 | `handle()` 按事件类型分发；`walk()` 遍历 JSON，跳过对话内容（`CONTENT_TYPES`） |
| `:1023` 统计 | `runs()` 按 `/clear` 分段，`sessionTotals()`、`lastTurn()`、`contextNow()` |
| `:1144` 提示缓存 | 价目表 `CACHE_PRICES`、`cacheState()`（过期时间、重建次数和原因） |
| `:1253` 额度折合多少钱 | `sessionQuotaRates()`：每轮花费按 result 差值分摊到请求，再和额度跳变对齐；`quotaRates()` 按会话存进 `ctm-rates-v4` 再合并 |
| `:1509` 用量账本 | `updateLedger()`（水位线、加锁）、`addTurn`、`pruneLedger`、`usageSummary()`、`ledgerCsv()`、`ledgerStats()` |
| `:1694` 网络挂钩 | fetch / XHR / WebSocket / EventSource，切换会话时 `reset()` |
| `:1847` 主动刷新额度 | `pollUsage()`：每 3 分钟查一次用量接口，多标签页共用 |
| `:1943` UI | shadow DOM 面板；`buildSummary()`（`:2483`）、`drawBars()` / `paintSummary()`（`:2686`）；`render()`（`:2719`）每 500ms 一次，`paint()` → `paintCompact` / `paintFull` / `paintSummary`，再 `paintFoot` |
| `:3047` `W.__ctm` | 控制台接口，测试也通过它 |

localStorage 里已经用到的键：`ctm-limits`、`ctm-extra`、`ctm-usage-hist`、`ctm-rates-v4`、`ctm-ledger`、`ctm-poll`、`ctm-poll-at`、`ctm-mode`、`ctm-anchor`、`ctm-debug`。汇总视图选的是哪一栏、是否在汇总视图，只存在内存里。

## 待办

### 1. 额度窗口重置后马上刷新（小）

- 现状：窗口过了重置时间之后，要等下一次轮询（`POLL_MS` 3 分钟，多标签页共用 `ctm-poll-at`）才有新数，这期间一直显示“已重置 · 待更新”（`paintLimits`）。
- 做法：在 `render()` 里检查，某个窗口已经过了 `resetsAt`、而最近一次读数在重置之前，就在重置后几秒调用 `pollUsage(true)`（这条路径每分钟最多一次）。连续失败 3 次就停下的逻辑保持不变。
- 测试：harness 现在没有 `fetch`（`origFetch` 为空，`pollUsage` 直接返回）。要支持 `opts.fetch`，在加载脚本之前挂到 `window` 上；`pollUsage` 是 async 的，断言前要等一下微任务。

### 2. 性能（不急）

实测一个 2000 轮（8000 次请求、7.4 MB 历史）的合成会话（1.5.1 时测的，账本是之后加的）：

- 一次性加载约 150–200 ms；
- 输出时每次重绘（500 ms 一次）约 2–5 ms，主要花在 `cacheState()` 每次都把主对话的请求重新排序；另外一次重绘里 `contextNow()` 要算 2 遍，`modelInfo()` 要算 4 遍；
- `sessionQuotaRates()` 约 20 ms，展开面板时每 3 秒一次，收起时每 30 秒一次。
- 账本只在 `state.rev` 变化时算一次（每轮一次，加载历史时一次），要解析、序列化整个 `ctm-ledger`（一年几十 KB），没有实测，估计不显眼。汇总视图每次重绘都调一次 `usageSummary()`（遍历最多约 400 天），再按结果比对决定要不要改 DOM。

正常会话只有这个的零头。要优化的话：按状态版本号缓存（参照 `runs()` 用 `state.rev` 的做法）；一次 `paint` 里把 `modelInfo()` / `contextNow()` 只算一遍、往下传；`document.hidden` 时跳过重绘。

### 3. 用量汇总的后续（可选，没有用户要求）

- **真实数据核对**：账本只用合成事件测过。值得在真实页面上确认：历史里的 `result` 和实时到达的是不是同一个 uuid（不是的话靠时间和累计值兜底，也能去重）；分页加载历史时有没有重复记；`/code` 新建会话时，第一轮的 `result` 会不会在 URL 变成 `/code/session_…` 之前到达（那样会在 `/code` 和新会话下各记一次；推测 URL 先变，没有核实）。
- 汇总的主数字超过 $1000 时没有千分位（`fmtCost`）。
- 底栏打开“调试”时最宽，版本号会被截成 `v1.6`。

### 4. “当前 7 天额度窗口内”的花费（用户说先不做）

和“每 1% 折合多少美元”互相印证用。账本按天记，粒度不够对齐额度窗口，要做的话另外按小时记最近 8 天。

### 5. 其他（可选）

- **CI**：加 `.github/workflows/test.yml`，在 push / PR 时跑 `node --test`。
- **真实数据的用例**：打开“调试”录一段真实的事件流，去掉对话内容后存成 fixture，作为合成用例的补充。注意隐私，只留结构和数字。
- **读过代码但没有验证的疑点**（优先级低，动手前先用测试台复现）：
  - `compare()` 在历史里有的 `result` 带时间戳、有的不带时不满足传递性，`sort` 的结果可能不稳定。账本按 uuid 在排好的顺序里找水位线，顺序不稳定时也可能受影响。
  - `quotaRates()` 每次都用当前算出的结果覆盖这个会话存的估算。如果这次历史只加载了一部分、样本更少，会把更准的旧估算换掉。可以考虑保留依据格数更多的那份。
  - `sessionQuotaRates()` 把每个额度读数和“这次请求之前”的累计花费配对，前提是 `rate_limit_event` 在这次请求的消息记录建立之后才到。真实事件的先后顺序没有核实过。
  - `ingestText` 会解析所有命中 `WORTH_PARSING` 的 JSON 响应，包括普通 claude.ai 聊天加载对话。如果哪天在性能分析里显眼，可以按 URL 跳过。

## 约定

- 注释和 README 用中文，风格照现有代码：注释写为什么，不写做了什么。
- 版本号两处一起改：头部的 `@version` 和常量 `VERSION`。修 bug 升第三位，加功能升第二位。
- 提交信息照现有格式：英文祈使句标题，后面括号里写版本号，正文写改了什么、为什么。
- 脚本的原则：只旁听，不改请求；自己只发低频的用量查询，而且可以关掉。不要加“扫描全部会话”之类主动拉数据的功能，除非用户明确要求，并且默认关闭。用量汇总也遵守这条：只记页面本来就加载了的数据。
- 诊断信息不含对话内容，也不含会话路径。
- 推送前跑 `node --test`。新逻辑配用例，并用 `CTM_SCRIPT` 确认用例在旧版本上会失败。

## 新窗口的开场提示（可以直接粘贴）

> 读一下仓库根目录的 HANDOFF.md，基于默认分支继续。实现待办第 1 项“额度窗口重置后马上刷新”：按里面的做法和测试做，做完更新 README 和 HANDOFF.md。
