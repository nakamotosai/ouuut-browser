`REA-REPORT.md` 已写入。全文如下：

# REA 报告 — ego lite（Citro Labs）浏览器二进制静态逆向

- 分析日期：2026-10-24（Asia/Tokyo）
- 目标版本：ego lite `0.6.0.22`；Chromium `154.0.8037.44`；Node `v24.21.0`
- 目标根目录：`<你的家目录>\AppData\Local\Citro Labs\ego lite\Application\`
- 分析方式：只读静态分析（REA CLI `rea-agents@6.5.0`、Ghidra 12.1.4、PE 结构/资源/字符串解析、证书链审计）
- 约束遵守：未启动、控制或连接任何 ego lite 浏览器实例；未执行浏览器自动化脚本、CDP 会话、截图或网络抓包；未修改/移动/删除任何目标文件，未清理任何 cookie/缓存/存储；仅新增本报告。

## 1. 结论

### 1.1 一句话总览

ego lite 是 Citro Labs 基于 Chromium 154 的私有分支。它的自动化面不是传统 `--remote-debugging-port` CDP 服务，而是 **Ego 私有 Mojo/ipcz IPC + TaskSpace/Page Node 绑定**；CDP 只作为按需逃生口存在。`chrome_elf.dll` 的 111 MB 主要是静态链接进去的 Chromium 子系统代码，而不是 Node/Python/模型或大资源。`local-ego-daemon` 是本地 agent 编排后端（默认回环 3773），不是浏览器守护进程。

### Q1（最关键）浏览器自动化通道是什么协议？

**结论：主通道是 Chromium Mojo/ipcz 私有 IPC，不是 CDP over TCP/WebSocket，也不是固定管道名的裸协议。[E2][E3][E4][E13]**

1. **CLI → 浏览器**：`ego-browser.exe` 通过 `ego.mojom.EgoCliBootstrap` / `ego.mojom.EgoCliBridge` 连接运行中的浏览器。关键字符串：`ConnectToBootstrapLoop`、`Failed to extract Mojo message pipe from invitation`、`Receive mojo reply`、`Receive mojo message`、`..\..\mojo\core\ipcz_driver\invitation.cc`。[E2][E3][E4][E5][E13]
2. **寻址**：CLI 支持 `--ego-server-name=<name>`（最长 64 个 ASCII 字母/数字/`-`/`_`/`.`，示例 `app-a`）以连接“匹配的命名浏览器服务”。全盘未发现固定的完整 Ego 管道路径常量；唯一的固定 `\\.\pipe\` 字面量是 Crashpad 的 `\\.\pipe\crashpad_%lu_`（位于 `ego.exe` 和 `chrome_elf.dll`，不在 `ego-browser.exe`/`chrome.dll`）。[E4]
3. **消息格式**：主通道是 Mojo 二进制消息（message pipe）；`Receive mojo reply` / `Receive mojo message` 提示请求/回复走 Mojo。未观察到主通道的文本 JSON-RPC schema。CDP 子通道被显式使用时才发送 JSON 字符串；错误示例中至少可观察到 `id` 与 `method` 两个键（其中 `method` 的值为 `Runtime.enable`），其他 CDP 字段未由该字符串证明。
4. **CDP 是可选子通道**：Node 绑定暴露 `page.cdp(method, params, options)` 和 `ego.sendCDPMessage(...)`；错误码 `EGO_CDP_CHANNEL_UNAVAILABLE`、`EGO_CDP_SEND_FAILED`，以及 "Task space is not assigned to an agent. Claim this task space before sending CDP messages." 说明 CDP 挂在 TaskSpace 上，需显式使用。[E13][E14]
5. **是否使用 `Runtime.enable`**：静态证据**不支持“普通 Ego SDK 自动化会发送 Runtime.enable”**。
   - `chrome.dll` 共 6 处 `Runtime.enable`：5 处是 DevTools frontend / Node inspector 内部（`Page.enable`、`Runtime.addBinding` 列表；`NodeRuntime.enable`；`callCdp('Runtime.enable')`；`Runtime.enable()`；`session.post('Runtime.enable')`）；1 处是 `ego.sendCDPMessage` 的错误示例。
   - `chrome_elf.dll` 1 处，为 DevTools frontend 绑定列表。
   - `ego-browser.exe`、`ego.exe` 均为 0 处。
   - 结论：常规 TaskSpace/Page API 走 Ego 原生绑定，不依赖 `Runtime.enable`；只有显式调用 `page.cdp()`/`sendCDPMessage()` 才可能发送任意 CDP 方法。静态分析不能证明运行期绝不构造该字符串，但未发现 Ego 专用代码自动发送它。[E14]
6. **JSON 字段名（快照/绑定）**：`includeActionMarks`, `interactiveOnly`, `includeStableLocator`, `maxResultLength`；`scope` 取值 `only_within_viewport` / `full_page` / `subtree`；结果含 `root`, `frameId`, `refs`, `loc`, `interactive`。TaskSpace/标签字段：`spaceId`, `name`, `ownership`, `tabId`/`targetId`, `openedBy`。[E13][E22]
7. **Node 绑定方法**：`createTab`, `listTabs`, `listTaskSpaces`, `deleteSpaces`, `listProfiles`, `createTaskSpace`, `claimTaskSpace`, `closeTaskSpace`, `useTaskSpace`, `animationHighlightMouseToPosition`, `handOffTaskSpace`, `takeOverTaskSpace`, `completeTaskSpace`, `markTaskSpaceError`, `setAgentTaskState`, `getBrowserVersion`, `sendCDPMessage`, `onSendCDPMessageError`。实现文件：`..\..\ego\components\node\node_bindings_impl.cc`；runtime：`..\..\ego\services\node\node_runtime_impl.cc`；内置 preload：`ego://services/node/resources/index.js`。[E13]
8. **Mojo 接口家族**：`chrome.dll` 还包含 `ego.mojom.NodeCdpChannel`、`ego.mojom.NodeCdpChannelClient`、`ego.mojom.NodeRuntime`、`ego.mojom.NodeClient`、`ego.mojom.NodeServiceHost` 等接口名；这与“Node SDK 在浏览器内通过 Mojo 接口桥接 CDP/Node runtime”一致。接口名不等于已验证的方法表，具体消息 schema 仍是未知项。[E13]

**小结**：Ego 自动化默认不是“起一个 CDP WebSocket 然后 Playwright 连接”的模型；它更像“CLI 通过 Mojo 控制浏览器内的 TaskSpace/Page 对象”。SDK 文档也明确说 "Ego-browser deliberately exposes a small custom API. It is not Playwright"，并提示不要猜测 Playwright 方法。[E22]

### Q2 Chromium 基底版本与定制程度

**结论：是私有 Chromium fork，基底 Chromium 154.0.8037.44；Node v24.21.0 静态链接在 chrome.dll 内。[E11][E20]**

