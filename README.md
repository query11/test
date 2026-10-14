# Claude Token Meter

一个油猴（Tampermonkey / Violentmonkey）用户脚本，在 claude.ai（包括 Claude Code 网页端 `claude.ai/code`）右下角浮动显示：

| 行 | 含义 |
| --- | --- |
| 实时速度 | 最近 2 秒可见输出的 tok/s，下方是速度曲线 |
| 当前请求 / 上次请求 | 每次 API 请求的输出 token 数和平均速度；有精确数时包含看不见的思考 |
| 上轮均速 | 上一轮（你发一条消息到 Claude 答完）的输出 token 数 ÷ API 耗时，含首字延迟，所以比实时速度低 |
| 上下文 | 主对话最近一次请求的输入 token（含缓存）/ 模型上下文窗口，带进度条 |
| 输入 / 输出 / 缓存读取 / 缓存写入 / 合计 | 当前会话累计，输出含思考 token |
| API 等价费用 | Claude Code 按 API 标价估算的累计费用，订阅用户不按此计费 |

数字前的 `≈` 表示本轮还没结束，未结束部分是估算值；本轮结束后会换成精确值。鼠标悬停在各行上有说明。

## 安装

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/) 或 Violentmonkey。
2. 新建脚本，把 `claude-token-meter.user.js` 的内容整个粘进去保存。
3. 刷新 claude.ai 页面。

面板可以拖动标题栏移动，`–` 折叠（折叠时标题栏显示实时速度），`↺` 清零，`dbg` 开启调试日志。
标题栏的圆点：绿色 = 正在输出，黄色 = 请求进行中但暂时没有可见输出（多半在思考），灰色 = 空闲。

## 原理

脚本在页面加载最早阶段挂钩 `fetch`、`XMLHttpRequest`、`WebSocket`、`EventSource`，只旁听数据、不修改请求。
从流过的 Claude Code stream-json 事件里读取：

| 事件 | 用途 |
| --- | --- |
| `type: "result"` 的 `modelUsage`、`total_cost_usd` | 会话累计用量和费用。CLI 文档说明这是截至目前的累计值，取最新一条 |
| `type: "assistant"` 的 `message.usage` | 本轮还没结束时的输入/缓存用量，按 `message.id` 去重 |
| `stream_event` 里的 `content_block_delta` | 实时速度（按字符估算） |
| `stream_event` 里的 `message_delta` | 每次请求的精确输出数，也用来校准估算 |
| `result` 的 `usage.output_tokens`、`duration_api_ms` | 上轮均速（`duration_api_ms` 是累计值，取相邻两轮之差） |
| `get_context_usage` 的响应 | 上下文占用（网页端查询上下文时才有） |

几点要注意：

- `assistant` 事件里的 `output_tokens` 只是请求刚开始时的占位值（个位数），不能当输出量用，所以输出量以 `result` 为准。
- 逐字的 `stream_event` 只在回复生成时实时推送，不会保存进历史。打开一个已经答完的会话时，实时速度一栏是空的，但“上轮均速”和用量都能从历史里算出来。
- 网页端看不到思考内容，思考期间实时速度显示为 0、圆点变黄；思考 token 会出现在精确的输出数里。
- 历史记录（一次加载多条）只计入用量，不计入速度。切换会话时自动清零。

## 如果数字不动

claude.ai 前端的内部接口没有公开文档，格式可能会变。排查方法：

1. 点 `dbg`，打开 DevTools 控制台，发一条消息，看有没有 `[token-meter]` 日志：
   - 有 `fetch` / `websocket` 行但没有事件类型行 → 数据格式不同（或是二进制），把一段原始数据贴出来即可适配；
   - 一行都没有 → 数据走了脚本没挂钩的通道。
2. 控制台里 `__ctm.state` 查看内部状态，`__ctm.totals()` / `__ctm.context()` 查看计算结果，`__ctm.ingest('<json 文本>')` 手动喂数据测试。
