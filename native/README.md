# native · 自写原生层

> **它要实现什么**:见 `docs/原生层接口.md`(契约正本,来自上游文档)。
> **本文件补的是另一半**:*vendored harness 的代码**实际**怎么调它* —— 这比文档可靠,
> 因为它是**跑得起来的代码**。
>
> 方法:在 `harness/package/ego-browser/src/` 上 grep 全部 `globalThis.ego.*` 调用,
> 逐条记录**调用点、参数、返回形状、以及代码里明写的约束**。

---

## 一、原生层必须实现的调用面(从代码里挖出来的,不是抄文档)

| 原生调用 | 代码里在哪 | 返回/参数形状 | 代码里明写的约束 |
|---|---|---|---|
| `ego.sendCDPMessage(payload)` | `browser-runtime.ts:351` | `payload` 是 **JSON 字符串**;返回 CDP 响应 | **主传输**。`hasBrowserRuntime()` 就靠 `typeof globalThis.ego.sendCDPMessage === "function"` 判断 |
| `ego.onCDPMessage` | `sdk-lifecycle.test.mjs:30` | 回调槽 | `disposeEgoSdk()` 必须能摘掉它 |
| `ego.onSendCDPMessageError` | `sdk-lifecycle.test.mjs:47` | 回调槽 `(message, error_code)` | 同上;**不带 request id** → 任务级失败会 reject 所有 pending |
| `ego.listTabs()` | `nav.test.mjs:35`、`observe.test.mjs:22`、`waits.test.mjs:180` | 列表 | —— |
| `ego.createTab(...)` | `index.ts:229` | —— | harness 会**包一层**它的返回值(用于失效 session)→ 要容忍被 wrap |
| `ego.useTaskSpace(spaceId)` | `helpers.ts:161`、`native-gate.ts:136`、`index.ts:217` | —— | 同样**被 wrap**;且 `spaceId` 是 **number** |
| `ego.createTaskSpace(name)` / `(name, profileId)` | `helpers.ts:198-199` | —— | ⚠️ 代码注释明写:**不要显式传 `undefined`** —— 旧 native 会因多一个参数而报错 |
| `ego.claimTaskSpace(...)` | `helpers.ts:357,371` | —— | —— |
| `ego.listTaskSpaces()` | `helpers.ts:91` | 被 `normalizeTaskSpaces()` 规整 | —— |
| `ego.listProfiles()` | `helpers.ts:105` | 必须是 `{profiles: [...]}` | 代码会**校验 `result.profiles` 是数组** |
| `ego.handOffTaskSpace()` | `page-model.ts:712` | —— | 交接给用户 |
| `ego.completeTaskSpace()` | `page-model.ts:719` | —— | —— |
| `ego.closeTaskSpace()` | `page-model.ts:726` | —— | —— |
| `ego.snapshot(options)` | `observe.test.mjs:87,115` | **返回对象 `{content, refs}`** | **压缩在 JS 侧做**(测试名就叫 *"snapshot compacts the native result"*)→ 原生层给**原始树 + refs** 即可 |
| `ego.animationHighlightMouseToPosition(x,y)` | `page-model.ts:736`、`pointer.ts:594` | —— | **可选**(`typeof ... !== "function"` 就 return) |
| `ego.setAgentTaskState(state)` | `page-model.ts:742`、`pointer.ts:596` | —— | **可选** |
| `ego.getBrowserVersion()` | `update-notice.test.mjs:60` | `{currentVersion, updateAvailable}` | —— |

## 二、从代码里读出来的三条硬约束

1. **可选方法要真的能缺席**:`animationHighlightMouseToPosition` / `setAgentTaskState`
   在 harness 里是 `if (typeof ego.X !== "function") return;` —— 所以原生层**可以暂时不实现**,
   不会致命。**先做必需的那几个,能跑起来再补。**
2. **`snapshot()` 返回的是对象不是字符串**:`{content, refs}`。压缩规则(见
   `docs/原生层接口.md` §4.1)由 **JS 侧**执行 —— 原生层给全量即可,**别在 C++ 里做压缩**。
3. **契约靠 `error_code` 判定,不靠文案**。`helpers.test.mjs:1334` 明写:
   > *"The probe in waitForAgentControl keys on `ego.snapshot()`'s rejection carrying
   > `error_code === EGO_TASK_SPACE_USER_IN_CONTROL` (the documented contract), not on
   > message wording."*
   即:`snapshot()` 在「任务已交给用户」时必须 **reject** 且 `error_code` 精确等于
   `EGO_TASK_SPACE_USER_IN_CONTROL`。**文案随便写,代号不能错。**

## 三、M2 的最小落地顺序(建议)

按「能最快跑通 `native/smoke/taskspace-smoke.mjs`」倒推:

| 步 | 实现 | 为什么先做 |
|---|---|---|
| 1 | `sendCDPMessage` + `onCDPMessage` + `onSendCDPMessageError` | **一切都建在它上面**(`hasBrowserRuntime()` 的唯一判据) |
| 2 | `useTaskSpace` / `createTaskSpace` / `listTaskSpaces` / `listProfiles` | 冒烟脚本第一步就是 `taskSpace(name)` |
| 3 | `createTab` / `listTabs` | `task.newPage()` 要用 |
| 4 | `snapshot`(返回 `{content, refs}`) | 冒烟脚本第 5 步 |
| 5 | `handOffTaskSpace` / `takeOverTaskSpace` / `completeTaskSpace` / `closeTaskSpace` | 交接语义 |
| 6 | 可选:`animationHighlightMouseToPosition` / `setAgentTaskState` / `getBrowserVersion` | 能缺 |

## 四、验收

`native/smoke/taskspace-smoke.mjs` 的输出两边对比(**同一段脚本**):

| 参照 | 状态 |
|---|---|
| **ego lite**(现成) | ✅ 已跑通:`ok=true` · spaceId=43 · title="Example Domain" · snapshot 1175 字符 |
| **ouuut**(自写原生层) | ⏳ M2 目标 |

对比口径:`ok` 字段一致、`steps.evaluate.title` 一致、`snapshot` **结构同形**(见
`docs/原生层接口.md` §4.3),长度量级相当。

---

## 五、还没做的(不掩饰)

- 原生层**一行 C++ 都还没写**(本文件是它的需求书)
- `harness/` 目前是**未改动的上游副本** —— 还没把它接到我们的原生层上
- 冒烟脚本目前只在 ego 上跑过
- 上游那个 `disposeEgoSdk()` 生命周期钩子还没在我们的入口里落地