- 版本字符串：`chrome.dll` 中 `154.0.8037.44` 出现 3 次、`Chrome/154.0.8037.44` 1 次；`chrome_elf.dll` 也有 `Chrome/154.0.8037.44`；`ego-browser.exe` 帮助头含 `0.6.0.22` / `154.0.8037.44` / `v24.21.0`。[E20]
- 定制证据：`chrome.dll` 中 `..\..\ego\` 路径字符串 2,312 次、306 个唯一路径；`chrome_elf.dll` 0 个；`ego-browser.exe` 3 个 Ego CLI 路径（`ego_cli_launcher_win.cc`, `ego_cli_main.cc`, `nodejs_repl_session.cc`）。定制目录涵盖 `ego/components/ego_cli`、`ego/components/node`、`ego/browser/chat_service`、`ego/browser/metrics`、`ego/browser/cli`、`ego/browser/data_import`、`ego/browser/ui/...`、`ego/services/node`、`ego/browser/net` 等。[E11]
- Node 链接位置：`chrome.dll` 753 个导出中 227 个 `@node@@`、145 个 `napi_*`、34 个 `llhttp_*`、124 个 `@v8@@`；`chrome_elf.dll` 只有 29 个 crashpad/chrome_elf 导出，无 Node。[E20]
- 内嵌 Node gypi JSON（偏移 294,627,201）：`node_module_version: 137`, `node_shared: false`, `node_shared_openssl: false`, `napi_build_version: "10"`, `is_debug: 0`, `enable_lto: true`, `v8_enable_sandbox: 1`, `node_use_node_snapshot: false`。**这些是 Node 自身嵌入构建值，不是 Ego 的 GN 参数**；完整 Ego 构建标志静态不可恢复。[E11]
- 构建/运行时开关：未发现可恢复的 Ego GN args 或构建配置文件；`chrome.dll` 只含 Chromium 标准 features/switch 字符串表与 Ego 新增运行时开关（如 `enable-ego-uma-metrics`、`startup-ego-browser-service`、`ego-server-name`、`ego-data-import-helper`）。[E11][E18][E20]
- 版本资源：`ego.exe` = `ego (lite)` / Citro Labs Pte. Limited / 0.6.0.22；`chrome.dll`、`chrome_elf.dll`、`chrome_proxy.exe` = `ego` / 同公司 / 0.6.0.22；`ego-browser.exe` 无版本资源。[E19]
- 目录布局：`.pak`, `icudtl.dat`, `v8_context_snapshot.bin`, `ffmpeg.dll`, `dxcompiler`, `vk_swiftshader`, `Locales`, `Installer/setup.exe`, `elevation_service.exe`, `chrome_pwa_launcher.exe` 等，符合 Chrome 系发行版结构。[E11]

### Q3 是否编译进反检测/指纹伪装能力？

**结论：未发现编译进 Ego 专用的反检测/指纹伪装层（仅代表没有静态证据，不等于绝对不存在）。[E15]**

- 术语矩阵（区分大小写字节计数）：
  - `chrome.dll`：`fingerprint` 164、`Fingerprint` 28、`spoof` 5、`Spoof` 4、`AutomationControlled` 1、`--enable-automation` 1、`disable-blink-features` 1。
  - `chrome_elf.dll`：`fingerprint` 113、`Fingerprint` 1、`Spoof` 4。
- `ego-browser.exe` / `ego.exe`：`canvas` 5/4、`webgl` 2/2、`WebGL` 1/1、`webrtc` 2/2、`TimeZone` 1/1（均为通用运行时/绑定字符串，不是指纹开关）；`fingerprint`/`spoof`/`stealth`/`navigator.webdriver`/`useAutomationExtension`/`excludeSwitches`/`--headless`/`HeadlessChrome`/`--user-agent`/`--timezone`/`--lang=` 全部为 0；`--fingerprint` / `--fingerprint-` 在四个模块中均为 0。[E15]
- 关键上下文：
  - `AutomationControlled` @299,961,492 是通用 Chromium feature-name 列表中的一项（`AutofillPreviewIgnoreAuthorFont` 与 `AvoidEmbeddedContentViewLocation` 之间）。
  - `--enable-automation` @278,106,378 是通用错误文案 "Command line not returned because --enable-automation not set"。
  - `disable-blink-features` @276,348,520 是通用命令行开关列表项。
  - `webdriver` @308,583,560 是 Blink WebIDL 属性列表。
- `fingerprint` 命中分类：106 处 XNNPACK `xnn_fingerprint_id_*`；44 处其他 Chromium/Perfetto/SQLite/证书/WebRTC 上下文；11 处 TLS/证书；2 处 Android Perfetto；1 处 QUIC；无 Ego 专用 fingerprint 开关、JS override 或 profile 伪装代码。[E15]
- `canvas`/`webgl`/`webrtc`/`timezone`/`userAgent` 等词的大量命中属 Blink/WebRTC/媒体/国际化正常实现，不能作为反检测证据。未发现 `--fingerprint-*` 类开关。

### Q4 chrome_elf.dll 为什么有 111 MB？

**结论：主要约为 96.5 MB 的静态链接 Chromium 子系统代码；不是 Node/Python/模型权重/大资源。精确构建原因未知。[E7][E12][E21]**

- 节表：`.text` VA 0x1000，VSize 96,482,645 / Raw 96,482,816；`.rdata` 10,932,604；`.data` 1,195,844；`.pdata` 2,703,936；`.rsrc` 仅 60,840；`.reloc` 378,680。[E12]
- 仅 29 个导出；导入 `KERNEL32.dll(328)`, `VERSION.dll(3)`, `ntdll.dll(12)`。[E12][E20]
- 资源：46 项（23 图标、21 光标、1 manifest、1 version），总负载 58,334 字节，无法解释体积。[E7][E12]
- 无 `node::`/`@node@@`/`napi_`/`libuv`/`Py_Initialize`/`libpython`/`.pyd`/`site-packages`/`gguf`/`safetensors`；`tensorflow` 7、`onnx` 5、`llama` 2 是 Chromium/TFLite/词典等附带字符串，`onnxruntime` 0。[E12]
- 模块/路径分布：`third_party` 848、`content` 450、`net` 294、`services` 172、`components` 140、`base` 79、`ui` 75、`gpu` 73、`device` 70、`media` 52、`v8` 47、`storage` 43、`mojo` 30、`cc` 28；**0 个 Ego 路径**。[E11]
- `.text` 8 MiB 分块熵 6.394–6.665 bits/byte，零字节 8.88%–12.14%，符合 x86 代码；全文件 `MZ` 159 处但只有 1 个有效 PE 头（偏移 0），`PE\0\0` 389 处、ZIP 2/GZIP 1/RAR 1 均为 MIME/类型表字符串，无 ELF/7Z/XZ/BZIP2。[E12]
- `LZMADEC` 节 4,593 字节，起始为 x86 代码、熵约 6.05，不是压缩载荷。[E12]
- Ghidra 全量函数级分析 30 分钟后 `provider_timeout`（`operation: list_documents`，target SHA `4f913...`），更早一次 330,000 ms 也超时；因此无法从函数级/构建文件层面闭环解释为什么链接进 96 MB 代码。[E21]

### Q5 `local-ego-daemon` 是什么？

**结论：`local-ego-daemon` 是一个 Node.js ESM 的本地 agent 编排/聊天后端（chat service daemon），不是浏览器进程守护器；它由浏览器内的 `ChatServiceManager` 选择、安装、启动并按失败重启。[E16]**

- 规模与组成：556 个文件、28,987,019 字节。`client` 524 文件 / 17,705,358 字节（`index.html`、`favicon.ico` + 516 个 `assets` + 6 个 `assets/chatbot/omnibox`）；`runtime` 23 文件 / 10,720,477 字节；`db-migrations` 6 文件 / 561,000 字节；根目录 3 个入口脚本：`index.mjs`（50 B）、`restoreMigrationBackup.mjs`（67 B）、`runtimeDependencySmoke.mjs`（67 B）。[E16]
- 入口链：`index.mjs` → `import "./runtime/index.mjs"` → `initializeDiagnostics()`（Sentry）→ `await import("./run-DRqUaiQQ.mjs")`。`runtime/run-DRqUaiQQ.mjs` 为 5,242,104 字节，SHA-256 `36788299AF54DD3CB585649740A7DFED05A3D7A2D6968E7008CF44EE54173DA6`。[E16]
- 监听与访问策略：`const DEFAULT_PORT = 3773`（偏移约 468,229）；默认 URL `http://127.0.0.1:3773`。`localAccessPolicyError()` 与 `isLoopbackHost()` 仅允许 `localhost` / `127.0.0.1` / `::1`；非回环绑定报 `Refusing to bind Ego to non-loopback host ...; remote access has been removed.`；只要存在 `EGO_AUTH_TOKEN`、`EGO_PUBLIC_URL`、`EGO_ALLOW_INSECURE_REMOTE` 之一即启动失败：`<VAR> is no longer supported; Ego only accepts loopback connections.`。`findAvailablePort(preferred)` 在首选端口不可用时回退 `tryReservePort(0)`（系统分配）。[E16]
- 管道/监听：未发现 `local-ego-daemon` 专用命名管道常量；其服务面是 loopback HTTP/WS（默认 3773，首选被占用时回退系统分配端口），另有 external MCP stdio 子进程通道。[E16]
- CLI：支持 `--port`、`--host`、`--dev-url`、`--no-browser`、`--home-dir`、`--no-color` 等；`noBrowser` 默认 `true`（`resolveBooleanConfig(input.noBrowser, env.noBrowser, true)`，即默认不自动打开浏览器窗口）。[E16]
- API 面：38 个路由字面量，包括 `/health`、`/ws`、`/mcp`、`/mcp/external`、`/api/files/upload`、`/api/attachments/upload`、`/api/attachments/cancel`、`/api/voice/transcribe`、`/api/preview`、`/api/provider-settings`、`/api/local-image`、`/api/editor-icon`、`/api/mcp/external/integrations`、`/api/mcp/external/pair`、`/api/mcp/external/runtime-challenge`、`/api/auth/`、`/api/session/...`、`/api/thread-export`、`/api/model`、`/api/provider`。健康检查 `/health` 期望 `status`、`startupReady`、`projection.state`，3 秒超时。[E16]
- MCP：内置外部 MCP stdio 桥，命令形态为 `mcp serve --integration <id> --home-dir <dir>` 与 `mcp pair --code <code> --home-dir <dir>`。[E16]
- 数据库：6 个迁移文件（`20260909080107_current_schema`、`20260909080117_bootstrap`、`20260920074202_drop_worktree_columns` 等）；schema 约 48 张表，关键表包括 `agent_gateway_operations`、`auth_pairing_links`、`auth_sessions`、`automation_*`、`checkpoint_diff_blobs`、`external_mcp_*`、`git_handoff_operations`、`managed_attachment_blobs`、`orchestration_events`、`projection_*`、`profile_stats_*`，说明它承担会话/线程、任务编排、外部 MCP 集成、附件与数据迁移等后端职责。[E16]
- 浏览器侧集成：`chrome.dll` 的 `..\..\ego\browser\chat_service\chat_service_manager.cc` 含 `local-ego-daemon`、`SelectDaemon`、`LaunchEntryScript`、`Could not install the local-ego-daemon...`、`The bundled local-ego-daemon is unavailable.`、`Starting chat service with ...`、`Chat service process started (pid ...)`、`ScheduleRecovery`、`Restarting chat service in ...`、`ego.mojom.ChatServiceClient`、`kEgoInternalChatServiceStatus`、`kEgoChatServiceBundledDaemon`。由此确认它由浏览器管理并按失败重启，设计上是长驻进程；但静态证据不能证明它在整个浏览器生命周期内始终常驻（可能按需启动/停止）。[E16][E20]
- 端口注意：daemon 独立默认端口为 3773；但 `chrome.dll` 中 `--host`、`--port`、`3999` 相邻出现，client bundle 也含 `http://127.0.0.1:3999` 回退串。静态证据无法确定 3999 是启动参数、回退还是另一端点，需运行期验证。[E16][E20]
- 外联：`runtime/sentry-CDLeU9NO.mjs` 硬编码 Sentry DSN（host `o4511212523159552.ingest.us.sentry.io`，project `4512249158369280`，client key 已脱敏）；环境变量可覆盖 `EGO_SENTRY_DSN`、`EGO_SENTRY_ENABLED`、`EGO_SENTRY_ENVIRONMENT`。Langfuse 通过 `EGO_LANGFUSE_*` 配置，OTLP HTTP 路径 `${baseUrl}/api/public/otel/v1/traces`，使用 Basic auth。[E16][E18]

