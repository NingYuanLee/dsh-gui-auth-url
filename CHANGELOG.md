# Changelog

## 0.1.1

修正工具描述：模型实际看到的是可直接打开的 url 文本，结构化字段只对程序化调用可见。原先的描述会让模型以为结果里有独立字段。

## 0.1.0

首个版本。

- 新增 `gui_session_url` 工具：进程内调用官方 `connection.authenticatedUrl()` 返回当前 Web GUI 的合法带 token 地址。
- 支持 `webApp.getAdvertisedUrl()` → `webServer.getOrigin()` → `protocol + port` 三级降级，覆盖 `dsh web`、桌面版、`--public-url` 与 TLS 场景。
- 不读取 `.credentials.yaml`、不伪造 Cookie。
- 14 个单元测试覆盖 URL 解析、降级顺序、错误路径与工具注册。
