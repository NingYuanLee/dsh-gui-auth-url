# dsh-gui-auth-url

[![CI](https://github.com/NingYuanLee/dsh-gui-auth-url/actions/workflows/ci.yml/badge.svg)](https://github.com/NingYuanLee/dsh-gui-auth-url/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.0--rc.2%20%3C0.3.0-6f42c1)](package.json)

> DeepSeek Harness 第三方社区插件，非 DeepSeek 官方产品。MIT。

[English](README.md) | 中文 | [Español](README-es.md) | [Português](README-pt.md) | [हिन्दी](README-hi.md)

把当前运行中的 DeepSeek Harness Web GUI 的**合法带 token 地址**暴露成一个 agent 工具，让浏览器自动化和脚本能真正打开 GUI，而不是撞上 `401 dsh web authentication required`。

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

基础地址按 `webApp.getAdvertisedUrl()`（尊重 `--public-url` 与挂载路径）→ `webServer.getOrigin()` → 协议 + 回环端口 顺序解析。每次调用都重新取当前值，桌面版随机端口与重启后的令牌变化都不需要缓存。

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

npm 尚未发布，目前只通过 GitHub 分发。

从旧名 `dsh-gui-session`（0.1.x）升级：包名、Cordis 条目 id 与工具名都变了，**必须重装一次**：

```bash
dsh plugin --profile <name> remove dsh-gui-session
dsh plugin --profile <name> add github:NingYuanLee/dsh-gui-auth-url
```

## Usage

插件注册一个无参数工具 `gui_auth_url`，返回：

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

## Security

- 返回的 URL 含**本进程的启动令牌**，等价于一次已登录会话的凭据，只在 Host 进程存活期间有效。
- 不要写入日志、提交到仓库或发到聊天里；需要时重新调用工具，重启即失效。
- 插件不读取 `.credentials.yaml`，也不生成 Cookie；权限边界与你在终端里执行 `dsh web` 完全一致。
- 与 [Discussion #8678](https://github.com/deepseek-ai/deepseek-harness/discussions/8678) 描述的问题（沙箱内可读签名密钥并伪造 Cookie）**无关**：本插件不接触该密钥。

## Compatibility

| 项 | 值 |
|---|---|
| dsh | `>=0.2.0-rc.2 <0.3.0` |
| Node | `^22.19.0 \|\| >=24.0.0` |
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

## Development

```bash
node --test test/*.test.js          # 单元测试 + 清单合规测试
node --check src/index.js && node --check src/auth-url.js
npm run check:pack                  # 校验发布 tarball 内容
```

```text
src/auth-url.js    纯函数：base URL 解析 + 调 Host 取会话（可单测）
src/index.js       Cordis 插件入口：注册 gui_auth_url 工具
locale/            展示元数据（en、zh、es、pt、hi）
test/              node:test 用例，含打包不变量
scripts/           prepublishOnly 与 CI 使用的 tarball 检查
```

插件只注册一个工具；`ctx.tools.register` 返回的 disposer 由 Cordis 持有，卸载或热重载时会干净移除。

## Related

- [Discussion #5932](https://github.com/deepseek-ai/deepseek-harness/discussions/5932) — 本机脚本访问 Web UI 被 401
- [Discussion #5828](https://github.com/deepseek-ai/deepseek-harness/discussions/5828) — 请求 `--no-browser-auth`，未采纳
- [Discussion #9085](https://github.com/deepseek-ai/deepseek-harness/discussions/9085) — 桌面版拿不到合法会话
- [官方连接契约](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/connection/README.md)
- [DeepSeek Harness 社区插件目录](https://dsplugin.app/) — 发现更多插件