### Q6 `ego-skills` 目录里是什么？

**结论：一套随浏览器分发的 agent Skill 定义包（ego-browser skill v2.1.0），共 22 个文件 / 42,641 字节，格式为 Markdown + YAML + JSON + JavaScript + PNG + Shell。[E17]**

- `ego-browser/SKILL.md`（1,594 B）frontmatter：`name: ego-browser`、`description: ...`、`metadata.version: "2.1.0"`、`metadata.date: "2026-10-08"`、`metadata.bootstrap: true`。
- `ego-browser/agents/openai.yaml`（271 B）：`interface.display_name: ego-browser`、`short_description: Automate logged-in web tasks`、`icon_small: ./assets/composer-icon.png`、`icon_large: ./assets/logo.png`、`brand_color: "#1E90FF"`、`default_prompt: "Use $ego-browser to complete a browser automation task."`。
- 资源：`assets/composer-icon.png` 3,967 B、`assets/logo.png` 8,612 B。
- 参考与脚本：`references/install.md` 4,479 B、`references/clearing-state.md` 4,140 B；`scripts/install.sh` 6,021 B。
- `learnings/` 内置 3 个站点经验包：`github`（manifest.json、notes/overview.md、tools/open-issues.js、tools/search-repos.js、browser-tools/repo-stats.js）；`google`（manifest.json、notes/overview.md、tools/search-extract.js、browser-tools/autocomplete.js）；`x-com`（manifest.json、notes/overview.md、notes/timeline.md、tools/search-users.js、tools/timeline.js、browser-tools/extract-post.js）。
- 文件类型：Markdown、YAML、JSON、JavaScript、PNG、Shell；没有二进制 skill 运行时、模型权重或原生扩展。

### Q7 网络端点、遥测与更新

**结论：Citro 自有域名集中在 `citrolabs.ai` / `ego.app` 及其子域；自动更新走 `update.citrolabs.ai`；存在专用的 `update_telemetry.json` 上报实现；未发现专门的“许可校验服务器”。[E18]**

Browser（`chrome.dll`）：
- `https://lite.ego.app`、`https://lite.ego.app/privacy`
- `https://app.citrolabs.ai/chatbot`
- `https://eventflow.citrolabs.ai/metrics`
- `https://cdn.citrolabs.ai/app-bundle/`
- `https://sync.citrolabs.ai/ego-sync`、`https://test-sync.citrolabs.ai/ego-sync`
- `https://variations.ego.app/seed`、`http://variations.ego.app/seed`

