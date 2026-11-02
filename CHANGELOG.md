# Changelog

## 0.8.1

- **修复：重启时旧宿主的迟到 exit 不再删除新宿主的 home 与所有权记录**。原地重启会先 kill 旧宿主，而「确认退出」允许先由 pid 从进程表消失满足，旧宿主的 `exit` 事件可能在新宿主接管同一个 `DSH_HOME` 之后才到达；原来的退出回调会无条件 `removeHome(home)`，把新宿主的临时目录连同 `.owner-records/<实例>.json` 一起删掉，下一次停止就找不到所有权记录（`the home has no readable owner marker`），进程因此无人认领。现在每个 home 有租约（`homeLeases`）：spawn 时登记，退出回调只清理仍归自己的 home，stop 确认退出后回收租约。回归测试 `a late exit from the replaced host never deletes the restarted home` 覆盖该路径。
- **修复：Windows 上结束宿主先跑 `taskkill /T`，再回退到直接 kill 根进程**。原来的顺序是先 `child.kill()` 再让 `taskkill /T` 跑：如果启动器是 PATH 上的 `dsh.cmd`（普通 Node 安装），管理器与真实宿主之间隔着一到两个 `cmd.exe`，根进程先死会把宿主 reparent 掉，`taskkill` 再遍历时那棵树已经不存在，宿主因此成为孤儿——而管理器以为已退出，还会删掉它的临时 home。现在 `killTree` 在 `/T` 未结束前不发直接 kill，`taskkill` 起不来或报错时才回退，并有 2 秒兜底；顺序由 `killTree` 的三条单测固定，`npm run smoke --launcher=shim` 可在 shim 路径上真验证收尾。
- **新增 `npm run smoke`**（`scripts/smoke-isolated.mjs`）：真启动一个隔离 `dsh web`、原地重启、停止，并断言临时 home 与所有权记录都清空。仅手动运行（CI、提权 shell、缺少 `dsh` 启动器时跳过），`finally` 与 `SIGINT` 都保证收尾——手写探针中断正是上次留下孤儿宿主的直接原因。

## 0.8.0

