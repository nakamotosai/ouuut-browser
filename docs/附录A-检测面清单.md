# 附录 A · 检测面清单(设计的靶子)

> 日期:2026-10-24 · 来源:`rebrowser/rebrowser-patches` 官方文档、DataDome 公开研究、
> Camoufox/Patchright 项目文档、CreepJS/BrowserLeaks 公开测试项。
> **本清单是ouuut 浏览器所有功能的靶子:每一项都要有对策,或明确声明不管。**

---

## A1 · 协议层(CDP 泄漏) ← CloakBrowser 的最大缺口

| 检测项 | 原理 | 现状 | 我们的对策 |
|---|---|---|---|
| **`Runtime.enable` 泄漏** | 调用该命令会在页面上下文留下可探测痕迹。**Cloudflare、DataDome 等主流反爬都在用** | Playwright 默认必发 | 阶段 A:改用 `addBinding` 方式解析 context id(不调用 `Runtime.enable`);阶段 B:协议里不含该命令(**条件性工作,判据归 M0** —— REA 显示 ego 的自动化路径未发现自动发送该命令,若「按住即够」则阶段 B 不做) |
| **栈帧命名泄漏** | Puppeteer 注入 `//# sourceURL=pptr:...`;Playwright 经 `UtilityScript` 类执行 `evaluate`,页面 `new Error().stack` 可见 | 默认可见 | 随机化辅助类名 + 偏移行号;或自研通道不产生此类帧 |
| **执行世界名泄漏** | 默认世界名 `__puppeteer_utility_world__<版本>` | 默认可见 | 随机化世界名 |
| **启动开关泄漏** | `--disable-popup-blocking` / `--disable-ipc-flooding-protection` / `--disable-features=ThirdPartyStoragePartitioning` 会改变可观察行为 | Playwright 默认带 | 移除,恢复真实用户行为 |
| **`navigator.webdriver`** | 自动化启动即为 true | **实测修正(2026-10-24)**:Playwright 1.64.1 **默认无头**时 `navigator.webdriver === true` —— 因为默认走 `chrome-headless-shell`(详见 `docs/M0-结论.md` §1.1)。旧表述「1.64 起已移除 `--enable-automation` 故为 false」**已作废**:移除了开关不等于值为 false | 内核层硬编码为 false;驱动层可加 `--disable-blink-features=AutomationControlled`(实测生效) |

> ⚠️ **反直觉但关键**:JS 注入式隐身插件(`puppeteer-extra-plugin-stealth`)会让情况**变坏** ——
> 它会点亮 `nativeTampering` 与 `workerConsistency` 两项。ouuut 的补丁**必须在内核 C++ 层**,
> 不通过 Proxy / `Object.defineProperty` 改写页面对象。

## A2 · 指纹层(页面可见值)

| 类别 | 具体项 | CloakBrowser | 我们的要求 |
|---|---|---|---|
| Navigator | UA / platform / uaData / 语言列表 / 硬件并发 / 内存 | 有 | 有 + **一致性校验** |
| 屏幕 | `screen.*` / `outerWidth` / `devicePixelRatio` / 可用区 | 部分(实测分辨率未跟随时区改动) | 整组联动 |
| 图形 | canvas 图像 / canvas 文本 / WebGL 图像 / WebGL 元数据(GPU 厂商型号) | 有(实测 GPU 字符串会变) | 有 + 与平台不矛盾 |
| 音频 | AudioContext 指纹 | 有 | 有 |
| 字体 | 字体列表 / 字形度量 | 有 | 有 + **按 persona 演化** |
| 布局 | `getClientRects` / 滚动条宽度 | 有 | 有 |
| 媒体 | 编解码器 / 设备枚举 | 较少提及 | 需覆盖 |
| 网络 | WebRTC 内网/公网 IP | 有(需 `socksio`,否则静默降级) | 必装依赖 + 失败即拒绝启动 |

## A3 · 一致性层(矛盾检测)← CloakBrowser 完全没做

| 矛盾组合 | 后果 |
|---|---|
| UA 说 Windows,`navigator.platform` 说 Mac | 立即标记 |
| 时区 `Asia/Tokyo` + 出口 IP 在美国 | 立即标记 |
| 屏幕 1920×1080 + `devicePixelRatio` 2 + 窗口尺寸不匹配 | 中等 |
| GPU 报某型号,但 WebGL 渲染结果特征不符 | 中等 |
| `navigator.languages` 与 `Accept-Language` 请求头不一致 | **服务端可见**,极易被发现 |
| 字体列表是「全新装的 Windows」但历史记录很长 | 长期画像矛盾 |

## A4 · 行为层 ← CloakBrowser 是死算法

| 检测项 | 我们的目标 |
|---|---|
| 鼠标轨迹 | 非贝塞尔固定曲线,含抖动、过冲、修正 |
| 打字节奏 | 按键间隔服从人类分布;含错字-退格-重打 |
| 停留时间 | **与内容长度相关**(读长文更久) |
| 滚动 | 非等速;含回滚、暂停 |
| 空闲 | 存在无操作时段 |
| 标签页 | 存在后台标签、切换行为 |

## A5 · 网络层(浏览器管不了,但必须告知用户)

| 项 | 说明 |
|---|---|
| IP 信誉 | 机房 IP 段(如 resin)在大站默认降权;这是**权重最高**的单因素 |
| TLS/HTTP2 指纹 | 真 Chromium 走真 TLS;只有纯 HTTP 客户端(curl/requests)才需要 uTLS 对齐 |
| 请求头顺序 | 内核决定,一般正确;自研通道需保持 |

## A6 · 测量工具(M0 基准台)

| 工具 | 测什么 |
|---|---|
| `https://bot-detector.rebrowser.net/` | **CDP 泄漏专项**(`nativeTampering` / `workerConsistency` 等),正是我们的靶心 |
| CreepJS | 指纹欺骗痕迹(Proxy / defineProperty 检测) |
| BrowserLeaks(WebRTC / Canvas / Fonts / TLS) | 分项指纹与泄漏 |
| FingerprintJS 公开 demo | 商业级指纹稳定性 |
| Cloudflare Turnstile demo | 端到端放行率 |
| `bot.sannysoft.com` | 经典基线(老年份,仍可作冒烟) |

**M0 判据**:同一台机器、同一 resin 代理,对 CloakBrowser / 裸 Playwright /
`rebrowser-playwright` / 我们的补丁版跑上表,产出分数矩阵。
**预期结论(待验证,不可先信)**:CloakBrowser 在 `nativeTampering`、栈帧、
启动开关三项上被标记,`Runtime.enable` 项待测。

---

## A7 · 结论对架构的约束

1. 补丁必须在内核层 —— JS 注入会被 `nativeTampering` 抓到,越修越糟。
2. 一致性必须内建 —— 指纹单项伪装毫无价值,矛盾组合才是致命伤。
3. 行为必须内容驱动 —— 固定算法是可测的。
4. CDP 必须消灭或深度改造 —— 这是唯一无法靠「加参数」解决的一类。
5. IP 必须如实告知用户 —— 不夸大浏览器能解决的问题。