Updater：
- `https://update.citrolabs.ai/service/update2`
- Sentry minidump：host `o4511212523159552.ingest.us.sentry.io`，project `4511212845727744`（`sentry_key` 已脱敏）。

Daemon/client：
- `api.citrolabs.ai`、`files.citrolabs.ai`（client bundle 中为 `http://files.citrolabs.ai/`）、`speech.citrolabs.ai`。
- Langfuse 可配置，OTLP 路径 `/api/public/otel/v1/traces`。
- Sentry（daemon）：host `o4511212523159552.ingest.us.sentry.io`，project `4512249158369280`（client key 已脱敏）。[E16][E18]
- IP 常量：未发现 Citro 自有硬编码 IP；daemon/client 中出现的 `1.1.1.1` 属通用连通性探测，`localhost` / `127.0.0.1` 为回环地址。[E16][E18]

**`update_telemetry.json` 对应代码：**
- 代码路径字符串 `..\..\ego\browser\metrics\ego_update_telemetry.cc`；函数符号 `MarkUpdateTelemetryReportPending`、`UpdateTelemetryAndMaybeReport`、`PostTelemetryFileUpdate`、`ReportUpdateTelemetryIfPending`。
- 字段/常量：`update_telemetry.json`、`com.citrolabs.ego.lite`、`ct1_`、`.update_identity.json`、`uuid`、`lite_version`、`_report_pending`、`onboarding_imported_browser_data`、`browser_used_by_human`、`browser_used_by_agent`、`onboarding_imported_result`、`device_timezone`、`device_region_country`、`is_default_browser`。
- 实际文件：`<你的家目录>\AppData\Local\Citro Labs\ego lite\update_telemetry.json`。观察到的快照：初次 189 B / SHA-256 `BCF8E195B8855332CA14091454B179CCA767974DEC171D94B94A50CE642215B6`；稍后再次读取为 194 B / SHA-256 `507ABF3717D7C5FFD8133D79295F39BD828546944EA1A6024523C05F836E570A`（该文件是运行时可写状态，大小/哈希随时间变化）；键仅为 `device_region_country`、`device_timezone`、`lite_version`、`t`、`uuid`，值不在本报告披露。[E18]
- UMA 上传：`X-Chrome-UMA-ReportingInfo`、`X-Ego-Device-Id`、`X-Ego-User-Id` 请求头；开关 `enable-ego-uma-metrics`；指标前缀 `Ego.`。
- 许可：未发现 Citro 许可校验端点。`chrome.dll` 中 `license` / `License` / `activation` / `entitlement` / `subscription` / `billing` / `checkout` 等词大多来自 Chromium 通用代码以及 daemon 的计费/订阅 UI 文案，没有独立的 license server URL。Chromium 继承的 `clients2.google.com`、`update.googleapis.com`、`tools.google.com/service/update2` 等属于组件/Google 更新基础设施，不是 Citro 遥测。[E18]

### Q8 代码签名

**结论：12 个审计 PE 全部为 `Get-AuthenticodeSignature` 状态 `Valid`；签名主体为 `CITRO LABS PTE. LIMITED`（新加坡），证书由 `Certum Code Signing 2021 CA` 签发；是 OV 代码签名证书，不是 EV。[E19]**

- 主体：`CN=CITRO LABS PTE. LIMITED, O=CITRO LABS PTE. LIMITED, L=Singapore, C=SG`
- 签发者：`CN=Certum Code Signing 2021 CA, O=Asseco Data Systems S.A., C=PL`
- Thumbprint：`8F9B17D0E9E11625AB04A36F9E10429C72436B25`
- Serial：`7388566A86D5EE3B4D1FA0BCC0E5CBF6`
- 有效期：2026-09-15 21:51:35 +09:00 → 2027-09-15 21:51:34 +09:00
- 时间戳：`CN=Certum Timestamp 2026, O=Asseco Data Systems S.A., C=PL`
- 证书链：leaf → `Certum Code Signing 2021 CA`（`8D57E2B4008BBE461470A69F3492BC5AE362A7A9`）→ `Certum Trusted Network CA 2` 自签根（`D3DD483E2BBF4C05E8AF10F5FA7626CFD3DC3092`）
- `X509Chain.Build` 成功（`RevocationMode=NoCheck`）；叶子证书含策略 OID `2.23.140.1.4.1`、`1.2.616.1.113527.2.5.1.4`，EKU 为代码签名（`1.3.6.1.5.5.7.3.3`）。
- 未见 EV 代码签名策略 OID（EV 通常使用 CA/Browser Forum EV Code Signing OID `2.23.140.1.3`），因此判定为 OV 代码签名。
- 审计的 12 个 PE：`ego.exe`、`chrome_proxy.exe`、`ego-browser.exe`、`chrome.dll`、`chrome_elf.dll`、`elevation_service.exe`、`elevated_tracing_service.exe`、`notification_helper.exe`、`chrome_pwa_launcher.exe`、`Installer/setup.exe`、`EgoUpdater/0.6.0.16/updater.exe`、`Update/Citro LabsUpdate.exe`。[E19]

### Q9 原生集成接口

**结论：未发现可供第三方原生集成的 Ego 专用 C ABI、COM 接口或固定 IPC 端点；对外集成面主要是 `ego-browser` CLI（经 Mojo 连接运行中的浏览器）、daemon 回环 HTTP/WS API 与 daemon 的 external MCP stdio 桥。[E20][E22]**

