# probe · M0 检测基准探针

> **M0 的唯一执行目录。** 目标不是「拿高分」,是回答一个**差分问题**:
> **「按住 `Runtime.enable` 是否已足够过检测」**(ADR-003 / ADR-005)。
> 契约纪律:见 `AGENTS.md`;方法纪律:见 ADR-011(同机同代理同时间窗)。

---

## 一、为什么是「对照矩阵」而不是「绝对分数」

绝对分数受网络、代理、检测站版本、时间影响极大。**差分**才能把「工具差异」从
「环境噪声」里分离出来。所以每次运行都产出**矩阵**,不是一个数字。

**唯一可信的比较方式**:同一轮运行内,所有 target 走**同一个出口**、同一时间窗。

---

## 二、出口(egress)

**resin 轮换池不能用于本探针** —— 实测 8 次请求换 8 个出口 IP,页面加载期就会出现
多个 IP,既是巨大噪声也是巨大破绽。

用**单个 `bind-socks5` 节点**(固定出口,实测 STICKY):

| 代号 | 出口 | 说明 |
|---|---|---|
| `direct` | 本机直连(JP 住宅/ISP 段) | 主要条件:最接近真实用户,CDP 信号最容易显出来 |
| `pin-jp-41105` | `socks5://198.51.100.7:41105` → `161.33.5.222` | 生产意图条件:机房段 |

`direct` 与 `pin-*` 都要跑 —— **若两边结论相反,那本身就是一个发现**(说明 IP 段压制了 CDP 信号)。

---

## 三、契约

### 3.1 被测对象(target)

每个 target 适配器实现 `probe/base.py` 的 `BrowserFacade`:

```python
def launch(spec: LaunchSpec) -> Iterator[BrowserFacade]   # 上下文管理器
```

`LaunchSpec` 的字段(**以 `probe/base.py` 为准**):
`target` / `egress`(出口对象,代理在 `egress.proxy` 上)/ `profile_dir`(每 target × 每 egress
一个干净档案)/ `out_dir` / `headless` / `timeout_ms`。

| 代号 | 被测对象 | 为什么在矩阵里 | 状态 |
|---|---|---|---|
| `pw-naive` | 裸 Playwright(chromium) | **基线**:发 `Runtime.enable`、留全部 CDP 痕迹 | ✅ |
| `patchright` | patchright(rebrowser 补丁的 Python 版) | **核心对照**:只修协议层 | ✅ |
| `pw-hardened` | 裸 Playwright + 修好的启动参数 | **核心对照**:只修参数层(与上面**正交**) | ✅ |
| `patchright-hardened` | 上面两者叠加 | **决定性格**:不写内核代码能走多远 | ✅ |
| `cloak` | CloakBrowser | 商业反检测对照(含内核补丁) | ✅ |
| `ego` | ego lite | 「进程内通道 + 不发 `Runtime.enable`」的实证(REA B1/B2) | ✅ |
| `ouuut` | 我方 | 自有 Chromium + 自有原生层(**M1 已建成**;驱动入口 `native/bin/ouuut.mjs`) | ⚠️ **适配器未写** —— P8 要做的事:加一个走本 CLI 的 target,才能取"干净读数" |

### 3.2 检测站(site)

每个 site 实现:

```python
class Site:
    name: str
    url: str
    def run(self, br: BrowserFacade) -> tuple[str, dict]   # (verdict, detail)
```

`verdict` 只允许三个值:**`passed`** / **`detected`** / **`error`**。
`detail` 放原始证据(检测站自己报的字段),不许只放结论。

| 代号 | URL | 回答什么 |
|---|---|---|
| `bot-detector` | `bot-detector.rebrowser.net` | **最直接**:CDP 泄漏项逐条 |
| `creepjs` | `abrahamjuliot.github.io/creepjs` | **headless 轴** —— 读 `Headless` 段的**等级**(≥ 50% 判 detected,等级优先)+ 布尔 tell(兜底)。**不是** trust score:该站没有这个东西 |
| `browserleaks` | `browserleaks.com` | WebRTC / Canvas / WebGL / 字体 |
| `turnstile` | Cloudflare Turnstile demo | 实战门槛(免交互会不会被放行)。**只观测、不交互**(红线 L3);官方 dummy demo 要识别并判 `error`(它不做评分) |

### 3.3 产物

```
probe/out/<run-id>/
  matrix.json          # 全部结果
  matrix.md            # 人读表格
  screenshots/<target>-<site>-<egress>.png
  run.log
```

`matrix.json` 每行 = 一个 `probe.base.Result`。

### 3.4 直接可跑的工具(不起探针框架)

```bash
python probe/tools/check_creepjs_classify.py                     # 判据自查:13 条,13/13 通过
node  native/bin/ouuut.mjs nodejs --headless --timeout 60 \
      < probe/tools/clean_reading_via_ouuut.mjs                  # 用自己的驱动取 bot-detector 干净读数
node  native/bin/ouuut.mjs nodejs --headless --timeout 60 \
      < probe/tools/webrtc_audit_via_ouuut.mjs                   # auditWebrtc 真跑(判据:公网候选 = 0)
```

为什么要单独放这些文件:**判据与自检本身也会错**,而它们错起来是"假绿"。
2026-10-25 的核验抓到过 `creepjs._classify` 守卫的两版毛病(防假绿造出假红、盖不住名单外键),
当时那些用例只在对话里 —— 说话不能当证据,于是落盘。
凡是"从文本抽取再据此下结论"或"我提供一个自检 API"的地方,都应配一份**直接可跑**的用例。

---

## 四、运行

```bash
PY=probe/.venv/Scripts/python.exe
$PY probe/run.py --targets pw-naive,patchright --sites bot-detector --egress direct
$PY probe/run.py --all            # 全矩阵
```

**回归纪律**:任何 target 或 site 的改动,必须重跑并对比 `matrix.json` 的差异;
结果变化要能解释。

---

## 五、红线

- 本目录的脚本**只用于自检与竞品对照**,不针对任何真实业务站点
- **不做**验证码破解、不做定向绕过(法律红线 L3);`turnstile` 站点只用来**观测**
  我方是否被拦,**不实现任何破解逻辑**
- 探针每次使用**全新的空档案**,不携带任何登录态