- **一次性实例目录搬进 Harness home，并且只删自己建的那个目录**：临时 `DSH_HOME` 不再落在 `%TEMP%\dsh-web-gui-*`，改为 `<DSH_HOME>/dsh-gui-auth-url/instances/run-*`——位置在运行时按每台机器自己的 `$DSH_HOME`（缺省 `~/.dsh`）解析，插件里没有任何写死路径。目录用**非递归 `mkdir`** 独占创建（重名即换名，绝不认领已有目录）；所有权记录写在实例根的 `.owner-records/<实例>.json`，不放在宿主自己的 home 里——实测真实宿主第二次启动会清掉 home 根下的未知文件，标记放在 home 里会被一起清掉。记录以 `wx` 独占写入并带随机实例令牌，宿主每次输出 URL 后再幂等重建一次；原地重启从第一次 kill 到替换实例跑起来之间全程持有该实例，失败重试期间也不会被子进程退出误删。正常停机删除前必须匹配**本进程的创建记录与令牌**；跨进程遗留走单独的 `removeStaleInstanceHome`，只按标记与真实路径校验。根路径逐级创建并校验：`dsh-gui-auth-url`、`instances` 任一级已是 junction/符号链接就拒绝，`realpath` 脱离父级也拒绝。调用方即使把路径算错（空变量、误用只读的 `$home`、符号链接绕路），最坏结果是报错，而不是删掉用户目录。启动清扫同时覆盖新根与旧的 `%TEMP%\dsh-web-gui-*`，历史残留仍在首次启动时回收；旧目录没有实例令牌，只按宿主标记判定，且**仅在记录到的 pid 仍存活时**才校验端口归属（pid 已死时没有可归属的活进程，直接进入清理）。宿主存活时必须先证明「记录 pid 确实是监听所探测端点（`127.0.0.1:port`，地址与端口精确匹配）的进程」，解析有歧义或平台不支持就一律不终止；验证通过后还要等待其真正退出，退出未确认则目录与进程都保留。
- **正常停机也确认退出**：`jobs.wait` 超时或注册表拒绝不再被当作"已停止"。退出证明单独维护——只有子进程的 `exit` 事件、或 pid 从进程表消失才算数；job 以 `error` 结算（进程可能还活着）**不**算退出证明。确认不了就保留目录并报错，原地重启也会因此中止，避免两个进程共用一个 home。停止失败时实例仍留在 manager 的映射里，可查询、可重试停止，也不会被当作不存在而启动替代实例。**启动失败路径同样适用**：宿主在输出 URL 前失败、或启动超时后无法终止时，不再直接删目录，而是先确认 `exit`（或 pid 消失）；确认不了就保留目录、保留实例记录，交给后续 `dsh_web_stop` 重试。只有尚未 spawn 子进程的分支（安装失败、注册表在 spawn 前拒绝）才直接清理。原地重启的「换端口重试」也同步收紧：只有前一次尝试**已确认退出**、且失败原因明确是端口占用（`EADDRINUSE` / `address already in use`）时才换端口重试；退出未确认时直接上抛，不会用同一个 home 再起第二个进程。
- **启动参数透传**：`dsh_web_start` 把 `host`、`public_url`、`tls_cert`/`tls_key`、`trusted_host`、`port` 透传给被拉起的 `dsh web`。`host` 只接受具体的 IPv4/IPv6 字面量，`0.0.0.0`、`::`、`*` 一律拒绝——通配会把实例发布到所有网卡；这些暴露类参数统一要求 `allowPublic: true` 才放行。`port` 取 0–65535，`0` 交给系统分配；`dsh_web_restart` 故意不收 `port`，重启沿用原端口，已打开的页面才能继续用。
- **装插件闭环**：新增 `install` 参数（`string[]`），在宿主启动前用 `dsh plugin --profile web add` 把包装进临时 `DSH_HOME`，于是「本地插件 → 装进一次性实例 → 重启生效 → 验证 → `dsh_web_stop` 清理」成了一个闭环，桌面 profile 全程不动。代价是 pnpm 会以当前用户身份执行这些包的 lifecycle 脚本；spec 做了字符白名单校验（拒绝空格、引号与 `&|<>^`），挡住的是安装命令注入，不是恶意包本身。安装失败会删掉临时目录，并把安装输出的尾部带回错误里，不留半成品实例。
- **新增 `dsh_web_stop`**：无参数停止本会话的临时实例并删除临时 `DSH_HOME`，返回 `{ stopped }`。此前停止只能走「后台任务」列表或 `job_kill`，agent 自己没法在一个闭环里收尾。
- **新增 `dsh_web_status`**：无参数、无副作用地汇报本会话实例状态（`running`、`url`、`jobId`、`startedAt`、`home`、`port`、`sharedKey`、`install`、`exposed`，以及全局的 `runningCount` 与 `maxInstances`）。此前只能靠上一次工具返回的记忆、或再启动一次来确认实例是否还活着。
- **新增配置 `allowInstall`（默认 `true`）**：控制 `install` 参数是否被接受，设 `false` 时带 `install` 的请求直接报错。默认开启是因为「在一次性实例里试插件」本身就是这个功能的用途；不接受第三方安装需求的部署可以关掉。既有 4 个键（`allowPublic`、`openBrowser`、`shareApiKey`、`maxInstances`）不变。
- **SECURITY.md 重写**：删掉「插件不监听端口、不 spawn 进程、不发外连」这类自 0.4.0 起就已失真的整段断言，改为按路径分述——取 URL 路径（不读 `.credentials.yaml`、不铸 Cookie、回环默认）、隔离实例路径（spawn 整个 `dsh web`、临时 `DSH_HOME`、子进程环境携带 `DEEPSEEK_API_KEY`、`taskkill /T` 结束进程树、home 清理与启动清扫）、install 路径（pnpm lifecycle 脚本＝以当前用户身份执行第三方代码）、暴露面（`allowPublic` 才放行非回环/TLS/`trusted_host`）、token 进会话记录。支持版本口径改为 `0.7.x`/`0.8.x`，不再写已停止支持的 `0.2.x`。