- `chrome_elf.dll`：29 个导出，全部为 crashpad/chrome_elf 系列加 `sqlite3_dbdata_init`，无 Ego SDK。[E20]
- `chrome.dll`：753 个导出；227 个 `@node@@`、145 个 `napi_*`、34 个 `llhttp_*`、124 个 `@v8@@`，属于静态链接 Node.js 的附带符号，不是文档化的 Ego 原生 SDK。[E20]
- `chrome.dll` 从 `chrome_elf.dll` 导入 16 个 crashpad 函数：`ClearReportsBetween_ExportThunk`、`CrashForException_ExportThunk`、`DumpHungProcessWithPtype_ExportThunk`、`DumpProcessWithoutCrash`、`GetCrashReports_ExportThunk`、`GetCrashpadDatabasePath_ExportThunk`、`GetInstallDetailsPayload`、`GetProductInfo_ExportThunk`、`GetUploadConsent_ExportThunk`、`GetUserDataDirectoryThunk`、`InjectDumpForHungInput_ExportThunk`、`IsExtensionPointDisableSet`、`IsTemporaryUserDataDirectoryCreatedForHeadless`、`IsThirdPartyInitialized`、`RequestSingleCrashUpload_ExportThunk`、`SetUploadConsent_ExportThunk`。[E20]
- `ego.exe` 从 `chrome_elf.dll` 导入 5 个：`GetInstallDetailsPayload`、`IsBrowserProcess`、`IsExtensionPointDisableSet`、`SignalChromeElf`、`SignalInitializeCrashReporting`。[E20]
- `ego-browser.exe` 仅导出 `GetHandleVerifier`；仅导入 `KERNEL32`（178 个）、`ntdll`（2 个）、`WINMM`（3 个）。[E20]
- Ego Mojo 接口为内部接口，经 invitation 绑定；未发现固定 Ego 命名管道常量（全盘唯一 `\\.\pipe\` 字面量是 Crashpad 的 `\\.\pipe\crashpad_%lu_`）。[E20]
- `CoCreateInstance` 上下文均属 Chromium：MMDeviceEnumerator 音频、updater/IPC、GoogleUpdate3Web、tracing service、通用 COM 导入表；无 Ego 自有 COM CLSID。[E20]
- 因此没有第三方原生集成 SDK；可行的外部集成是 CLI + daemon HTTP/WS + MCP stdio。[E20][E22]

## 2. 证据

### 2.1 证据使用说明

本次结论只使用只读静态证据：未启动、控制或连接任何 ego lite 浏览器实例，未执行浏览器自动化脚本、CDP 会话、截图或网络抓包，未修改/移动/删除任何目标文件，未清理任何 cookie/缓存/存储。**未使用任何运行时探针产物**（例如 `%TEMP%\ego-runtime-probe-output.txt`、`%TEMP%\ego-nodeservice.txt`、任何截图或 UI 自动化输出）；本报告不引用这些文件的内容。E22 中的 CLI help/Skill 文本仅按随包帮助文档处理，用于核对 API 名称与错误语义，不作为运行期行为证据。下文 `%TEMP%` 均指 `<你的家目录>\AppData\Local\Temp`。所有 digest 均为 SHA-256。

REA 证据 id 均出现在任务日志 `F:\projects\blackhole-browser\re\ego-lite\.rea-job-20261024-084002\stdout.log` 中；可用该日志复核 operation、parameters 与 normalized_result。

### 2.2 E1：目标清单与基线哈希

| 文件 | 大小（字节） | SHA-256 |
|---|---:|---|
| `...\Application\ego.exe` | 4,341,064 | `F57D702F5345792259881358F2838A313E981306DBC9790E8A4C4C1CA039D06D` |
| `...\Application\0.6.0.22\ego-browser.exe` | 3,688,264 | `06333AF0B5CD0CC40ADA847C0C612D9690EAE94BEC010AB1CC61A8027721A73F` |
| `...\Application\0.6.0.22\chrome_elf.dll` | 111,322,440 | `4F9138FA75B1B0A6B80F172B1DE80BB4B2E8E8694610F5E0BD36CEC28AACFC06` |
| `...\Application\0.6.0.22\chrome.dll` | 323,439,944 | `2B05F316636D69C025FDC45D51BA64AE7A9CF7527A201FE4AB733F6FA7C7ABFA` |
| `...\Application\chrome_proxy.exe` | 2,570,568 | `84A877075934F46EABC67B42202D09A1A9E35A9C5A3854C4A81B9E160980B1C1` |

产物：`%TEMP%\ego-target-scan-20261024.json`（111,242 B，SHA-256 `6E5C36157E000BCA5B3ACAC129D620E35CC2F9664AEE91EBE569EC3D4410391B`）。

### 2.3 E2–E10、E21：REA Evidence 明细

| 标签 | REA Evidence id | 工具 / operation | 参数与结果 |
|---|---|---|---|
| E2 | `ev_29cbccb9c9a216c60693cb8f4bdea858cc096230b12950734f491d465a9c6ed3` | `binary_overview`（Ghidra 12.1.4）on `ego-browser.exe` | 参数 `{}`；x86_64 PE，9,363 procedures，2,971 strings，PDB 名 `ego-browser.exe.pdb` |
| E3 | `ev_ac93efea596bc1d6e02a2c42a16518a83716cd2c083e06713706436b155f76a5` | `search_strings`（Ghidra 12.1.4）on `ego-browser.exe` | `pattern="Runtime\\.enable|Page\\.navigate|Target\\.createTarget|webSocketDebuggerUrl|remote-debugging|DevTools|CDP|\\\\\\\\.\\\\pipe|named pipe|WebSocket|Runtime\\.evaluate|Page\\.captureScreenshot|Browser\\.getVersion"`, `mode=regex`, `case_sensitive=false`；36 matches |
| E4 | `ev_f6cafc88ff1df0e5edbb96ee1e7971257d80a3026d9acae25ccf7f300b5bade4` | `search_strings`（Ghidra 12.1.4）on `ego-browser.exe` | 全量字符串清单（2,971 条），导出为 `ego-browser-strings.json` / `ego-browser-strings.tsv` |
| E5 | `ev_321b5cc471bdb54d54b03c8d52dd2d6bfb3de2d4f0a36165deb02a0190a33537` | `xrefs` on `ego-browser.exe` | `address=0x14030a7e8` → 引用 `0x140022125`、`0x14002212c`（`ConnectToBootstrapLoop` 邻域） |
| E6 | `ev_0d9928954fb5acdadfb72efeb34f0796937ae0b9af361ae41303f5663aef75a3` | `inspect_pe_resources` on `ego-browser.exe` | 0 resources（无图标/版本/清单资源） |
| E7 | `ev_57d3f2aa10faf58578e77d3cd0ae6ed39cef559e053d2accaac890c9452dd253` | `inspect_pe_resources` on `chrome_elf.dll` | 96 entries / 46 resources（23 icon、21 cursor、1 manifest、1 version）；资源负载合计 58,334 B |
| E8 | `ev_70e1eae35ecd0deeb511562393f372a967d41dde4ec23f39c0399ae226aff290` | `inspect_pe_resources` on `chrome.dll` | 资源/版本/清单盘点；产物 `chrome-dll-resources.json` |
| E9 | `ev_8c1d332c782bc969134d6315e4ebddad344a5f8c013145001d9ca8cd5a88cb19` | `inspect_pe_resources` on `ego.exe` | 资源/版本/清单盘点；产物 `ego-exe-resources.json` |
| E10 | `ev_968a4bd7615345279fa08905f84f49136a08755c198069ca3820b10d68ebb44b` | `search_bytes` on `ego.exe` | pattern 十六进制 `6c6f63616c2d65676f2d6461656d6f6e`（`local-ego-daemon`），`limit=100`；0 matches（全段搜索） |
| E21 | 无（失败记录，见产物） | Ghidra `list_documents` 全量分析 | `provider_timeout`，`timeout_ms=1800000`，target SHA `4f9138fa75b1b0a6b80f172b1de80bb4b2e8e8694610f5e0bd36cec28aacfc06`；更早一次 330,000 ms 同样超时；产物 `chrome-elf-analyze2.json` / `chrome-elf-analyze.json` |

### 2.4 E11–E22：静态产物与 digest

| 标签 | 产物（`%TEMP%\...`） | 大小（B） | SHA-256 | 用途 |
|---|---|---:|---|---|
| E1 | `ego-target-scan-20261024.json` | 111,242 | `6E5C36157E000BCA5B3ACAC129D620E35CC2F9664AEE91EBE569EC3D4410391B` | 目标清单/大小/哈希 |
| E4 | `ego-browser-strings.json` | 466,382 | `1CC953554B495701B60F02421C15A8D43DD3B38D7BF6DF3B076873C1EA5AF99D` | ego-browser.exe 全量字符串（JSON） |
| E4 | `ego-browser-strings.tsv` | 164,641 | `37EC73D9AA6C4A0469C97AE9DA37EF9E608205D5794CA22449CF222086310778` | 同上（TSV，便于检索） |
| E11 | `pe-info.json` | 94,991 | `358CE79853CA0D925633A11E8555F730B3ED2DDE81BCB233EAA347C8D36BF67F` | PE 头/节表/导入导出/版本基线 |
| E11 | `ego-q2-q4-module-stats.txt` | 8,654 | `0C89E3F6A2EC8E303F427755BD68DEBE9490C790F08A4CA5A8D87341D47A827E` | 模块/路径分布、字符串统计 |
| E11 | `ego-node-config-gypi.txt` | 4,109 | `846D9367AEBA2B9760BA9B979AC790CE3AFC05743D2C578FCA832E26A1B01971` | Node 内嵌 gypi 值 |
| E12 | `ego-chrome-elf-deepscan.txt` | 2,428 | `6D5ABEFE5DD72F7EFE5A573F1F3BB7549650D08048B66F11217F51E69BE6FEBD` | chrome_elf.dll 节表/熵/魔数/运行时指标 |
| E12 | `ego-resources-imports.txt` | 737 | `001EAA26FBDA2B48D9BBFC4AE3A74C1F7E223A5ED17EE4E2E88D6154AFD7DC51` | chrome_elf/chrome.dll 导入与资源汇总 |
| E13 | `ego-mojo-evidence.txt` | 11,718 | `C022A6C953BE71B50A73702A5B64C283A1DA07B82D862522617215A4948F8882` | ego.mojom 接口/绑定证据 |
| E13 | `ego-node-bindings-strings.txt` | 39,682 | `6FF423FAF44FDC612BD72C664C496B0A3E297388D957ADA318AE41EBE34E29B5` | Node 绑定方法/错误码 |
| E13 | `ego-bridge-region-strings.txt` | 194,580 | `BB222EAD86BEBC4674569CD1DD29966BE360BBAE6A68D03948B9C0E9F6A27CBA` | Ego CLI 桥接区域字符串 |
| E14 | `ego-runtime-enable-cdp-scan.txt` | 11,479 | `8D759CCD2804091380D2485351ED2C5A6581EF052EE6ADAF23C44B057986D1C1` | Runtime.enable/CDP 上下文逐条计数 |
| E15 | `ego-q3-term-matrix.txt` | 3,238 | `5B4D3489B26D3CDA191C4E2D96F6D77E8560D39A5E7E1F598ACFF98201959016` | 反检测术语矩阵 |
| E15 | `ego-antidetect-sweep.txt` | 4,799 | `C1B1CC9566D18CEB4E77111CAE1D88A870FE238DABB9C579F87A1C9F071EE34E` | 反检测全量扫描结果 |
| E15 | `ego-fingerprint-classify.txt` | 9,126 | `EAEE5A8D51BD8FFEDC92E34665124C0F05AEF8C383032E1B6F6F99E802A2EE61` | fingerprint 命中分类 |
| E16 | `ego-daemon-manifest.txt` | 60,745 | `5ABBBAA3C8E721A93F6AE428AAEF717DD8CE9494B6ADDCAB4D00A1C199997687` | daemon 556 文件清单（含每文件哈希） |
| E16 | `ego-daemon-summary.txt` | 16,362 | `F28F3F1373307A6AFA204C43A32A290421EC422A7F356B1A5C9ACE5A80D94725` | daemon 文件/环境变量/URL 汇总 |
| E16 | `ego-daemon-routes-cli.txt` | 6,740 | `3571EE977416A89ED97563819B056CC5D9C7392DF76EE4586BDD6A549BFE5E08` | DEFAULT_PORT/路由/CLI 字面量 |
| E16 | `ego-daemon-cli-search.txt` | 2,522 | `3E0D3F04CBA57DD3C2FDE474756CF03EDFA1E59D81821FD3C45D0CCA9475A496` | daemon CLI 细节检索 |
| E16 | `ego-daemon-schema.txt` | 2,565 | `7251B2603634CC0E2A86347F28BCD10996360F6C03946A4425E1814BA9C32DA8` | DB 迁移/schema 表清单 |
| E16 | `ego-loopback-policy.txt` | 9,299 | `845FF2D6C81BB8EAEC788D9E214B57FBDE245A277A3F29933AED4C2B0D500F74` | 回环访问策略/拒绝消息 |
| E16 | `ego-daemon-net-env-report.txt` | 12,506 | `3630F7F476FAF1703903AD96CC702054E4BBC939BFAC0529A9F46999E13A5BD6` | daemon 网络/环境变量逐文件报告 |
| E16 | `ego-agent-host.txt` | 6,223 | `0596E23BDDF01DD474195205DFCB8598942ABE0F08CBAC63667CFBC084135538` | CDP agent host/TaskSpace 错误语义 |
| E17 | `ego-skills-manifest.txt` | 2,634 | `0C0CCE14521E0C2B2D40D517B6AD16871C8451BF550EC3141D4C7BF3798A328A` | ego-skills 22 文件清单 |
| E18 | `ego-update-endpoints-final.txt` | 2,745 | `8C9C77957DE62FEFFE2ABB94A92111E06D9808A1330E1F59C094662903C03F04` | 更新/浏览器 URL 端点 |
| E18 | `ego-chrome-dll-telemetry-context.txt` | 8,928 | `2558FF17278E5D437C77BA89D98CDBF39711B6A4EF0F61AE776F6171781E4D53` | update_telemetry/UMA 上下文 |
| E18 | `ego-license-domain-scan.txt` | 1,886 | `C6E3D4E7027122DFBA35780AFDBF79ED30CA6D7F7F7EA2318CCAD2E9D5CF7900` | 许可/计费词与域名扫描（含已脱敏 DSN 上下文） |
| E19 | `ego-signature-audit.json` | 7,708 | `29CEBB239F2D662F30938BE6633DC5950FE1460448C525FE11861309FDDAB0A9` | 12 PE Authenticode 审计 |
| E19 | `ego-cert-and-version.txt` | 3,377 | `FB385343B6FEEB69EF0E1BFDC5334064ADA3F4A98CFE3DC08ACF4DDEA7113FB9` | 证书链/策略 OID/版本资源 |
| E20 | `ego-exports-summary.txt` | 4,413 | `EB31CFDA7C5D98D1EF7FF08057726C936DF7CBE53955299F00D1C73B43516E57` | 四模块导出汇总 |
| E20 | `ego-q2-q5-q9-static-scan.txt` | 17,050 | `30D51C3F7861E4B9B564BDA339DBAF07292ACD4640859D8F3A3C8247CD105AB8` | Q2/Q5/Q9 静态扫描（daemon/3999/CoCreateInstance/管道） |
| E21 | `chrome-elf-analyze2.json` | 48,495 | `CA6B6B7DA24AB48FC9ABB3FA9EB6CB08E92B3DEA092B450F2101AC2BD8C25094` | Ghidra 全量失败记录（1,800,000 ms） |
| E21 | `chrome-elf-analyze.json` | 48,219 | `BB624878D913EF7567EEE5EF87DF4C50D2A890AF1A4922542AEC4DB48505C5A5` | 先前失败记录（330,000 ms） |
| E22 | `ego-sdk-guide.txt` | 18,775 | `DCA0F053E9C20B8604E4284B3BA5161E91AA79D6F1566844406D930568EC567A` | Ego SDK 指南（"not Playwright"等） |
| E22 | `ego-browser-skill.md` | 23,709 | `A59946F1C8C76EC8365D9389FE652825E8FA6411021FB26F19B7E4D8E938F338` | 实际 ego-browser skill 文本 |
| E22 | `ego-browser-help-topics.md` | 13,872 | `4BE1B16C6B068ACB711ECEF3088068928C157EA887902C58990BF66D479F78F1` | CLI help 主题 |
| E22 | `ego-browser-help-full.md` | 441 | `EAFBF467242A2D5D51C1F72B42CDB6F135365EB7FE84A5A27BFE253E2C90CFDD` | `ego-browser --help` 摘要 |

补充：`chrome-dll-resources.json`（74,855 B / `D093A555093546CDF00561904FE177B16B1126B0B16AF67BB87C0A51EE75B86B`）与 `ego-exe-resources.json`（42,834 B / `E490BA412CDD354B7215EA71201CB33BC600BA6E580A6DED7FBDF029D107447F`）分别为 E8/E9 的原始资源 JSON。

## 3. 限制与未知

- **纯静态证据**：本报告没有启动、控制或连接 ego lite 浏览器实例，没有执行浏览器自动化脚本、CDP 会话、动态跟踪、API Hook、内存 dump、调试器附加或网络抓包；因此“运行期实际行为”只能由静态字符串、导入导出和代码/资源结构推断，不能视为动态实测。
- **无 PDB / 私有符号**：Ghidra 日志显示 `Skipping PDB processing: failed to locate PDB file in configured locations`；函数名与类型恢复受限，尤其 `chrome.dll` / `chrome_elf.dll` 这类大型 stripped PE。
- **`chrome_elf.dll` 函数级分析未闭环**：Ghidra 全量分析 1,800,000 ms 后 `provider_timeout`（`operation: list_documents`，target SHA `4f9138fa75b1...`，产物 `chrome-elf-analyze2.json`）；更早一次 330,000 ms 也超时（`chrome-elf-analyze.json`）。因此 96.5 MB `.text` 的具体构建来源（哪些 Chromium targets 被静态链接）无法从函数级证实，只能从节表、RTTI/字符串分布和导入导出排除“大资源/Node/Python/模型”假设。
- **无固定 Ego 命名管道常量**：全盘未发现 Ego 专用 `\\.\pipe\<name>`；Mojo invitation 可以在运行时携带 message pipe handle，静态证据不能证明 CLI 与浏览器之间是否使用命名管道、匿名管道或其它句柄传递方式，也不能给出完整的运行时管道名。
- **`Runtime.enable` 的边界**：静态证据显示它只出现在 DevTools frontend / Node inspector 内部和 `ego.sendCDPMessage` 的示例字符串中，未发现 Ego 自动化路径主动发送它；但静态分析不能证明运行期绝不会通过动态拼接/反射构造该字符串。
- **3999 vs 3773 未定**：daemon 独立默认端口是 3773；`chrome.dll` 的 `chat_service_manager.cc` 区域存在相邻 `--host`、`--port`、`3999` 字面量；client bundle 也有 `http://127.0.0.1:3999` 回退串。静态证据无法判断浏览器启动 daemon 时固定传 3999、仅在 3773 被占用时回退 3999，还是 3999 属于另一服务/旧版本逻辑。
- **Daemon 常驻性未完全证明**：`ChatServiceManager` 的 `SelectDaemon` / `LaunchEntryScript` / `ScheduleRecovery` / `Restarting chat service in ...` 证明它会启动并重启 daemon，但不能证明 daemon 在整个浏览器生命周期内始终驻留（也可能按需启动、空闲退出）。
- **Ego 的精确 GN 构建参数未知**：`chrome.dll` 内嵌 Node gypi JSON 中的 `node_module_version=137`、`node_shared=false`、`napi_build_version="10"`、`is_debug=0`、`enable_lto=true`、`v8_enable_sandbox=1` 等是 Node 自身的构建值，不等于 Ego 的 GN args；Ego 的完整编译开关、符号级别、优化级别静态不可恢复。
- **证书撤销未联网验证**：`X509Chain.Build` 使用 `RevocationMode=NoCheck`；证书链和有效期来自本地证书解析。由于任务禁止网络请求，未在线验证 OCSP/CRL 撤销状态，也未验证根证书当前是否在 Microsoft Trusted Root 列表中。
- **字符串搜索不能证明动态使用**：例如 `api.citrolabs.ai`、`files.citrolabs.ai`、`speech.citrolabs.ai` 等来自字符串常量；服务端是否实际被调用、调用条件、是否可被策略关闭，均需动态验证。
- **Q3 的否定结论是“未发现静态证据”**：没有发现 Ego 专用的 fingerprint/spoof/stealth/`--fingerprint-*` 开关，不等于绝对不存在；可能由运行期注入的 JS、服务端下发配置或未纳入字符串扫描的加密/压缩数据实现。
- **`chrome_elf.dll` 体积原因仍有未知**：能证明约 96.5 MB 是 `.text` 代码、不是资源或打包载荷；但为什么把大量 Chromium 子系统静态链接进 `chrome_elf.dll`（而不是只保留 crashpad/ELF 小钩子）没有构建脚本或 PDB 可核对。
- **部分 REA JSON 记录在会话输出中被截断**：`ev_ac93...`、`ev_f6...` 等大记录在终端输出里有截断；Evidence id 与操作参数有效，但如需完整 raw_result，应按第 4 节命令重跑或直接读取任务日志中的完整 JSON 行。
- **`update_telemetry.json` 是可变运行态文件**：分析期间先后观测到 189 B（SHA `BCF8E195...`）和 194 B（SHA `507ABF37...`），说明该文件会被浏览器运行过程重写；其字段值（尤其 `uuid`）未在本报告披露，且不应把某个快照哈希当作固定二进制哈希。
- **`chrome_elf.dll` 的 pefile 导入解析异常**：`ego-chrome-elf-deepscan.txt` 中 `pefile` 报 `AttributeError("'PE' object has no attribute 'DIRECTORY_ENTRY_IMPORT")`；导入表改用 `pe-info.json` / `ego-resources-imports.txt` 的输出，结论不受影响，但重跑时建议使用 `pefile` 的 `DIRECTORY_ENTRY_IMPORT` 存在性检查或 `objdump -p`。

