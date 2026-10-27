# Claude Desktop 管理器（Windows）

一个 Windows 小工具：一键启动、关闭 Claude Desktop（连同它留下的所有进程），按“方案”设置 Claude 走的代理和看到的时区，另外还能管理 MCP 服务器、看日志、清缓存、修复卡住的更新。

- 单个 exe，不用安装：Windows 10（1903 以后）和 Windows 11 自带它需要的 .NET Framework 4.8。
- 非官方工具，与 Anthropic 无关。只调用 Windows 和 Claude Desktop 本身提供的功能，不修改 Claude 的程序文件。


## 下载和运行

1. 打开 [Actions 里的 desktop-manager 工作流](https://github.com/query11/test/actions/workflows/desktop-manager.yml)，点最新一次绿色的运行，在页面底部的 Artifacts 里下载 **ClaudeDesktopManager**（一个 zip，里面就是 `ClaudeDesktopManager.exe`）。需要登录 GitHub。
2. 把 exe 放到任意文件夹，双击运行。exe 没有代码签名，第一次运行时 Windows 可能提示“Windows 已保护你的电脑”，点“更多信息 → 仍要运行”。

也可以自己编译：装好 [.NET SDK 8](https://dotnet.microsoft.com/download)，在仓库根目录运行

```
dotnet build -c Release desktop-manager/src
```

生成的程序在 `desktop-manager/src/bin/Release/net48/ClaudeDesktopManager.exe`。

## 功能

窗口最上面是状态（是否在运行、进程数、内存、运行了多久）、当前方案和四个按钮：**启动**、**重启**、**关闭 Claude**、**强制结束全部进程**。下面按页分：

| 页 | 做什么 |
| --- | --- |
| 进程 | Claude 的所有进程：类型（主进程、渲染、GPU、Claude Code 引擎、MCP 子进程……）、内存、启动时间、命令行；可以单独结束；Cowork 虚拟机服务的启停 |
| 网络代理 | 当前方案的代理设置、连通性测试、出口 IP、检测本机代理端口、现在实际生效的代理 |
| 时区 | 当前方案让 Claude 看到哪个时区，系统时区的状态，恢复按钮 |
| 启动选项 | 界面语言、禁用 GPU、额外启动参数和环境变量，以及“启动时会做什么”的预览 |
| MCP 服务器 | `claude_desktop_config.json` 里的服务器列表，停用 / 启用 |
| 维护 | 打开数据和日志目录、查看日志、磁盘占用、清理缓存、重新注册 MSIX 包、复制诊断信息、创建桌面快捷方式 |
| 设置 | 关闭 Claude 时的行为、托盘、开机启动、手动指定 Claude.exe |

窗口底部是操作记录，每一步做了什么、成功没有都写在这里。

### 一键关闭：哪些进程会被结束

Claude Desktop 在 Windows 上会开十几个进程，关掉窗口后常常还留着一些（渲染进程、Claude Code 引擎、MCP 服务器、git 之类）。“关闭 Claude”先让 Claude 正常退出（最多等 3 秒，可以改），然后把剩下的都结束；“强制结束全部进程”不等，直接结束。

- **按安装位置认 Claude 的进程**：MSIX 包（`C:\Program Files\WindowsApps\Claude_…__pzs8sxrjxfjjc\`）、旧版安装（`%LOCALAPPDATA%\AnthropicClaude\`）、数据目录里的 Claude Code 引擎。终端里自己运行的 Claude Code（`claude.exe`，同名但在别处）不会被碰。
- **Claude 启动的命令行程序一起结束**：MCP 服务器（node、uvx、python……）、它跑的终端命令、git 等。即使 Claude 主进程已经没了、它们成了“孤儿”，也认得出来。
- **Claude 打开的窗口程序保留**：比如它帮你打开的 VS Code、记事本，按程序类型（命令行 / 窗口）区分。
- **防误杀**：进程号被系统复用的、其他用户会话里的 Claude、系统进程都不会碰。
- **被结束后又自己冒出来的**（Claude 会重新拉起一些进程）：结束之后还会再扫几轮，新出现的也一并结束。
- 默认还会停止 **Cowork 虚拟机服务**（CoworkVMService，它的虚拟机要占几百 MB 内存）。下次用管理器启动 Claude 时会先把它打开，直接从开始菜单启动时 Claude 也会自己把它拉起来。不想停可以在“设置”里关掉。

### 方案

一个方案 = 一组启动设置：代理、时区、界面语言、是否禁用 GPU、额外参数和环境变量。在顶部选方案，点“启动”或“重启”就按这个方案来。“方案管理”里可以新建、复制、重命名、删除，还能在桌面创建“用这个方案启动”的快捷方式。

代理、时区这些都只在 Claude **启动时**生效，所以 Claude 已经在运行时换方案需要重启（默认会问一下，“设置”里可以改成自动重启）。

### 网络代理

四种方式：跟随系统代理（默认）、不使用代理、指定代理服务器（http / https / socks5 / socks4）、PAC 脚本。

指定的代理有三种方式交给 Claude，可以同时勾：

| 方式 | 作用到哪 | 说明 |
| --- | --- | --- |
| 启动参数 `--proxy-server` | Claude 窗口本身的网络请求 | 默认勾上，不需要管理员权限。启动后管理器会读 Claude 主进程的命令行，确认参数确实带上了 |
| 官方托管策略 `egressProxyUrl` | Claude 窗口、Claude Code 引擎、Cowork 虚拟机 | Anthropic 文档里的配置项，写在 `HKCU\SOFTWARE\Policies\Claude`，写入时 Windows 会弹管理员确认。只支持 HTTP 代理，需要 Claude Desktop 1.44121.1 以上。切到不用策略的方案时，管理器会删掉自己写的值；别人（比如公司 IT）写的不会动 |
| 环境变量 `HTTP_PROXY` / `HTTPS_PROXY` | MCP 服务器等子进程 | 只对旧版安装和自定义路径有效（见下面“已知限制”） |

其他：

- **测试连接**：按当前方案（或直连）连接 claude.ai 和 api.anthropic.com，显示每一步的耗时，以及出口 IP（通过 api.ipify.org）。收到任何 HTTP 状态码都说明网络是通的。
- **检测本机代理端口**：扫一遍常见端口（Clash 7890 / 7897、v2rayN 10808 / 10809、1080 等），看哪个是 HTTP 代理、哪个是 SOCKS5、哪个是混合端口，点一下就填进去。
- **现在的情况**：系统代理设置、注册表里的 egressProxy 策略，以及 Claude 自己的 `main.log` 里记录的它实际用的代理。
- Claude Desktop 不支持需要用户名密码的代理。代理软件开着 TUN / 虚拟网卡模式时，所有程序本来就走代理，选“跟随系统”即可。
- SOCKS 代理只对 Claude 窗口生效；Claude Code 引擎只接受 HTTP 代理，所以代理软件有 HTTP 或混合端口时优先用它。

### 时区

Windows 上，程序读到的时区就是系统时区，没有办法只给一个程序换（`TZ` 环境变量对 Claude 的界面无效）。所以方案里设了时区时，管理器这样做：

1. 启动 Claude 前，先把原来的系统时区记到设置文件里，再把系统时区切过去（任务栏时钟也会变）；
2. Claude 退出后（管理器在托盘里运行着就行），自动换回原来的时区；
3. 如果中途管理器被关掉、电脑重启，下次打开管理器时、Claude 没在运行就会恢复；也可以随时点“恢复”，或者运行 `ClaudeDesktopManager.exe restore-tz`；
4. 期间你自己改过系统时区的话，以你改的为准，不会被“恢复”覆盖。

Windows 的“自动设置时区”开着时可能会把时区改回去，管理器会提醒，并提供打开“日期和时间”设置的按钮。

### MCP 服务器

列出 `claude_desktop_config.json` 里的服务器（命令、参数、URL、用到的环境变量）。“停用”会把服务器从配置文件里移出来，存进管理器的设置；“启用”时原样放回去。每次修改前都会在同目录备份一份（`.bak-日期`，保留最近 10 份）。改完要重启 Claude 才生效。

MSIX 版 Claude 实际读的配置文件在 `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\` 下，而 Claude 菜单里的“编辑配置”有时打开的是 `%APPDATA%\Claude\` 下的另一份，改了不生效。管理器显示的是 Claude 实际读取的那份，两份都在时会提醒。

### 维护

- **查看日志**：`main.log`、`mcp*.log` 等最后几百行，可以只看代理相关的行。
- **清理缓存**：只删 `Cache`、`Code Cache`、`GPUCache` 这类能重新生成的缓存，不会退出登录，也不碰对话、设置和 Cowork 的虚拟机文件。需要先关闭 Claude。
- **重新注册 MSIX 包**：Claude 一直提示“Relaunch to update”却更新不上，或者开始菜单里点了打不开时用。它会关闭 Claude 和 Cowork 服务，然后执行 `Add-AppxPackage -RegisterByFamilyName -MainPackage Claude_pzs8sxrjxfjjc`，让 Windows 装上已经下载好的新版本。
- **复制诊断信息**：安装位置、进程、时区、代理、策略、`main.log` 里的代理记录，方便排查问题（不含密钥；进程命令行里可能有文件路径，分享前看一眼）。
- **桌面快捷方式**：“用当前方案启动 Claude”“一键关闭 Claude”“一键强制结束全部”。快捷方式调用命令行，不打开窗口。

### 托盘和命令行

关闭窗口时管理器默认缩到托盘（Claude 退出后它要负责恢复时区）。右键托盘图标可以用某个方案启动、关闭、强制结束、恢复时区、退出管理器。“设置”里可以让它开机时自动在托盘里运行。

命令行（桌面快捷方式用的就是它）：

```
ClaudeDesktopManager.exe start [--profile 方案名]     用方案启动（已在运行就不动）
ClaudeDesktopManager.exe restart [--profile 方案名]   关闭后用方案重新启动
ClaudeDesktopManager.exe stop                          关闭：先正常退出，再结束残留进程
ClaudeDesktopManager.exe kill                          立即结束全部进程
ClaudeDesktopManager.exe status                        显示状态
ClaudeDesktopManager.exe restore-tz                    恢复被临时切换的系统时区
ClaudeDesktopManager.exe --tray                        只在托盘里运行
```

在命令提示符里运行时结果会打印出来；加 `--out 文件` 会把结果写到文件里。用某个改时区的方案 `start` 时，如果管理器没在运行，会顺便在托盘里启动一个，负责之后恢复时区。

## 设置文件

方案和设置保存在 `%APPDATA%\ClaudeDesktopManager\settings.json`，操作记录在同目录的 `manager.log`。如果 exe 旁边有一个 `ClaudeDesktopManager.settings.json`，就改用那个文件（便携模式，放 U 盘里带着走）。

## 已知限制

- **MSIX 版无法传环境变量**：现在官网下载的 Claude Desktop 是 MSIX 包，只能通过 Windows 的应用激活来启动，启动参数能带上，环境变量带不进去。所以“环境变量”方式和“额外环境变量”只对旧版安装和自定义路径有效。需要给某个 MCP 服务器设代理时，可以写在配置文件里该服务器的 `env` 中。
- **启动参数**：管理器会在启动后读 Claude 主进程的命令行确认参数是否带上，没带上时会在操作记录里提示。
- **官方代理策略**：`egressProxyUrl` 写在 Claude 面向企业部署的文档里。用 claude.ai 账号登录的普通模式下是否生效，以 `main.log` 为准：生效时启动后会有 `[egress-proxy] pinned to fixed proxy at …` 这一行（“网络代理”页和“维护”页都能看到）。
- **时区切换是系统级的**：Claude 运行期间，所有程序看到的都是切换后的时区。
- 只支持 Windows 10 / 11。在其他系统上可以用 `--demo` 参数看界面（假数据），开发时用。

## 开发

```
desktop-manager/
  src/Core/       与平台无关的逻辑：方案和设置、启动参数、进程识别和结束顺序、启动 / 关闭 / 时区 / 策略流程、
                  JSON（保留键顺序）、MCP 配置、代理测试、日志和缓存
  src/Platform/   Windows 实现（Toolhelp32、NtQueryInformationProcess、MSIX 激活、tzutil、注册表、服务）和自检
  src/UI/         WinForms 界面
  tests/          单元测试（在任何系统上都能跑：dotnet run -c Release --project desktop-manager/tests）、
                  e2e.ps1（Windows 上用假的 Claude.exe 做端到端测试）
```

CI（`.github/workflows/desktop-manager.yml`）在 Linux 和 Windows 上跑单元测试；在 Windows 上还会运行 `ClaudeDesktopManager.exe selftest` 检查各项 Windows 调用，用一个假的 Claude.exe 走一遍“启动 → 状态 → 关闭 → 启动 → 强制结束”，检查参数、环境变量、时区切换和恢复、哪些进程被结束或保留，并截取每一页的截图。