## 0.7.2

- 发布流程自动化：新增 `npm run release -- <patch|minor|major>`（支持 `--dry-run` 预览）与 `preversion` 校验门禁（测试 + 语法 + 打包不通过就不改版本）；Publish 工作流在发布后轮询 registry 校验该版本存在并打印 `latest` dist-tag；五份 README 增加 Releasing 章节。仓库已配置 `NPM_TOKEN` Secret，打 tag 即可由 CI 自动发布。

## 0.7.1

- 文档修正（无运行时变更）：五份 README 的 Development 段同步到当前模块清单与校验命令；es/pt/hi 补齐 `maxInstances` 与「已取消」语义、原地重启沿用原端口与 Cookie 说明、残留清扫、agent 三个入口、空白会话与菜单提示。新增 tag 触发的发布工作流（`.github/workflows/publish.yml`），CI 的语法检查改为 `npm run check`。

## 0.7.0

- **重启沿用原端口**：原地重启不再每次换端口——新宿主尽量监听原端口，只有原端口被占用时才回退到系统分配。因为浏览器的登录 Cookie 绑定 `host:port`、签名密钥就在保留下来的临时 `DSH_HOME` 里，所以**已打开的旧页面刷新即可继续用**（实测：同目录同端口重启后，不带 token 访问仍能进 GUI）；旧链接里的 token 每次仍会变。结果里用 `portKept` 标明是否沿用，文案分别提示“刷新即可”与“需要换新链接”。