## 4. 可复现步骤

以下命令均为只读；不会启动浏览器或写入目标目录。建议在 PowerShell 7+、Python 3.11+（安装 `pefile`）、Node.js（`npx`）环境执行。

### 4.1 目标基线与哈希

```powershell
$root = '<你的家目录>\AppData\Local\Citro Labs\ego lite\Application'
Get-ChildItem -LiteralPath $root -Recurse -File -Force |
  Where-Object { $_.Extension -in '.exe', '.dll' } |
  ForEach-Object {
    $h = Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256
    '{0}`t{1}`t{2}' -f $_.Length, $h.Hash, $_.FullName
  }
```

预期核对：`ego.exe` `F57D702F...D06D`、`ego-browser.exe` `06333AF0...1A73F`、`chrome_elf.dll` `4F9138FA...FC06`、`chrome.dll` `2B05F316...ABFA`。

### 4.2 PE 节表 / 导入 / 导出

```powershell
python -c "import pefile; p=pefile.PE(r'<你的家目录>\AppData\Local\Citro Labs\ego lite\Application\0.6.0.22\chrome_elf.dll'); [print(s.Name.decode(errors='replace'), hex(s.VirtualAddress), s.Misc_VirtualSize, s.SizeOfRawData) for s in p.sections]"
```

