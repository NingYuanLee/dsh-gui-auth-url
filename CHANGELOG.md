# Changelog

## 0.1.0

首个版本。

- 新增 `gui_session_url` 工具：进程内调用官方 `connection.authenticatedUrl()` 返回当前 Web GUI 的合法带 token 地址。
- 支持 `webApp.getAdvertisedUrl()` → `webServer.getOrigin()` → `protocol + port` 三级降级，覆盖 `dsh web`、桌面版、`--public-url` 与 TLS 场景。
- 不读取 `.credentials.yaml`、不伪造 Cookie。
- 14 个单元测试覆盖 URL 解析、降级顺序、错误路径与工具注册。
