# ouuut 浏览器

> **状态**:M0–M7 的代码侧全部完成,装好的浏览器**端到端跑通**。功能范围里曾经缺的四项
> (档案绑代理 / 三入口 / 出口一致性闸 / 零遥测验收)现在**都已落地并真机验过** ——
> 逐项证据见 `docs/里程碑.md`。
> ⚠️ **尚未完成的两件,如实写在这里**:R2(在**干净 VM** 里从零重建)没做;因此 M7 里
> 「第三方可复现构建」那条**保持未完成** —— R1(异盘符异路径变体)只能证明 R1 能证明的东西,
> 不拿它冒充 R2。见 `docs/下一步方案.md`。
> 更新:2026-10-26

**一句话定位**:可审计的、多身份的、能上服务器的隐身浏览器。免费开源,不限并发,零遥测。

---

## 现在在哪、下一步是什么

工作包的顺序与判据全在 `docs/下一步方案.md`(唯一正本)。当前:

- **P1–P9 全部完成**(含档案绑代理、出口一致性闸、三入口、自动更新真链路、零遥测、档案级租约)。
- **P10(R1)**:异盘符 / 异路径从零重建,与 `chromium/REPRODUCIBILITY.json` 记录的产物 **逐字节**比;
  结论会写进 `docs/里程碑.md` 的 M7 与本文件的状态块。
- **P11(R2)**:干净 VM 全量重建 —— **未做**(需要管理员 + 一次重启 + 一天机时),清单在
  `docs/下一步方案.md` 的 P11 节。
- **P12**:公开化 + 发 0.1.4 —— 材料审查已过(`tools/check-public-ready.mjs` 0 违规)。

关于「没有第二台机器」:可复现构建用**已有设备**闭合 —— 异盘符/异路径变体 + Hyper-V 干净 VM。
但 R2 没做之前,`docs/里程碑.md` 的 M7「第三方可复现构建」**保持未完成**(ADR-016 的硬条件)。

## 怎么跑(两种形态,入口都只有一个文件)

```bash
# 1) 开发机(仓库里,浏览器默认取 chromium/src/out/Release/chrome.exe)
node native/bin/ouuut.mjs nodejs --script 脚本.mjs [--headless]

# 2) 发布包(与浏览器同目录;不用 --browser,它就在入口旁边)
node <发布目录>/payload/ouuut.mjs nodejs --script 脚本.mjs [--headless]
```

双档案双出口(一个会话里两个档案、各自绑自己的出口):

```bash
node native/bin/ouuut.mjs nodejs --headless \
  --profiles '[{"id":"a","kind":"persona","proxy":"socks5://host:1080"},{"id":"b","kind":"disposable"}]' \
  --script 脚本.mjs      # 脚本里 taskSpace("x", { profileId: "a" }) 之后的页面就走 a 的档案与出口
```

⚠️ 两个档案要**先在脚本开头**把空间都建好(harness 建空间时要求浏览器恰好一个标签页);
服务端入口**只服务一个档案**,给 `--profiles` 会明确拒绝(见 `docs/坑与解法.md` 坑-47)。

`--script` 也可以换成 stdin heredoc(`ouuut nodejs <<'JS' ... JS`)。代理、档案、窗口等开关见 `--help`。

### 三个入口(P5)

同一个浏览器、同一套原生层,三种驱动方式;**快照文本一致**(由 `tools/verify-three-entries.mjs` 守着):

