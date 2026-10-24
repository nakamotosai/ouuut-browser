# 证据 · ego lite 网络调研(可追溯来源)

> 日期:2026-10-24 · 来源:独立调研分身 `EgoLiteResearch`(web research,只读)
> **本文件是 ego lite 全部「非本机实测」结论的来源凭证。**
> 凡 `docs/竞品缺点-切入点对照.md` 里标【官方】【第三方】的条目,引用本文件的编号。
> 本机取证另见 `local://ego-lite-forensic-report.md`。

---

## R1 · 项目与许可

| 项 | 值 | 来源 |
|---|---|---|
| 仓库 | `citrolabs/ego-lite` —— MIT,JavaScript,**19,017 star / 1,055 fork**,建成 2026-04-16 | `https://api.github.com/repos/citrolabs/ego-lite`(读取日 2026-10-24) |
| 许可正文 | MIT,`Copyright (c) 2026 CitroLabs` | `https://raw.githubusercontent.com/citrolabs/ego-lite/main/LICENSE` |
| **仓库只含 harness,不含浏览器本体** | 原文:"This repo contains the open-source harness and the agent skill package — **not** the browser itself. The ego lite app bundles its own `ego-browser` binary" | `https://raw.githubusercontent.com/citrolabs/ego-lite/main/AGENTS.md` |
| 官网 / 文档 | `https://lite.ego.app/` · `https://lite.ego.app/document/` | — |
| 定价 | 个人永久免费;Business 定制报价 | `https://lite.ego.app/enterprise` |
| 平台 | macOS + Windows(beta);Linux「planned,不再给日期」 | `https://lite.ego.app/download` · `https://lite.ego.app/roadmap` |
| 引擎 | Chromium 154.0.8037.44 + 内嵌 Node v24.21.0 | `https://lite.ego.app/changelog`(0.6.0.12,2026-10-15) |

## R2 · 服务条款红线(法律)

`https://lite.ego.app/terms` §3:

- 禁止 **reverse engineering、decompiling、disassembling、modifying、creating derivative works**;
- 禁止「bypassing usage restrictions **by any means, including but not limited to disguising your IP address, using proxy servers, or virtual private networks (VPNs)**」;
- 禁止把服务转售 / 转让 / 提供给第三方。

→ 据此定 L1 红线:**不在 ego 之上搭代理轮换/反检测产品**。

## R3 · 隐私政策 vs 宣传(用于 E4)

- 宣传:README「data collection deliberately narrow: simple product signals」;站点片段「No data collection. Privacy by architecture design.」
- 政策实际写明(`https://lite.ego.app/privacy`):**默认开启崩溃上报**(可退出)、**带用户与设备标识的用量分析**、安装/更新日志含标识、地址栏输入可能发往 Google、可能发送推广邮件、可能向商业伙伴/关联方/政府披露、保留「反对将你的个人数据用于训练我们的模型」的权利。
- 本机二进制**独立佐证**:见本机取证 §5.3(UMA / Sentry / Langfuse / 设备标识)。

## R4 · 关键 issue(用于 E2 / E3 / E7)

| 编号 | 标题要点 | 链接 | 状态 |
|---|---|---|---|
| **#319** | Task Space 里的 `Storage.getCookies`/`setCookies` **不是 profile 级作用域**:脚本在 Profile 6 读到默认 profile 的 **1,105 个 cookie** 并写入。维护者回复:"A space is not the same as a profile, and **spaces do not isolate cookies**." | `https://github.com/citrolabs/ego-lite/issues/319` | open |
| **#315** | 模型生成的 JS 跑在特权 Node 上下文,可调原始 CDP + 任意服务端出网 → prompt injection 可读 `HttpOnly` cookie 并外泄。维护者:"the behaviors you described do exist ... the part we are still debating is the security classification" | `https://github.com/citrolabs/ego-lite/issues/315` | open |
| **#303** | 从 Task Space 发 `Network.clearBrowserCookies` 会把用户主空间一起登出 | `https://github.com/citrolabs/ego-lite/issues/303` | open |
| **#445** | `--headless=new` 下 `navigator.userAgent` 与 UA 头都带 `HeadlessChrome`;x.com 返回 **HTTP 403**;改 `--user-agent` 与 `--window-size=1440,900` 可绕过 | `https://github.com/citrolabs/ego-lite/issues/445` | open |
| **#544** | Windows:更新器 `--restart` 后所有外部 URL 启动被静默丢弃(exit 0,无标签页,无日志) | `https://github.com/citrolabs/ego-lite/issues/544` | open |
| **#546** | Chrome 156 档案导入失败:`source_database_web_data_too_new`(Web Data v158 vs Chromium 154 的 v154) | `https://github.com/citrolabs/ego-lite/issues/546` | open |
| **#547** | Windows 关闭 UAC(`EnableLUA=0`):`ego-browser` exit 10,relay 拿不到中等完整性令牌 | `https://github.com/citrolabs/ego-lite/issues/547` | closed |
| #309 | 请求「限速/并发与反爬风险」指引,**0 回复,厂商未答** | `https://github.com/citrolabs/ego-lite/issues/309` | open |

## R5 · 第三方独立复核(用于 E6 与「最快」声称)

来源:独立实测(v0.5.0.28,2026-09-10)`https://www.heyuan110.com/posts/ai/2026-09-10-ego-lite-browser-review/`

| 项 | 官方声称 | 第三方实测 |
|---|---|---|
| 快照体积 | 「typical page fits in 200 to 400 tokens」(`https://lite.ego.app/document/en/docs/product-introduce`) | Hacker News 页:**7,823 tokens(视口)/ 11,867(整页)**;对比 agent-browser 4,742、Chrome DevTools MCP 13,418 —— **比 agent-browser 更大** |
| 「最快」 | 「47%–63% faster」(厂商自跑 31 任务 bench,harness 仓库 9 star,无独立复现) | HN 任务:16.4s / 2 轮 / $0.12 vs agent-browser 19.0s / 6 轮 → 确实更快;**但 Claude Code 默认权限模式下它最慢**:194.8s / 30 轮 / $0.751(heredoc JS 触发 Bash 防护);多页文档任务 40.5s vs 40.8s(**平手**) |
| 并发资源 | 6 个任务 ≈ 0.9 GB / 6 进程(vs 6 个独立浏览器 ≈ 15 GB / 84 进程) | 吻合:6 个 Space 实测 **+6 进程 / +0.91 GB RSS**,空闲回落 ~0.68 GB |
| Space 隔离 | 「one isolated BrowserContext ... with its own cookies and storage」 | **cookie 跨 Space 可读**(与 #319 相互印证) |

## R6 · 厂商自认

- 杀软误报:官方博客给出 VirusTotal 佐证与排除指引(`https://lite.ego.app/blog/how-to-troubleshoot-anti-virus-software-flagging-ego-for-windows-as-a-virus`)。
- README 的 `Reusable skills` 长期 `coming soon`(仓库首页 + `https://lite.ego.app/roadmap`)。
- 明确不绕过验证码:「Websites can still ask for a CAPTCHA ... ego(lite) does not bypass them」(`https://lite.ego.app/document/en/docs/product-introduce`)。

## R7 · 调研未覆盖(不得当作已知)

- 无独立的安全审计;无独立抓包验证遥测;**Reddit / 知乎 / X / linux.do 的情感分析因工具失败未做**。
- 厂商 31 任务 bench 无第三方复现。
- 本机安装的 0.6.0.22 不在公开 changelog(最新条目 0.6.0.15),行为可能与被复核的 0.5.0.28 有差异。