导出/导入可用 `pefile` 遍历 `DIRECTORY_ENTRY_EXPORT.symbols` / `DIRECTORY_ENTRY_IMPORT`；资源用 REA（见 4.4）。检查 `chrome_elf.dll` 的 `.text` 每 8 MiB 熵可用标准库 `math.log2` 计算，参考产物 `ego-chrome-elf-deepscan.txt`。

### 4.3 字符串/字节扫描（Python，只读）

```python
from pathlib import Path
root = Path(r"<你的家目录>\AppData\Local\Citro Labs\ego lite\Application")
targets = [root/"ego.exe", root/"0.6.0.22"/"ego-browser.exe",
           root/"0.6.0.22"/"chrome.dll", root/"0.6.0.22"/"chrome_elf.dll"]
patterns = [b"EgoCliBootstrap", b"EgoCliBridge", b"ConnectToBootstrapLoop",
            b"Runtime.enable", b"fingerprint", b"spoof", b"stealth",
            b"\\\\.\\pipe\\", b"3999", b"update_telemetry.json",
            b"local-ego-daemon", b"ego.mojom."]
for path in targets:
    data = path.read_bytes()
    print(path.name, len(data))
    for pat in patterns:
        print("  ", pat, data.count(pat))
```

重点复核：`ego-browser.exe` 的 `ConnectToBootstrapLoop`、`Failed to extract Mojo message pipe from invitation`、`Receive mojo reply`、`Receive mojo message`、`ego.mojom.EgoCliBootstrap`、`ego.mojom.EgoCliBridge`；`chrome.dll` 的 `Runtime.enable` 6 处与 `ego.sendCDPMessage` 示例；`chrome_elf.dll` / `ego.exe` 的唯一 `\\.\pipe\crashpad_%lu_`。