```bash
# 1) CLI:跑一段脚本(harness 那条路)
node native/bin/ouuut.mjs nodejs --script 脚本.mjs [--headless]

# 2) HTTP + WebSocket:长期持有会话,默认只听 127.0.0.1 且**必须有令牌**(没给就现生成并打印)
node native/bin/ouuut-serve.mjs --headless [--port 8788]
#   GET /health · GET /version · GET /tabs · POST /goto {url} · GET|POST /snapshot · POST /close
#   鉴权:Authorization: Bearer <token> 或 ?token=<token>(WS 同源、同样要令牌)

# 3) MCP stdio:给 agent 宿主用(JSON-RPC over stdio;stdout 只走协议)
node native/bin/ouuut-mcp.mjs --headless
#   工具:browser_goto / browser_snapshot / browser_tabs / browser_version /
#         browser_batch / browser_wait / browser_profile
#   browser_batch = 一串步骤(goto/snapshot/tabs/version/wait)按序跑,首错即停(continueOnError 可继续)
#   browser_wait  = 等加载状态 / CSS 选择器 / 可见文本(走 harness 的页面等待 API,不轮询快照)
#   browser_profile = 当前档案 id/kind + 档案列表;经 MCP 建/关档案未开放(如实标 false)
#   轨迹:每次 tools/call 追加一行到 runs/<sessionId>/trajectory.jsonl,快照正文另存 snapshots/;
#         默认根目录是系统临时目录(OUUUT_MCP_RUNS_DIR 可改),仓库里的 /runs/ 已 gitignore
node tools/verify-mcp-session.mjs --headless [--profile-kind persona]   # 真链路冒烟(协议 + 轨迹)
```

⚠️ 服务端驱动的是**带身份的真浏览器**:默认只绑 loopback、必须带令牌;`--no-auth` 只在 loopback 下允许。

发布包**自带** JS(入口 `ouuut.mjs` + `js/` 下的原生层与 harness),且这些文件**进清单与签名** ——
形态与理由见 **ADR-017**。验收(会验签 + 逐文件哈希 + 冷启动,`--smoke` 还会真开一次浏览器):

```bash
node tools/verify-shipped-layout.mjs --dir dist/ouuut-<版本>-win-x64 --pub <公钥.pem> [--smoke]
```

## 端到端实测(2026-10-25,装好的 0.1.3)

```
version  = Chrome/156.0.8078.47
tab      = { targetId: "CBAAA757..." }
snapshot = 454 字符,含 heading "hello ouuut" / button "pay now"
```

链路:**验签 → 493 文件落地 → 起浏览器(命名管道,不开任何端口)→ 建标签页 → 快照拿到真文本**。

---

## M0 结论摘要(详见 `docs/M0-结论.md`)

同机同出口、`bot-detector.rebrowser.net` 16 项逐测:

| target | 红 | 黄 | 过 |
|---|---|---|---|
| `pw-naive`(协议脏/参数脏) | 6 | 2 | 8 |
| `patchright`(只修协议) | 3 | 2 | 11 |
| `pw-hardened`(只修参数) | 3 | 0 | 13 |
| **`patchright-hardened`(都修)** | **2** | **0** | **14** |
| `cloak`(商业,含内核补丁) | 1 | 2 | 12 ⚠️ 分母 15 |
| **`ego`(现成「进程内通道」实证)** | **0** | **0** | **16 全绿** |

⚠️ `cloak` 的 `storagePartitioning` 因内核 146 **未评分**,它的分母是 **15**。
同分母 15 项下:`cloak` 1 红 2 黄 vs `patchright-hardened` 2 红 0 黄 —— **各有胜负**。
关键差别在红项性质(它的零成本可修,我们的只能靠内核)。详见 `docs/M0-结论.md` §1.1。

- 协议层与启动参数层**正交**,两者都必要 → **不能**只做其中一个
- **都不需要自研 IPC 协议栈** → F17 从 4–6 周降级为 **≤1 周**
- 剩余 2 项红(`useragent` / `headless`)是**内核品牌与无头标识** → 归 M1
- **`ego` 全绿证明全绿可达**,且给出三层的具体形态(版本真、品牌伪装成 Google Chrome)
- 独立发现:我方候选**泄漏 WebRTC**(4 个公网候选),Cloak 为 0 → ADR-014

---

## 真相源指针(别在每个文件里找答案)

