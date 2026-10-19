# Linux DO 楼中楼阅读 · 自动测试

用模拟的 Discourse 页面在真浏览器（Chromium）里跑脚本，检查闪烁、跳动、连线和各项功能。改完脚本先跑一遍，全部 PASS 再装到油猴里。

## 运行

需要 Node.js 18 以上。

```bash
cd tests/linuxdo-threaded-reading
npm install
npx playwright install chromium
npm test
```

默认测仓库根目录的 `linuxdo-threaded-reading.user.js`。要测别的版本，把路径传进去：

```bash
node run-all.js /path/to/other.user.js
```

也可以只跑其中一个文件，例如 `node flicker.test.js`。每项检查输出一行 `PASS` 或 `FAIL`，有失败时退出码不为 0。整套大约 5 分钟。

## 测了什么

| 文件 | 内容 |
| --- | --- |
| `flicker.test.js` | 电脑、手机两种宽度，楼中楼和引用两种模式，上下滚动、加载后面和前面的楼层。每一帧画面都检查：展开的回复有没有缺"回复 xxx"、楼主标签、连线或引用块，阅读位置有没有跳。 |
| `connectors.test.js` | 一打开时所有父子楼层都有连线；滚动中每条线的两端都对准头像，包括吸顶的头像。 |
| `features.test.js` | 模式切换、菜单开关、离开再回到帖子、时间线重建；新回复记录的清理；跳到没加载的楼层走站内跳转；引用不下载图片；j/k 按画面顺序移动；帖子列表的"未看 N"；补拉失败后重试。 |

## 模拟页面

- `mock/topic.html` 和 `mock/mock.js` 模拟帖子页。楼层的 DOM 结构照 Discourse 的 Post 组件。折叠远处楼层的规则抄自 `post-stream-viewport-tracker.js`：离屏幕一屏以外、楼号不在展开范围内的楼层被折叠，在 requestAnimationFrame 里重新渲染。j/k 的选楼逻辑照搬 `services/keyboard-shortcuts.js` 的 `_moveSelection`。
- `mock/list.html` 模拟帖子列表，行结构照 `topic-list/item.gjs`。
- `server.js` 提供页面，模拟 `/t/<id>/<楼号>.json`（可以注入失败），并统计请求次数和图片下载。

模拟页面只覆盖脚本用到的部分，不能代替在 linux.do 上实际看一眼。Discourse 改版以后，如果真站上出了问题而这里测不出来，先对照上面几个源码文件，把模拟页面更新到新结构。
