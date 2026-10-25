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
| `ego.listTabs()` | **生产代码**:`browser-runtime.ts:606`、`page-model.ts:696`、`nav.ts:109` | 必须是 `{tabs:[{targetId, active, …}]}`,**至少一条 `active:true`** | ⚠️ **必需** —— `browserCdp` 靠它解析当前 target;给不出活跃页就抛 `no active tab to attach session` |
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
- `harness/` **已不再是未改动的副本** —— 命名空间已改名为 `ouuut`(16 文件),
  逐文件登记在 `harness/.vendored-manifest.json` 的 `local_modifications`;
  但**还没接到我们的原生层上**(接线见 §六)
- 冒烟脚本目前只在 ego 上跑过
- 上游那个 `disposeEgoSdk()` 生命周期钩子还没在我们的入口里落地

---

## 六、接线实录(2026-10-24,**已跑通**)

### 6.1 已经能跑的东西

`native/binding/` 下两片,各有独立验收:

| 文件 | 是什么 | 验收 |
|---|---|---|
| `cdp-pipe.mjs` | 通道:CDP over `--remote-debugging-pipe`(不暴露 TCP 端口) | `cdp-pipe.test.mjs` — **11 个用例全过** |
| `ouuut-runtime.mjs` | `globalThis.ouuut` 的运行时(透传桥 + CDP 直通原语) | `ouuut-runtime.test.mjs` — **7 个用例全过** |
| `fixtures/fake-cdp-peer.mjs` | **测试替身**:真 pipe 上的假 CDP 对端 | 被上面两个测试使用 |

**最有价值的一条**:`ouuut-runtime.test.mjs` 跑的是 **vendored harness 的真实构建产物**
(`dist/src/browser-runtime.js`),不是我们复刻的简化版 —— 也就是说
「**把 `globalThis.ouuut` 换成我们的实现,harness 那条 CDP 通路真的通**」**已经被证**,
而且不需要起浏览器(对端是假 CDP peer)。

### 6.2 ⚠️ **上一版这份清单是错的**

本文件 §一 原来按「`globalThis.ego.*` 属性访问」grep 出来的 16 个调用点里,
**漏掉了 `listTabs`** —— 因为 harness 有**字符串派发**(`invokeEgo("listTabs", …)`),
属性访问的 grep 抓不到。实测一跑就报 `browserEgo(...).listTabs is not a function`。

**教训**:需求清单要从**派发点**与**真实流量**里取,不能只 grep 属性访问。

### 6.3 权威清单:harness **实际发出**的 CDP 方法

让假对端把收到的每个方法落文件,跑一遍完整握手,得到:

```
Target.setAutoAttach   Target.getTargets   Target.attachToTarget
Page.enable            Network.enable      Browser.getVersion
```

**关键:`Runtime.enable` 一次都没出现。**

这直接支撑 ADR-005 的目标(「不主动发 `Runtime.enable`」)—— 而且证据来自
**上游 harness 的真实产物**,不是我们的假设。也就是说:**这一条不需要我们额外做工作,
只要我们的层别画蛇添足去发它。**

(对照:`docs/附录B-REA逆向结论.md` 里对 ego 闭源二进制的静态分析也只找到
「`chrome.dll` 6 处 `Runtime.enable`,其中 5 处在 DevTools frontend/Node inspector 内部,
1 处是错误示例字符串」。两者互相印证。)

### 6.4 还差什么

| 项 | 状态 |
|---|---|
| 通道(透传 + CDP 直通原语) | ✅ 11 用例 |
| 运行时接线(harness 真实产物跑在我们的实现上) | ✅ 7 用例 |
| **任务空间状态机 + user-control 门 + 快照** | ✅ **15 用例** |
| CLI 入口(对应上游 `ego-browser nodejs <script>`) | ❌ 未写 |
| **真浏览器端到端** | ❌ 未跑 —— 项目策略禁止命令行起浏览器做自动化,需使用者显式运行本产品 CLI 或明确许可 |
| 快照的 `ref` / `loc=` 选择器编号 | ❌ 见 §6.5 |

### 6.5 快照:角色词汇表是**采出来的**

`docs/原生层接口.md` §4.3 只有 example.com 一个样本。为了不猜,写了
`native/smoke/harvest-roles.mjs`,在 **ego 上采了 3 个页面**(example.com / iana.org /
MDN button),得到 **16 个实际出现过的 token**:

```
root  svg_root  paragraph  text  anchor  container  image  unordered_list
list_item  ordered_list  heading  table  table_row  table_cell  button  textbox
```

由此确定:**这不是驼峰转换,是词汇映射** —— CDP 说 `RootWebArea`/`StaticText`/`link`/`generic`,
ego 说 `root`/`text`/`anchor`/`container`。映射表落在 `snapshot.mjs`,不在表里的走驼峰兜底。

**仍未做**(不掩饰):
- `ref` / `loc=` 选择器编号(§4.5 的跨 frame 唯一性与同一性校验)
- 文本化简的完整规则(§4.1)
- ~~`maxResultLength` 是截断~~ → 已改为**按重要性挑选行**(见 `snapshot.mjs` 的
  `selectByImportance`):预算紧张时优先保 `root` → 带 ref 的可交互节点 → heading →
  有内容的 text → 有名结构节点,被丢的位置写 `...(省略 N 行)`。挑中的行**连祖先一起保**
  且**保持原序**,否则层级读不通
- ~~OOPIF(跨进程 iframe)取树未接~~ → 已实现 `oopif.mjs`:`Target.getTargets` 找
  `type==="iframe"` → `attachToTarget({flatten:true})` 拿 session → 在**那个 session** 上
  `Accessibility.getFullAXTree` → 用**同一个 ref 分配器**合并。ref 记录带 `sessionId`,
  否则后续动作路由不到那个 target。`runtime.snapshot()` **默认**走这条路
  (传 `includeFrames:false` 可关)。单个 frame 抓失败只跳过它,不毁整张快照
- ~~`ordered_list` / `unordered_list` 按 unordered 兜底~~ → **不再装懂**:
  CDP 的 `list` 角色不带有序信息,所以拿不到 DOM 标签时输出中性 token `list`;
  调用方传 `tagNameOf(backendNodeId)` 才会得到 `ordered_list` / `unordered_list`