- **改名为「临时鉴权 DSH Web」**：人类命令 `/web-gui` → `/dsh-web`，agent 工具 `gui_start_isolated` → `dsh_web_start`、`gui_restart_isolated` → `dsh_web_restart`；插件显示名与 5 种语言 locale 同步改为「临时鉴权 DSH Web」。旧命令名 `/web-gui` 仍可执行（下一版本移除），但不再出现在命令菜单里。模块文件与 npm 包名保持不变。
- **一条命令自动判断启动/重启**：`/dsh-web` 现在自己决定走哪条分支——本会话没有实例就启动，已有实例就原地重启并保留临时 `DSH_HOME`（已装插件、配置都在），不再需要区分子命令；`/dsh-web restart` 仍可强制重启。
- **原地重生**：agent 工具 `dsh_web_restart`（人类命令 `/dsh-web restart`）只替换隔离宿主进程，**保留临时 `DSH_HOME`**——已安装的插件、配置、实例内的会话都还在；端口与启动令牌会更新，旧 URL 失效。这样「在临时实例里装需要重启才生效的插件 → 重启让它生效 → 试完停掉」的闭环才走得通：普通停机会删除整个临时目录，插件也跟着没了。重启不新增并发计数（替换自己的槽位），当前会话没有实例时直接报错并提示先启动。
- **并发实例上限**：全局最多同时运行 4 个隔离实例（profile 补丁里 `maxInstances` 可调，取值 1–32）。超过上限时新启动直接报错并提示先停止一个；同一会话复用自己那份不计入。每个实例都是一个完整 `dsh web` 进程，加这个上限是为了防止堆积。
- **停止语义修正**：主动停止的隔离实例现在以 `killed` 结算，后台任务列表显示「已取消」，不再误报成「失败」（taskkill 的非零退出码此前被当成崩溃）。
- **不再有“无主实例”降级**：实例只能以「绑定到调用方会话」的形式创建。此前会话 agent 未就绪、命令不在会话中执行、或组合里没有 job 控制器时，会退化成无主作业甚至不受跟踪的子进程；现在这些情况一律报错——`createIsolatedWebGui` 缺 `ctx.jobs` 时构造即失败，`ensure()` 缺会话 id 或注册表拒绝归属绑定时不启动任何进程，只把错误抛给调用方。残留的临时目录在失败路径上会被清掉。
- **隔离实例改为按会话隔离**：manager 从“全局一个实例”改成 `Map<会话 id, 实例>`。此前会话 B 调用 `/web-gui` 或 `gui_start_isolated` 会先停掉会话 A 的实例；现在每个会话各有一份隔离 host，启动、复用、停止都只作用于自己那份，`stop(sessionId)` 只停一个，`stop()`（teardown）才全停。
- **面向 agent 的隔离实例入口 `gui_start_isolated`**：此前 agent 只有 `gui_auth_url`（当前桌面进程自己的地址），要验证新插件、新界面或新 profile 只能借用桌面端正在使用的那个会话。新增工具复用 `/web-gui` 那套 manager：按调用方会话 id 起或复用隔离 host（独立进程 + 临时 `DSH_HOME` + 随机端口），**不打开浏览器**，直接返回 `url` 与 `jobId`，可用 `job_kill` 或「后台任务」列表停止；`shareApiKey` 策略、归属规则、残留清理与命令完全一致。没有 `jobs` 的组合不注册该工具，命令与工具都不提供。
- **修复任务没有真正归属会话**：`ctx.jobs` 的 owner 是 **session id 字符串**，此前传的是 Agent 对象，注册因此退化成无主作业——列表里会出现但归档准入（`workspace/session-activity`）无法把它算到当前会话。现在 `/web-gui` 传 `invocation.agent.id`，并且 `jobs.get/kill/wait` 都带同一 session id 作为调用者，任务会持续留在会话顶部，归档运行中的会话时会被 DSH 列为活动并可在确认时一并停止。
- **`shareApiKey` 默认改为 `true`**：`/web-gui` 拉起的隔离实例默认收到当前桌面端的 `DEEPSEEK_API_KEY`（仍是先看继承环境变量、再看凭据服务），隔离窗口可直接对话；只传子进程环境变量，不复制账号 token、不写临时 `DSH_HOME` 磁盘。要关闭共享，在 profile 补丁里设 `shareApiKey: false`。
- 命令结果文案改为说明「顶部可见/可停止」「归档会提示」「已复制 API key」，不再提示关闭会话会停止实例。
- **空白会话的拒绝提示现在真的可见**：DSH 客户端不会把裸命令的 `error` 结果回显到输入框（它把结果渲染成会话里的流程节点），而空白会话走 hero 布局、不挂载 transcript，于是命令返回的「先发一条消息」提示没有任何显示位置。`client.js` 现在监听客户端 `command/executed`，只在会话仍是 `blank` 时用 composer 通知通道（`conversation.input.notify('error', …)`）把失败文案再显示一次；普通会话已有流程节点，不重复提示。
- **空白会话直接拒绝**：新会话还没有任何消息时 DSH 会把它标为 `blank` 并从会话列表中过滤，此时执行 `/web-gui` 会返回错误并提示「先发一条消息或切换到已有会话」，不再启动实例，避免切换会话后新会话消失、实例失去顶部任务行与停止入口。
- **防堆积加固**：每个临时 home 写入 `instance.json`（host PID、Desktop PID、端口）。插件启动时扫描 `%TEMP%/dsh-web-gui-*`：宿主或父进程已死、或属于上一轮插件生命周期的 home 会被清理；只有当记录的端口仍返回 DSH 的 401 签名时才结束对应进程（避免 PID 复用误杀）。无标记的旧版目录只清理超过 24 小时的。停止实例时在 Windows 上用 `taskkill /T` 结束整个进程树，避免终端等子进程残留。

## 0.6.0

- 隔离 Web GUI 改成**受管后台任务**：通过 `ctx.jobs.start` 注册（kind `web-gui`，label「隔离 Web GUI（dsh web）」），因此会出现在会话的「后台任务」列表里，能看到运行状态与时长，并可在列表里直接取消；取消后临时目录随进程退出自动删除。
- **删除 `/web-gui-stop` 指令**：停止统一交给「后台任务」列表，不再需要第二条指令；`/web-gui` 只负责启动/复用。
- 任务归属发起指令的 agent：该会话结束、agent 释放时任务被取消；同一 agent 再次执行复用现有实例，不同 agent 会先停掉旧实例再起新的。