| 我要知道 | 去这里 |
|---|---|
| 每个事实的正本是谁 | `docs/00-真相源索引.md` ← **先看这个** |
| 做什么、不做什么 | `docs/功能范围.md` |
| 为什么做(每条动作对应哪条竞品缺点) | `docs/竞品缺点-切入点对照.md` |
| 对抗什么(检测靶子) | `docs/附录A-检测面清单.md` |
| 怎么做(架构、里程碑定义、工期) | `docs/方案-v3-终稿.md` |
| 做到哪了(状态与证据) | `docs/里程碑.md` |
| 为什么这么定(ADR) | `docs/决策记录.md` |
| 什么是绝对不许做的 | `docs/法律红线.md` |
| 本机路径、工具、凭据 | `docs/环境与资产.md` |
| 踩过的坑 | `docs/坑与解法.md` |
| JS harness ↔ 内核的接缝规格 | `docs/原生层接口.md` |
| 每个内核补丁改哪个文件哪一行 | `docs/补丁点位.md` |
| 接手先看什么(没做完的、没验过的) | `HANDOFF.md` |
| 给 agent 的操作手册 | `AGENTS.md` |

---

## 已拍板的四件事(2026-10-24)

| # | 决策 | ADR |
|---|---|---|
| 1 | 许可证 = **Apache-2.0** | ADR-001 |
| 2 | 仓库 = 本地生产根 + **GitHub/Gitea 双远端**(private 起步) | ADR-002 |
| 3 | 第一刀 = **M0 取证先行**(1 周,决定 4–6 周的分支去留) | ADR-003 |
| 4 | harness = **fork ego lite 的 MIT harness**,自写原生层 | ADR-004 |

---

## 进度快照

见 `docs/里程碑.md`(唯一正本)。当前:

- **骨架** — ✅ 已验收(GitHub `nakamotosai/ouuut-browser` private / Gitea `sai/ouuut-browser` private)
- **M0 取证** — ✅ 核心目标达成(F17 = ADR-012);**Turnstile 探针 / creepjs 口径 / 机房出口三条均已落地**
  (逐轮实测与「能说到什么 / 不能说到什么」见 `docs/里程碑.md` M0 与 `docs/M0-结论.md`)
- **M1 底座** — ✅ 可复现(全量构建 + 补丁 0004 实测生效,见 `docs/坑与解法.md` 坑-29)
- **M2 harness** — ✅ 多帧快照(OOPIF 真取树)· list 角色诚实 · `maxResultLength` 按重要性挑选
- **M3 档案引擎** — ✅ 三种 kind(real / persona / disposable)+ 硬隔离
- **M4 通道** — ✅ CDP 命名管道 + WebRTC 自检 `ouuut.auditWebrtc()`
- **M5 无头 / 服务器** — ✅ 有头无头同一套参数 + 多机编排;真服务器实跑待做
- **M6 行为** — ✅ 内容驱动节奏,停留时间与长度相关性 r=0.91~0.96
- **M7 分发** — ✅ Ed25519 签名 · 原子更新(真升真回滚验过)· 材料审查闸 · **端到端跑通**;
  ⚠️ 「第三方可复现构建」**未完成**(R2 干净 VM 没做,不拿 R1 冒充)
- **P3 轮换** — ✅ **档案级租约**(ADR-018):轮换单位 = 一个档案的一次会话,中途绝不换出口;
  两个活着的档案不共用出口;长期身份不轮换。真机三场景验过
- **P9 零遥测** — ✅ 直连(解析层映射 `~NOTFOUND`)+ 走代理(**出口闸**:本地 SOCKS5,命中回连名单当场拒)
- **全量回归** — **Windows 全绿(0 跳过)**;Linux(`vps-jp`)**红恒为 0**(跳过数取决于 harness `dist/` 是否就位:缺席 6 条 / 就位 2 条);真 Chromium 已在 Linux 上跑通(快照含 `hello ouuut` / `pay now`,零监听端口)

---

## 一句话差异化

**CloakBrowser 有隐身但没有身份和可信度;ego lite 有身份和 agent 界面但零隐身、零隔离、
上不了服务器。把两边的强项放进同一个「档案」抽象里,就得到市场上不存在的东西。**

最大的加速杠杆:ego lite 的 harness 是 **MIT** 许可的,可以直接 fork;
原生层(闭源部分)我们干净室重实现。
