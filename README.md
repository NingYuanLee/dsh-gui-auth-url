# dsh-gui-session

把当前运行中的 DeepSeek Harness Web GUI 的**合法带 token 地址**暴露成一个 agent 工具，让浏览器自动化和脚本能真正打开 GUI，而不是撞上 `401 dsh web authentication required`。

> 第三方社区插件，非 DeepSeek 官方产品。MIT。

---

## 问题

`dsh --profile web` 每个进程都会随机生成一个启动令牌，只打印一次：

```
dsh web: http://127.0.0.1:3080/?token=AbC...
```

`GET /?token=…` 校验通过后写入一个绑定 host:port 的签名 Cookie 并 303 到 `/`。直接访问裸地址会得到：

```
401 dsh web authentication required; reopen the URL printed by dsh web.
```

桌面版（Electron）自己起 Host 进程（随机端口），**从不打印这一行**，所以任何外部浏览器/自动化工具打开 `http://127.0.0.1:<port>/` 必然 401。官方目前没有 `--no-browser-auth` 之类的开关。

## 本插件的做法

不碰 `$DSH_HOME/.credentials.yaml` 里的签名密钥，也不自己伪造 Cookie。插件运行在 Host 进程内，直接调用官方公开的 `connection.authenticatedUrl(baseUrl)` —— 也就是 `dsh web` 打印那行 URL 时用的同一个方法 —— 把结果作为工具返回值交给模型。

所以拿到的是**真正的第一方会话**，与你在终端里手动打开的是同一个东西。

## 安装

```bash
# 装进你要用的 profile（web 或 desktop）
dsh plugin --profile web add dsh-gui-session
```

或从源码本地链接：

```bash
git clone https://github.com/NingYuanLee/dsh-gui-session.git
dsh plugin --profile web add ./dsh-gui-session
```

该插件是 bundle，`cordis.patch.yml` 会自动插入 `gui-session` 条目，无需手改配置。

## 使用

插件需要 Web 组合（提供 `connection` / `webServer` 服务）。装好后重启 DSH，模型即可看到工具：

### `gui_session_url`

无参数，返回：

```json
{
  "url": "http://127.0.0.1:3080/?token=AbC...",
  "origin": "http://127.0.0.1:3080",
  "protocol": "http:",
  "host": "127.0.0.1",
  "port": "3080",
  "secure": false
}
```

把 `url` 交给浏览器（`navigate_page`）、`curl` 或任何 HTTP 客户端即可进入 GUI。

典型用途：让 agent 在调试 DSH 自身时，用 chrome-devtools-mcp 实机验证 GUI 的布局、交互和 RPC，而不是只能读代码猜。

## 安全说明

- 返回的 URL 含**本进程的启动令牌**，只在当前 Host 进程存活期间有效；进程重启即失效。
- 不要写入日志、提交到仓库或发到聊天里；它是凭据，等价于一次已登录会话。
- 插件不读取 `.credentials.yaml`，也不生成 Cookie；权限边界与你在终端里执行 `dsh web` 完全一致。
- 与 [Discussion #8678](https://github.com/deepseek-ai/deepseek-harness/discussions/8678) 描述的问题（沙箱内可读签名密钥并伪造 Cookie）**无关**：本插件不接触该密钥，因此不构成伪造会话的能力。

## 已知限制

- 桌面版每次启动端口随机，令牌也随之变化；工具每次调用都重新取当前值，所以不需要缓存。
- 未鉴权工具只对 Web 组合的 profile 有意义（`headless` 等无 `webServer` 的 profile 上会报 “serves no Web GUI”）。
- 插件依赖 DSH 的公开服务 `connection.authenticatedUrl` 与 `webServer.getOrigin`；若上游改动，会以明确错误暴露而不是静默返回错地址。

## 开发

```bash
node --test test/*.test.js     # 14 个用例：URL 解析、降级、错误路径、工具注册
node --check src/index.js
```

```text
src/session.js   纯函数：base URL 解析 + 调 Host 取会话（可单测）
src/index.js     Cordis 插件入口：注册 gui_session_url 工具
test/            node:test 用例
```

## 兼容性

| 项 | 值 |
|---|---|
| dsh | `>=0.2.0-rc.2 <0.3.0` |
| Node | `>=22.19.0` |
| 验证环境 | dsh `0.2.1-rc.2`，Windows x64，desktop 与 web profile |

## 相关

- [Discussion #5932](https://github.com/deepseek-ai/deepseek-harness/discussions/5932) — 本机脚本访问 Web UI 被 401，零回复
- [Discussion #5828](https://github.com/deepseek-ai/deepseek-harness/discussions/5828) — 请求 `--no-browser-auth`，未采纳
- [Discussion #9085](https://github.com/deepseek-ai/deepseek-harness/discussions/9085) — 桌面版拿不到合法会话
- [官方连接契约](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/connection/README.md)