## 0.5.0

- 新增配置 `shareApiKey`（默认 `false`）：打开后，`/web-gui` 拉起的隔离实例会收到本进程可用的 `DEEPSEEK_API_KEY`，从而**不需要在那个实例里重新登录就能对话**。
  - 取值顺序：先看继承的进程环境变量 `DEEPSEEK_API_KEY`，再走官方凭据服务 `ctx.credentials.resolve()`（即 `$DSH_HOME/.credentials.yaml`）；两者都没有就当作没有 key，不阻塞启动。
  - 只通过**子进程环境变量**传递，不复制 `.credentials.yaml`、不写进临时 `DSH_HOME` 的磁盘、不打印、不进错误文本；签名密钥等其它凭据一概不读。
  - 命令结果会明确回报三种状态：已共享、已开启但没找到 key、未开启共享。
  - 代价：隔离实例的每一轮都消耗同一账号配额；key 存在于子进程环境中，同机同用户进程可见。
- 新增浏览器端补丁 `client.js`：给 `web-gui` / `web-gui-stop` 在「＋」/`/` 菜单里加上中文行标题和图标（官方命令 API 没有 label/icon 字段，只能覆写客户端 `candidates()`；官方将来支持时该补丁自动退化为无操作）。

## 0.4.0

人类命令改为**另起一个完全隔离的 Web GUI Host**，不再把桌面端自己的端口交给人。

- `/gui-auth` → `/web-gui`：每次执行会 spawn 一个独立的 `dsh web` 进程，使用临时 `DSH_HOME`（`%TEMP%/dsh-web-gui-*`）与系统分配的随机端口，读到它打印的 URL 后用默认浏览器打开。不共享当前进程的 `DSH_HOME`、会话、登录态。
- `/web-gui-stop` 关闭该实例并删除临时目录；插件卸载 / Host 退出时也会清理。关闭做成**独立指令**而不是 `/web-gui stop` 参数：输入框里带参数的行会被当成普通提问发给模型，参数式子命令人根本点不到。
- 重复执行 `/web-gui` 复用正在运行的隔离实例，不会越开越多。
- 打开浏览器的方式修正：Desktop 宿主本身就是 Electron 主进程，改用 `shell.openExternal`；`dsh web`（ELECTRON_RUN_AS_NODE）等场景回退到 `rundll32 url.dll,FileProtocolHandler`，`cmd /c start` 只作最后兜底。此前从无控制台的 GUI 进程 spawn `cmd start` 会"报成功但浏览器不出现"。
- 启动器退出码纳入判定：立即以非零码退出算失败并继续尝试下一种启动方式，不再把 `spawn` 事件当成"已打开"。
- 启动失败（如 `dsh web` 未打印 URL 就退出、超时）会杀掉半启动进程、删除临时目录，并给出一条错误而非假地址。
- agent 工具 `gui_auth_url` 行为不变，仍返回当前进程这一份带 token 地址。

## 0.3.0

人也能用了：除了给模型的 `gui_auth_url` 工具，插件现在注册一条 `/gui-auth` 人类斜杠命令。

- 在 GUI 输入框输入 `/gui-auth`，命令在宿主侧取同一个带 token 地址，用系统默认浏览器打开，并把链接留在命令结果里方便复制到别的浏览器（例如拿去做自动化）。
- 命令注册是可选的：composition 里没有 `commands` 服务（无交互 UI 的 profile）时，只保留原来的 agent 工具，不报错。
- 新增配置 `openBrowser`（默认 `true`）；设为 `false` 时只回显链接、不拉起浏览器。`Config` 现在同时接受 `allowPublic` 与 `openBrowser`，其他键照旧拒绝。
- 取址、回环限制、单一 token 校验与错误文本不泄漏 URL 这些约束对人和对模型完全一致。

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
