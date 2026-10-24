# ouuut × ego lite harness(上游 MIT 代码的 vendored 副本)

> **这不是我们的代码。** 这是 `citrolabs/ego-lite` 在**指定 commit** 上的副本,
> 按 MIT 许可引入(见 `LICENSE` 与仓库根 `LICENSES/ego-lite-MIT.txt`)。
> **上游自己的 `AGENTS.md` 与 agent 配置已被剔除** —— 免得被误当作本项目的规则读进去。
> 本项目的门规在仓库根的 `AGENTS.md`。

---

## 一、fork 点(唯一正本在 `.vendored-manifest.json`)

| 项 | 值 |
|---|---|
| 上游 | `https://github.com/citrolabs/ego-lite` |
| 许可 | **MIT**(Copyright (c) 2026 CitroLabs) |
| commit | `d392204d1ea1a8027a591ab2b0129c2e11d85f26` |
| 取法 | `gh api repos/citrolabs/ego-lite/tarball/<sha>`(tarball,不是 git clone) |
| 文件数 | 197(保留)/ 12(排除) |
| tree digest | 见 manifest 的 `tree_digest` |

**第三方可复算**:下载 compressed tarball → sha256 应等于 manifest 的 `tarball_sha256`;
按 `excluded_top_level` 剔除后逐文件 sha256 应得到 `tree_digest`。

**排除了什么、为什么**:上游的 `.agents/ .claude/ .claude-plugin/ .codex/ .github/ AGENTS.md
CONTRIBUTING.md .gitignore lefthook.yml` —— 那是**上游自己的 agent 指令面与仓库配置**。
放进本项目会形成嵌套的 agent 配置,**可能被当作本项目的规则读进去** —— 那是污染。
**功能代码一行没删。**

---

## 二、我们从这里拿什么(与 `docs/决策记录.md` ADR-004 对应)

| 拿什么 | 在哪 | 价值 |
|---|---|---|
| **TaskSpace 模型** | `package/ego-browser/src/task-space.ts` | 所有权(agent/user)与交接语义 —— 我们直接照搬这个抽象 |
| **语义快照 + `@ref`/`loc=` 选择器** | `src/snapshot.ts`、`src/ref-map.ts`、`src/ref-state.ts`、`src/element-resolver.ts` | 内核生成 a11y 树、不注入页面 JS |
| **site-learnings 机制** | `skills/ego-browser/learnings/` | 「在某站学会怎么点」的落盘格式与加载方式 |
| **CDP 逃生口** | `src/cdp-eval.ts` | 显式逃生口的形状(默认不用) |
| **多宿主插件打包** | `plugins/ego/` | 将来做我们自己的插件时参考 |
| **原生层接口文档** | `docs/native-*.md` | **最有价值** —— 见 §三 |

---

## 三、最重要的一件事:**`docs/native-bindings-api.md` 就是我们的实现契约**

那份文档描述的是**上游原生层注入 `globalThis.ego` 的那组 API** ——
也就是说,**它就是「JS harness」与「闭源原生层」之间的接缝规格**。
我们要写的原生层,最低限度要实现这一组方法:

```
ego.getBrowserVersion()          ego.useTaskSpace(id)
ego.listProfiles()               ego.createTab(url) / listTabs()
ego.snapshot(options?)           ego.listTaskSpaces()
ego.createTaskSpace(name, profileId?)   ego.claimTaskSpace(id, name?)
ego.closeTaskSpace()             ego.completeTaskSpace()
ego.handOffTaskSpace()           ego.takeOverTaskSpace()   ego.setAgentTaskState(state)
ego.animationHighlightMouseToPosition(x, y)
ego.sendCDPMessage(msg)  ·  ego.onCDPMessage  ·  ego.onSendCDPMessageError
```

配套的三份**要求文档**(定义快照语义与生命周期,我们要照做或明确改进):

| 文档 | 说什么 |
|---|---|
| `docs/native-snapshot-ref-requirement.md` | 快照文本的化简规则(空/纯空白/NBSP/零宽字符要丢)、`ref` 的稳定性 |
| `docs/native-sdk-lifecycle-requirement.md` | 卸载/替换时必须 `await disposeEgoSdk()` |
| `docs/native-javascript-dialog-requirement.md` | 页面 `alert/confirm/prompt` 归 agent 控制;`beforeunload` 仍未解决 |

> ⚠️ **这份 API 是上游的接口形状,不是我们必须逐字实现的标准。**
> 我们借的是**形状**(ADR-004:只依赖其接口形状,不追上游)。
> 自己的档案模型(三种 kind、硬隔离)会在这之上扩展 —— 见 `docs/方案-v3-终稿.md` §五。

---

## 四、我们替换什么(不要指望 vendored 代码里能看到)

| 上游有,我们没有 | 处理 |
|---|---|
| 闭源原生层(`chrome.dll` 里的 Mojo/ipcz 服务) | **自写**。这是 M1 + M2 的主体 |
| 原生语义快照的内核实现 | **自写**(C++ 层) |
| 指纹补丁 | **自写**(M1,来自 M0 的修复责任分工表) |
| 档案隔离 | **自写**(M3;上游没有这个概念 —— 那正是它的 E7/E2 短板) |
| 无头 / 服务器 | **自写**(M5;上游主动砍掉了远程能力) |

---

## 五、纪律

1. **不追上游**(ADR-004):只在有明确需要时,才把这个 vendored 副本更新到新 commit
2. 更新时必须**同时**更新 `.vendored-manifest.json`(commit / tarball sha / tree digest / 排除表)
   —— 否则「这份副本没被改过」就不可证了
3. **不要在本目录里写我们的代码**。我们的原生层放 `native/`,我们的定制放各自目录
4. 若将来真的修改了 vendored 文件,必须在 manifest 里增加 `local_modifications` 字段逐条登记