### 4.4 REA CLI（版本钉死 `rea-agents@6.5.0`）

```powershell
$app = '<你的家目录>\AppData\Local\Citro Labs\ego lite\Application'
npx -y rea-agents@6.5.0 binary-overview "$app\0.6.0.22\ego-browser.exe" --json
npx -y rea-agents@6.5.0 search "$app\0.6.0.22\ego-browser.exe" --pattern 'Runtime\.enable|Page\.navigate|Target\.createTarget|webSocketDebuggerUrl|remote-debugging|DevTools|CDP|\\.\pipe|named pipe|WebSocket|Runtime\.evaluate|Page\.captureScreenshot|Browser\.getVersion' --mode regex --json
npx -y rea-agents@6.5.0 xrefs "$app\0.6.0.22\ego-browser.exe" --address 0x14030a7e8 --json
npx -y rea-agents@6.5.0 inspect-pe-resources "$app\0.6.0.22\ego-browser.exe" --json
npx -y rea-agents@6.5.0 inspect-pe-resources "$app\0.6.0.22\chrome_elf.dll" --json
npx -y rea-agents@6.5.0 inspect-pe-resources "$app\0.6.0.22\chrome.dll" --json
npx -y rea-agents@6.5.0 inspect-pe-resources "$app\ego.exe" --json
npx -y rea-agents@6.5.0 search-bytes "$app\ego.exe" --hex 6c6f63616c2d65676f2d6461656d6f6e --limit 100 --json
```

> 说明：若本地 CLI 的子命令名与上表略有差异，使用 `npx -y rea-agents@6.5.0 --help` 查看等价命令；本报告对应记录存放在 `.rea-job-20261024-084002\stdout.log`，可直接核对 operation 与参数。

### 4.5 Daemon 静态提取

```powershell
$daemon = '<你的家目录>\AppData\Local\Citro Labs\ego lite\Application\0.6.0.22\local-ego-daemon'
Get-ChildItem -LiteralPath $daemon -Recurse -File -Force | Measure-Object Length -Sum
Select-String -LiteralPath "$daemon\runtime\run-DRqUaiQQ.mjs" -Pattern 'DEFAULT_PORT = 3773','isLoopbackHost','EGO_AUTH_TOKEN','EGO_PUBLIC_URL','EGO_ALLOW_INSECURE_REMOTE','findAvailablePort'
Select-String -LiteralPath "$daemon\runtime\run-DRqUaiQQ.mjs" -Pattern '/health','/ws','/mcp','/api/session','/api/thread-export','/api/voice/transcribe'
```

`DEFAULT_PORT` 在 `run-DRqUaiQQ.mjs` 偏移约 468,229；`findAvailablePort` 的回退逻辑约在偏移 463,769。`mcp serve --integration` / `mcp pair --code` 可在 `run-DRqUaiQQ.mjs` 的 `externalMcpLauncher` 区域检索。

### 4.6 代码签名与证书链

```powershell
$root = '<你的家目录>\AppData\Local\Citro Labs\ego lite\Application'
Get-AuthenticodeSignature -LiteralPath "$root\ego.exe" | Format-List *
Get-AuthenticodeSignature -LiteralPath "$root\0.6.0.22\ego-browser.exe" | Format-List *
```

若要复核证书链/策略 OID，可对 `$sig.SignerCertificate` 构造 `X509Chain` 并打印 `ChainElements`；参考产物 `ego-cert-and-version.txt`（含 Subject/Issuer/Thumbprint/Serial、NotBefore/NotAfter、Policy OID `2.23.140.1.4.1`、EKU `1.3.6.1.5.5.7.3.3`）。注意：`RevocationMode=NoCheck` 仅表示本地链构建成功，不等于在线撤销已验证。

### 4.7 Ghidra 全量分析（可选）

```powershell
npx -y rea-agents@6.5.0 analyze-binary "<你的家目录>\AppData\Local\Citro Labs\ego lite\Application\0.6.0.22\chrome_elf.dll" --json
```

该命令在本机对 111 MB `chrome_elf.dll` 于 1,800,000 ms 超时（参考 `chrome-elf-analyze2.json` 的 `code=provider_timeout`、`operation=list_documents`）。如需函数级结果，建议先按节区/地址范围切片或增加 provider 超时；不要据此修改目标文件。

### 4.8 结果判读

- Q1 判定标准：`ego-browser.exe` 同时出现 `ego.mojom.EgoCliBootstrap` / `EgoCliBridge` + `ConnectToBootstrapLoop` + `Failed to extract Mojo message pipe from invitation` + `Receive mojo reply/message`，而 `Runtime.enable` 为 0。
- Q2 判定标准：`154.0.8037.44` 版本串 + 2,312 处 `..\..\ego\` 路径 + Node 导出符号集中在 `chrome.dll`。
- Q4 判定标准：`chrome_elf.dll` `.text` 约 96.5 MB、`resource_total_payload=58,334`、无 Node/Python/模型指标。
- Q5 判定标准：daemon `DEFAULT_PORT=3773`、回环策略拒绝 `EGO_AUTH_TOKEN`/`EGO_PUBLIC_URL`/`EGO_ALLOW_INSECURE_REMOTE`、38 路由、`ChatServiceManager` 的 `SelectDaemon`/`LaunchEntryScript`/`ScheduleRecovery`。
- Q7 判定标准：`update_telemetry.json` 文件名 + `ego_update_telemetry.cc` + `ct1_`/`uuid` 字段；许可域扫描无 Citro license 端点。
- Q8 判定标准：`Get-AuthenticodeSignature` 12/12 `Valid`；叶证书策略 OID 只有 `2.23.140.1.4.1` 与 Certum 自定义 OID，无 `2.23.140.1.3`。
- Q9 判定标准：`chrome_elf.dll` 29 导出全为 crashpad/ELF，`chrome.dll` 753 导出中 Node/N-API 为静态链接附带，`CoCreateInstance` 仅 Chromium 上下文，无 Ego 固定管道/COM CLSID。

---

**报告结束。**