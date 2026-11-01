# dsh-gui-auth-url

[![CI](https://github.com/NingYuanLee/dsh-gui-auth-url/actions/workflows/ci.yml/badge.svg)](https://github.com/NingYuanLee/dsh-gui-auth-url/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.1--rc.2%20%3C0.3.0--0-6f42c1)](package.json)

> DeepSeek Harness 第三方社区插件，非 DeepSeek 官方产品。MIT。

[English](README.md) | 中文 | [Español](README-es.md) | [Português](README-pt.md) | [हिन्दी](README-hi.md)

把当前运行中的 DeepSeek Harness Web GUI 的**合法带 token 地址**暴露成一个 agent 工具，让浏览器自动化和脚本能真正打开 GUI，而不是撞上 `401 dsh web authentication required`。

它还提供**临时鉴权 DSH Web**：agent（`dsh_web_start` / `dsh_web_restart` 工具）或人（`/dsh-web` 命令：没有实例就启动，有实例就原地重启）都能按会话拉起一个独立进程 + 临时 `DSH_HOME` + 独立端口的实例，用来验证新插件、新界面或新 profile 而不碰桌面端正在使用的会话；每个会话各一份，互不干扰，且实例只能以“绑定到会话的受管后台任务”形式存在。

## The problem

`dsh --profile web` 每个进程随机生成一个启动令牌，只打印一次：

```text
dsh web: http://127.0.0.1:3080/?token=...
```

`GET /?token=...` 校验通过后写入一个绑定 host:port 的签名 Cookie 并 303 到 `/`。直接访问裸地址会得到：

```text
401 dsh web authentication required; reopen the URL printed by dsh web.
```

桌面版自己起 Host 进程（随机端口），**从不打印这一行**，所以任何外部浏览器/自动化工具打开 `http://127.0.0.1:<port>/` 必然 401。官方目前没有 `--no-browser-auth` 之类的开关。

## How it works

插件运行在 Host 进程内，直接调用官方公开的 `connection.authenticatedUrl(baseUrl)` —— 也就是 `dsh web` 打印那行 URL 时用的同一个方法 —— 把结果作为工具返回值交给模型。

不碰 `$DSH_HOME/.credentials.yaml` 里的签名密钥，也不自己伪造 Cookie，所以拿到的是**真正的第一方会话**，与你在终端里手动打开的是同一个东西。

基础地址按 `webApp.getAdvertisedUrl()`（尊重 `--public-url` 与挂载路径）→ `webServer.getOrigin()` → 协议 + 回环端口 顺序解析。每次调用都重新取当前值，桌面版随机端口与重启后的令牌变化都不需要缓存。只有基础地址是绝对的 `http` 或 `https`、不含用户名密码，并且主机是回环地址（`127.0.0.0/8`、`localhost` 或 `::1`）时，才会贴上令牌。插件配置显式 `allowPublic: true` 才允许非回环主机。返回的 URL 必须与该源一致，且恰好带一个 `token`。基础地址不合格时，在调用 `authenticatedUrl` 之前就拒绝，错误文本不包含 URL。

## Install

```bash
dsh plugin --profile web add github:NingYuanLee/dsh-gui-auth-url
```

包声明了 `dsh.bundle.patch`，`dsh plugin add` 会自动把 bundle 写进 profile 的 `dsh.profile.bundles`。重启 DeepSeek Harness 后工具即可用。

或先克隆再本地安装：

```bash
git clone https://github.com/NingYuanLee/dsh-gui-auth-url.git
dsh plugin --profile web add ./dsh-gui-auth-url
```

npm 包名是 `dsh-gui-auth-url`。源码仓库在 GitHub。

从旧名 `dsh-gui-session`（0.1.x）升级：包名、Cordis 条目 id 与工具名都变了，**必须重装一次**：

```bash
dsh plugin --profile <name> remove dsh-gui-session
dsh plugin --profile <name> add github:NingYuanLee/dsh-gui-auth-url
```

## Usage

插件注册一个无参数的 agent 工具 `gui_auth_url`、两个实例工具 `dsh_web_start` / `dsh_web_restart`，以及一条人类命令 `/dsh-web`（旧名 `/web-gui` 保留为可执行别名）。工具返回：

```json
{
  "url": "http://127.0.0.1:3080/?token=...",
  "origin": "http://127.0.0.1:3080",
  "protocol": "http:",
  "host": "127.0.0.1",
  "port": "3080",
  "secure": false
}
```

模型看到的是 `url` 文本；其余字段供程序化调用读取。把 `url` 交给 `navigate_page`、`curl` 或任何 HTTP 客户端即可进入 GUI。

典型用途：让 agent 在调试 DSH 自身时，用 chrome-devtools-mcp 实机验证 GUI 的布局、交互和 RPC，而不是只能读代码猜。

`/dsh-web` 是给人用的那一半：在 GUI 输入框里输入它，插件会**自动判断**——本会话还没有实例就新起一个 `dsh web` Host（自己的临时 `DSH_HOME` + 系统分配的端口）并用默认浏览器打开；已经有实例就**原地重启**它（保留临时目录与已装插件，沿用原端口、令牌换新，已打开的页面刷新即可继续）。实例与桌面版正在跑的会话不共享任何东西，所以浏览器里的那份 GUI 是干净、可丢弃的。不同会话各自独立，A 会话的实例不会被 B 会话停掉或复用；实例只能以“绑定到某个会话”的形式存在，拿不到会话 id、或 job 注册表拒绝归属绑定时直接报错，不会留下没人能停止的无主实例。它是本会话的受管后台任务：登记的 owner 是**发起指令的会话 id**，所以桌面端会话顶部会一直显示「运行中」，可以在那里停止；归档这个会话时若实例仍在运行，DSH 的归档确认会把它列为活动，并可在确认时一并停止。宿主机器没有可打开的浏览器时，在 profile 补丁里设 `openBrowser: false`，命令就只回显链接。

默认会把本进程可用的 `DEEPSEEK_API_KEY`（先看继承的环境变量，再看凭据服务）作为环境变量**复制**给隔离实例，它因此不用重新登录就能对话；key 不会写进临时目录的磁盘，但每一轮都消耗同一账号配额。要关闭共享，在 profile 补丁里设 `shareApiKey: false`。

同时最多运行 4 个隔离实例（profile 补丁里 `maxInstances` 可调，1–32）；超过后再启动会直接报错并要求先停一个——每个实例都是一个完整的 `dsh web` 进程，这样能避免堆积。主动停止的实例在后台任务列表里显示为「已取消」，不是「失败」。

**原地重生**：`/dsh-web` 在已有实例时会自动重启（想强制重启可写 `/dsh-web restart`，agent 用 `dsh_web_restart` 工具）。重启保留临时 `DSH_HOME` 并**尽量沿用原端口**——进程换新、token 换新，但浏览器 Cookie 绑定 host:port、签名密钥就在这个临时目录里，所以已打开的旧页面刷新即可继续用；只有原端口被占用时才回退到随机端口（结果里会说明）。已安装的插件、配置和实例内的会话都还在；普通停机则会连同临时目录一起删除。典型用法：把插件临时装进实例 → 再执行一次 `/dsh-web` 让它生效 → 试完停掉，桌面端什么都没装。

为防止残留堆积，每个临时 home 会写入 `instance.json`（host PID、Desktop PID、端口）。插件启动时扫描 `%TEMP%/dsh-web-gui-*`，清理宿主或父进程已死的 home，并在该端口仍返回 DSH 的 401 签名时结束遗留进程；无标记的旧版目录只清理超过 24 小时的。停止实例时 Windows 上按进程树结束，避免子进程残留。

给 agent 的入口有三个，职责不同、别混用：`gui_auth_url` 返回**当前桌面进程**的地址（就是你正看着的那个 GUI，只读、无副作用）；`dsh_web_start` 起或复用**临时实例**并返回它的 `url` 与 `jobId`（不打开浏览器）；`dsh_web_restart` 原地重启那个实例并保留临时目录。停止走「后台任务」列表或 `job_kill`；三者共用同一份 `shareApiKey`、归属与清理规则。

空白会话（还没有任何消息）里不能执行 `/dsh-web`：DSH 会把这种会话从会话列表里过滤掉，切换后会话消失，实例就会失去顶部的停止入口。命令会直接返回提示，要求先发一条消息或切换到已有会话。这条提示显示在输入框上方的通知区——空白会话不渲染对话记录，而命令结果本来只在对话记录里显示，所以插件在客户端额外补了一次。

另外，输入框里完整输入 `/dsh-web` 时，`/` 菜单（DSH 自身的候选菜单）的高亮此时可能停在下一条候选上，回车会选中高亮行、而不是执行你刚输入的命令；请用鼠标点选「临时鉴权 DSH Web」那一行。

## Security

- 返回的 URL 含**本进程的启动令牌**，等价于一次已登录会话的凭据，只在 Host 进程存活期间有效。
- 不要写入日志、提交到仓库或发到聊天里；需要时重新调用工具，重启即失效。
- 调用成功仍会把令牌写入会话，并在后续模型请求里送出。「不要写入日志」约束不了 Host 自己落盘。这比终端里 `dsh web` 打印一次的读者范围更大。
- 插件不读取 `.credentials.yaml`，也不生成 Cookie。
- 非回环地址（`--public-url`、局域网地址或 `0.0.0.0`）默认拒绝，除非插件配置恰好是 `allowPublic: true`。打开后会信任广告出来的主机。
- 与 [Discussion #8678](https://github.com/deepseek-ai/deepseek-harness/discussions/8678) 描述的问题（沙箱内可读签名密钥并伪造 Cookie）**无关**：本插件不接触该密钥。

## Compatibility

| 项 | 值 |
|---|---|
| dsh | `>=0.2.1-rc.2 <0.3.0-0` |
| Node | `>=22.19.0` |
| 验证环境 | dsh `0.2.1-rc.2`，Windows x64，desktop 与 web profile |
| Web 组合 | 需要 `connection` 服务；无 Web GUI 的 profile 会给出明确错误 |

展示元数据（`locale/*.json` + 导出的 `./icon`）让 Plugins 页与 Settings 显示正常的标题、描述和图标，而不是原始包 id。插件无构建步骤，直接发布 ESM JavaScript。

## Troubleshooting

**装完工具没出现？** 确认 profile 的 `package.json` 里 `dsh.profile.bundles` 含 `dsh-gui-auth-url`。`dsh plugin add` 通常会写入，但安装中途失败可能只留下依赖：

```json
{
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-gui-auth-url"] } }
}
```

改完重启 DSH，用 `dsh --profile <name> --dump-config` 确认出现 `gui-auth-url` 行。

**安装因版本不匹配被拒。** DSH 会在安装期检查 `engines.dsh`（或 dsh peer 范围）。宿主版本超出声明范围时，授予精确版本豁免、重装，并在兼容版本发布后撤销：

```bash
dsh plugin --profile <profile> version-exemptions
dsh plugin --profile <profile> allow-version dsh-gui-auth-url@0.2.1 --dsh-version <runtime> --accept-risk
dsh plugin --profile <profile> revoke-version dsh-gui-auth-url@0.2.1
```

**Windows 报 `EPERM: rename ... node_modules\dsh-gui-auth-url_tmp_*`？** 先停掉用该 profile 的 DSH 进程，删掉残留的 `node_modules\dsh-gui-auth-url` 目录后重试；运行中的进程会锁目录。

**报“This profile serves no Web GUI”。** 只有 profile 挂载了 `webApp` 或 `webServer` 以及 `connection` 时才有地址可返回；headless 类 profile 没有 GUI 可开。

**报 “refusing to attach the launch token to a non-loopback host”。** 广告地址不是回环地址，令牌不会返回。若确实要允许该主机，在 profile 补丁里写下面这项。后写的补丁会整段替换 `config`，其他键要放在同一个对象里：

```yaml
- id: gui-auth-url
  config:
    allowPublic: true
```

桌面版回环地址不要设置 `allowPublic`。打开后会信任 `webApp.getAdvertisedUrl()` 返回的任意主机。

## Development

```bash
node --test test/*.test.js          # 单元测试 + 清单合规测试
node --check src/index.js && node --check src/auth-url.js && node --check src/api-key.js && node --check src/command.js && node --check src/isolated-tool.js && node --check src/isolated-web.js && node --check client.js
npm run check:pack                  # 校验发布 tarball 内容
```

```text
src/auth-url.js     纯函数：base URL 解析 + 调 Host 取会话（可单测）
src/api-key.js      隔离实例的 DEEPSEEK_API_KEY 解析
src/command.js      /dsh-web 命令：启动/自动重启与打开浏览器
src/isolated-web.js 按会话的实例管理器（spawn、restart、stop、清扫）
src/isolated-tool.js agent 工具 dsh_web_start / dsh_web_restart
src/index.js        Cordis 入口：gui_auth_url 与实例相关表面
client.js           浏览器端：命令标签/图标、隐藏旧别名、空白会话提示
locale/             展示元数据（en、zh、es、pt、hi）
test/               node:test 用例，含打包不变量
scripts/            prepublishOnly 与 CI 使用的 tarball 检查
```

插件注册一个只读工具、两个实例工具和一条人类命令；`ctx.tools.register` 返回的 disposer 由 Cordis 持有，卸载或热重载时会干净移除。

推送 `v*` 标签会触发 `.github/workflows/publish.yml`；仓库 Secret 未配置 `NPM_TOKEN` 时该工作流跳过发布并在日志里说明。手动发布（上面的流程）仍然有效。

## Releasing

发布用一条命令：`npm run release -- patch|minor|major`（加 `--dry-run` 只预览，不改任何东西）。它会先跑完整校验（测试 + 语法 + 打包），不通过就中止且不动文件；通过后改版本、提交、打 tag 并推送。tag 推送后由 `.github/workflows/publish.yml` 自动发布：仓库在 Settings → Secrets and variables → Actions 里配置了名为 `NPM_TOKEN` 的 npm 自动化令牌就发布，没配置就跳过并在日志里说明。

## Related

- [Discussion #5932](https://github.com/deepseek-ai/deepseek-harness/discussions/5932) — 本机脚本访问 Web UI 被 401
- [Discussion #5828](https://github.com/deepseek-ai/deepseek-harness/discussions/5828) — 请求 `--no-browser-auth`，未采纳
- [Discussion #9085](https://github.com/deepseek-ai/deepseek-harness/discussions/9085) — 桌面版拿不到合法会话
- [官方连接契约](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/connection/README.md)
