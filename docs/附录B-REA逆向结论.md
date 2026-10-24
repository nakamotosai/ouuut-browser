# 附录 B · REA 逆向结论(ego lite 二进制)

> 日期:2026-10-24 · 证据:REA(codex 专用逆向 harness,Ghidra 12.1.4 + JDK 21),**纯只读静态分析**
> 原文(359 行、含全部 Evidence id 与 digest):`docs/附录B-REA逆向结论-原文.md`
> 任务日志(可复核 operation / parameters / normalized_result):`re/ego-lite/.rea-job-20261024-084002/stdout.log`
> 分析约束:未启动/控制/连接任何 ego lite 实例;未跑自动化脚本、CDP 会话、抓包;未改动任何目标文件。
>
> **用途声明(用户 2026-10-24 明确)**:本次逆向**只为理解其设计取舍、并找出它的缺点**。
> 不复制其代码、不派生其作品、不打包其二进制。以下结论只进「设计输入」与「缺点表」。

---

## 一、决定性发现(直接改变方案形态)

### B1 · 它的自动化主通道不是 CDP,是 Mojo/ipcz 私有 IPC

| 项 | 结论 | 证据 |
|---|---|---|
| CLI → 浏览器 | `ego.mojom.EgoCliBootstrap` / `ego.mojom.EgoCliBridge`,经 Mojo invitation 传递 message pipe | 字符串 `ConnectToBootstrapLoop`、`Failed to extract Mojo message pipe from invitation`、`..\..\mojo\core\ipcz_driver\invitation.cc` |
| 寻址 | `--ego-server-name=<name>`(≤64 个 ASCII);**全盘未发现固定的 Ego 命名管道路径常量**(唯一 `\\.\pipe\` 字面量是 Crashpad 的) | `\\.\pipe\crashpad_%lu_` 仅见于 `ego.exe`/`chrome_elf.dll` |
| 消息格式 | 主通道是 Mojo 二进制消息;**未观察到主通道的文本 JSON-RPC schema** | — |
| CDP 的地位 | **可选子通道**:`page.cdp(method,params,options)` / `ego.sendCDPMessage()`;错误码 `EGO_CDP_CHANNEL_UNAVAILABLE`、`EGO_CDP_SEND_FAILED`,且 CDP 挂在 TaskSpace 上需先 claim | `ego.mojom.NodeCdpChannel` 等接口名 |
| Node 绑定实现 | `..\..\ego\components\node\node_bindings_impl.cc` / `..\..\ego\services\node\node_runtime_impl.cc`;内置 preload `ego://services/node/resources/index.js` | — |

### B2 · `Runtime.enable` 没有「自动发送」的静态证据 ← **本次最重要的设计输入**

逐模块计数:

| 模块 | `Runtime.enable` 出现处 | 性质 |
|---|---|---|
| `chrome.dll` | 6 处 | 5 处是 DevTools frontend / Node inspector 内部;1 处是 `ego.sendCDPMessage` 的**错误示例字符串** |
| `chrome_elf.dll` | 1 处 | DevTools frontend 绑定列表 |
| **`ego-browser.exe`** | **0** | — |
| **`ego.exe`** | **0** | — |

**结论:常规 TaskSpace/Page API 走 Ego 原生绑定,不依赖 `Runtime.enable`;只有显式调用 `page.cdp()` / `sendCDPMessage()` 才可能发任意 CDP 方法。**

这条对方案意义极大:它把「消灭 CDP 泄漏」这个目标**收窄**了 ——
真正致命的检测面是 `Runtime.enable`(以及由 `Runtime.evaluate` 派生出的栈帧/世界观名泄漏),
而不是「CDP 这个协议整体」。
**【推断】** `Input` / `Page` 等域本身不产生那类副作用 —— 这一句是 REA 报告之外的推理,报告只证明了
「CDP 是按需子通道」与「未发现自动化路径自动发送 `Runtime.enable`」,并未分析各 CDP 域的副作用,待 M0 实测。

### B3 · `chrome_elf.dll` 111 MB 之谜解开

| 假设 | 结论 |
|---|---|
| 打包了 Node / Python / 模型 / 大资源 | ❌ 全部排除(`onnxruntime` 0、无 `libpython`/`.pyd`/`gguf`/`safetensors`) |
| **静态链接进去的 Chromium 子系统代码** | ✅ **约 96.5 MB 的 `.text`**(VSize 96,482,645);`.rsrc` 仅 60,840 B;全文件仅 1 个有效 PE 头 |
| 为什么这样链接 | ❓**未知** —— 函数级分析 1,800,000 ms 后 `provider_timeout`,更早一次 330,000 ms 同样超时;无 PDB、无构建脚本可核 |

旁证:该模块 `..\..\ego\` 路径 **0 个**(定制代码全在 `chrome.dll`),仅 29 个导出(全是 crashpad/`chrome_elf` 系列)。

### B4 · `local-ego-daemon` 是一个完整的 agent 编排后端

| 项 | 事实 |
|---|---|
| 规模 | **556 个文件 / 28,987,019 字节**;入口 `index.mjs` → `runtime/index.mjs`(Sentry 初始化)→ `runtime/run-*.mjs`(5.2 MB 单文件) |
| 性质 | Node.js ESM 的 chat/agent 后端,**由浏览器内 `ChatServiceManager` 选择、安装、启动并失败重启** —— 不是浏览器守护进程 |
| 监听 | **仅回环**;默认 `127.0.0.1:3773`;`EGO_AUTH_TOKEN` / `EGO_PUBLIC_URL` / `EGO_ALLOW_INSECURE_REMOTE` 任一存在即**启动失败** |
| API 面 | **38 个路由**:`/health`、`/ws`、`/mcp`、`/mcp/external`、`/api/files/upload`、`/api/voice/transcribe`、`/api/model`、`/api/auth/`、`/api/thread-export` … |
| MCP | 内置外部 MCP stdio 桥:`mcp serve --integration <id>`、`mcp pair --code <code>` |
| 数据库 | 6 个迁移、约 **48 张表**(`orchestration_events`、`external_mcp_*`、`auth_pairing_links`、`automation_*`、`projection_*` …) |
| 外联 | Sentry DSN **硬编码**在 `runtime/sentry-*.mjs`;Langfuse 走 `EGO_LANGFUSE_*` + OTLP `/api/public/otel/v1/traces` |

**值得借的一点**:它把「agent 编排」做成了独立后端 + HTTP/WS + MCP 三种入口。
我们的编排层可以直接采用这个形状(浏览器本体保持薄),不必把编排塞进内核。

### B5 · 它没有许可校验服务器

`chrome.dll` 里 `license` / `entitlement` / `subscription` / `billing` / `checkout` 等词**全部来自 Chromium 通用代码或 daemon 的计费 UI 文案**,**没有独立的 license server URL**。

→ 对比 CloakBrowser(有 license 校验 + 会话计数,且有服务端并发闸)。**ego 是纯本地免费**,
这也解释了为什么它的商业模型放在 Business 定制与另一个产品 `ego` 上。

### B6 · 代码签名是 OV,不是 EV

12 个 PE 全部 `Valid`,主体 `CITRO LABS PTE. LIMITED`(新加坡),签发者 `Certum Code Signing 2021 CA`,
策略 OID 为 `2.23.140.1.4.1`(**OV**);**未见 EV 的 `2.23.140.1.3`**。有效期 2026-09-15 → 2027-09-15。

### B7 · 没有第三方原生集成接口

| 模块 | 导出 |
|---|---|
| `chrome_elf.dll` | 29 个,全是 crashpad 系列 + `sqlite3_dbdata_init`,**无 Ego SDK** |
| `chrome.dll` | 753 个,其中 227 `@node@@` / 145 `napi_*` / 124 `@v8@@` —— 是**静态链接 Node 的附带符号**,不是文档化 SDK |
| `ego-browser.exe` | **仅导出 `GetHandleVerifier`** |
| COM | `CoCreateInstance` 全是 Chromium/系统用途,**无 Ego 自有 CLSID** |

→ 第三方集成面只有三条:`ego-browser` CLI、daemon 回环 HTTP/WS、daemon 的 MCP stdio 桥。
**没有可嵌入的原生 SDK** —— 这对我们是空白(见 `竞品缺点-切入点对照.md` E-series 与 G-series)。

---

## 二、对方案的三处修正

| # | 原表述 | 修正后 |
|---|---|---|
| **修正 1** | v3 §2.1 / v2 §四:「它**确实在用 CDP**(元素操作是 native CDP input),所以只能借『不暴露端口』不能借『不用 CDP』」 | **主通道是 Mojo/ipcz,不是 CDP**;CDP 只是可选子通道。元素操作走 CDP Input 域,但 **`Runtime.enable` 无自动发送证据**(B2)。→ 可以借的比原先以为的多:它证明了「**进程内自有通道 + 按需 CDP**」这个形状真实可行 |
| **修正 2** | A2 决策:「阶段 A 双端补丁 → 阶段 B 自研进程内通道」,自研通道是核心护城河 | **收窄靶心**:先证明「不发 `Runtime.enable` 是否已足够」。若足够,阶段 B 的优先级**下调**,省下的 4–6 周改投档案引擎与服务器化。**这个判断归 M0**,不预设结论 |
| **修正 3** | 「chrome_elf.dll 111 MB 是未解之谜」(v3 §十) | **已解**:约 96.5 MB 是静态链接的 Chromium `.text`。「为什么这么链接」仍未知,但对我们**没有影响** |

## 三、REA 自己声明的限制(照抄,不替它抹平)

1. **纯静态**:未启动浏览器、未跑 CDP 会话、未抓包、未做动态跟踪/API Hook/内存 dump。运行期行为只能由静态证据推断。
2. **无 PDB/私有符号**:Ghidra 报告 `failed to locate PDB file`,大 PE 的函数级与类型恢复受限。
3. **`chrome_elf.dll` 函数级分析未闭环**:1,800,000 ms 与 330,000 ms 两次都 `provider_timeout`。
4. **无固定 Ego 命名管道常量**:Mojo invitation 可在运行期传递句柄,静态无法确定具体传递方式,也给不出运行时管道名。
5. **`Runtime.enable` 的边界**:静态不能证明运行期**绝不**通过动态拼接/反射构造该字符串 —— 只能证明**未发现 Ego 自动化路径主动发送它**。
6. **3999 vs 3773 未定**:daemon 默认 3773,但 `chrome.dll` 的 chat service 区域有相邻 `--port`/`3999`,client bundle 也有 `127.0.0.1:3999` 回退串。
7. **daemon 常驻性未完全证明**:能证明会启动并重启,不能证明全生命周期常驻(可能按需启动/空闲退出)。
8. **Ego 的精确 GN 构建参数未知**;`chrome.dll` 内嵌的 gypi 值是 Node 自身的构建值,不等于 Ego 的编译开关。
9. **证书撤销未联网验证**(`RevocationMode=NoCheck`);未验根证书是否在 Microsoft Trusted Root 列表。
10. **字符串命中不等于被调用**(如 `api.citrolabs.ai` 等常量的实际调用条件需动态验证)。
11. **Q3 的否定结论是「未发现静态证据」**,不等于绝对不存在(可能由运行期注入 JS 或服务端下发配置实现)。
12. **部分 REA JSON 记录在终端输出中被截断**;需要完整 raw_result 时按原文第 4 节命令重跑。

---

## 四、结论一句话

**ego lite 证明了两件事:一是「不暴露 TCP 调试端口的进程内自动化通道」确实可行,且其自动化路径**未发现**主动发送 `Runtime.enable`(静态结论,运行期待 M0 验证);
二是「桌面 + 回环 + 无头缺失 + 无原生 SDK」这套约束是它自己选择的结果,不是技术必然。**

第一件是我们要抄的**设计**;第二件是我们要占的**空地**。
