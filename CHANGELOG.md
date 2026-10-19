# Changelog

## Unreleased

## 0.2.2

- 返回带令牌的地址前，基础地址和结果都必须是 http(s)、不含用户信息；结果必须与基础源一致，且恰好一个非空 `token`。不合格的基础地址在调用 `authenticatedUrl` 之前就拒绝，错误文本不包含 URL。
- 非回环主机（`--public-url`、局域网地址、`0.0.0.0`）默认拒绝。需要时在 profile 补丁里把该条目的 `config.allowPublic` 设为 `true`；后写补丁会整段替换 `config`。
- 文档写明：调用成功仍会把令牌送进会话和后续模型请求。

对齐 DSH 官方插件基线：`engines.dsh` / `engines.node`、`@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-tools` peer 范围统一为官方声明，`files` 纳入 `SECURITY.md`，README 兼容性表同步更新。

## 0.2.1

按 DSH 社区插件交付规范补齐发布门禁，并修正跨版本声明。

- 安装声明：`engines.node` 改为 `^22.19.0 || >=24.0.0`，同时覆盖 Node 22 与 24；`peerDependencies` 的 `@deepseek-ai/dsh-tools` 采用社区跨代范围，避免只声明单个 prerelease 元组。
- 展示元数据：新增 `locale/en.json`、`zh.json`、`es.json`、`pt.json`、`hi.json`（`meta.title` / `meta.description`）与原创 `icon.svg`，并导出 `./locale/*.json`、`./icon`，Plugins 页与 Settings 不再显示原始包 id 和默认占位图。
- 打包：`files` 纳入 `src`、patch、`locale`、图标与全部 README；新增 `scripts/check-pack.mjs`，在 `prepublishOnly` 与 CI 中校验 tarball 内容。
- 文档：README 改为英文主文档并补齐中、西、葡、印地语版本；新增排障节（bundle 未写入、`allow-version` 精确版本豁免、Windows `EPERM`、无 Web GUI 的 profile）。
- 测试：新增 `test/manifest.test.js`，把 manifest、展示元数据、README 标题一致性与打包不变量锁进 `node --test`。
- `packageManager` 固定为 `pnpm@11.7.0`；`dsh.manifestVersion` 标记为 `1`。

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
