# Changelog

## 0.2.0

更名：`dsh-gui-session` → `dsh-gui-auth-url`。旧名里的 `session` 与 DSH 自身的「会话」概念（`~/.dsh/sessions`、聊天 session）撞车，而插件交付的是「一个可打开的第一方鉴权 URL」。

- npm 包名 / GitHub 仓库：`dsh-gui-auth-url`（旧仓库地址 GitHub 自动重定向）。
- 工具名：`gui_session_url` → `gui_auth_url`。
- Cordis 条目 id：`gui-session` → `gui-auth-url`；displayName：「GUI Session」→「GUI Auth URL」。
- 源码：`src/session.js` → `src/auth-url.js`；`resolveGuiSession` → `resolveGuiAuthUrl`。
- 升级需重装（包名与 bundle 条目都变了），见 README「从旧名升级」。

## 0.1.1

修正工具描述：模型实际看到的是可直接打开的 url 文本，结构化字段只对程序化调用可见。原先的描述会让模型以为结果里有独立字段。

## 0.1.0

首个版本。

- 新增 `gui_session_url` 工具：进程内调用官方 `connection.authenticatedUrl()` 返回当前 Web GUI 的合法带 token 地址。
- 支持 `webApp.getAdvertisedUrl()` → `webServer.getOrigin()` → `protocol + port` 三级降级，覆盖 `dsh web`、桌面版、`--public-url` 与 TLS 场景。
- 不读取 `.credentials.yaml`、不伪造 Cookie。
- 14 个单元测试覆盖 URL 解析、降级顺序、错误路径与工具注册。
