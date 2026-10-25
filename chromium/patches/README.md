# chromium/patches —— 自有补丁集

> **现状:已有 2 个补丁**(2026-10-24),均已实测 `git apply --3way` 干净应用。
> 点位依据见 `docs/补丁点位.md`(真相源 #12)。

| 补丁 | 改什么 | 验收 |
|---|---|---|
| `0001-ua-remove-headless-token.patch` | 去掉 `GetUserAgentInternal()` 里往 UA 插的 `Headless` | `bot-detector` 的 `headless` 项转 🟢;**同时覆盖 Web Worker** |
| `0002-ua-force-google-chrome-brand.patch` | `navigator.userAgentData.brands` 里强制出现 `Google Chrome` | `bot-detector` 的 `useragent` 项转 🟢 |
| `0004-cdp-named-pipe.patch` | **通道**补丁:`AdoptHandle()` 除整数值句柄外,**也接受命名管道路径** | Node 侧可用纯 JS 走 `--remote-debugging-io-pipes`,**依然不开任何端口**(ADR-005);`cdp-pipe.test.mjs` 的 16 条用例在 Windows 上真的跑在命名管道上 |

### 为什么需要 `0004`

上游 `--remote-debugging-pipe` 在 **POSIX** 上走 fd 3 读、fd 4 写 —— Node 的 stdio 能直接给。
但 **CRT 文件描述符是每个进程自己的表**:父进程在 `CreateProcess` 时能继承 HANDLE,
**却无法给子进程装出 fd 3/4**。于是任何用 Node / Python / Go 的父进程在 Windows 上都走不通
这条路(实测:浏览器启动阶段就退 0、零输出 —— `docs/坑与解法.md` 坑-29)。

Windows 专用的 `--remote-debugging-io-pipes` 本来只收**句柄的整数值**,而 JS 层拿不到 HANDLE。
`0004` 让它在数字解析失败时把字符串当**命名管道路径**去 `CreateFileW` —— 父进程侧于是
纯 JS 可实现,且**全程不监听任何端口**,ADR-005 完好。

> ⚠️ `0003-vs-toolchain-sdk-version-env.patch` 在下面的旧表里提到过,但**文件实际不存在**
> (构建时未落地)。编号保留不复用,避免与未来重放的补丁撞号。


两个 UA 补丁改的是**同一个文件**(`components/embedder_support/user_agent_utils.cc`),
但 hunk 分别在 162 行与 215 行,**相隔 53 行、互不干扰** —— 已实测按顺序 `--3way` 应用成功。

**`0003` 是「构建基础设施」补丁,与前两个性质不同**:前两个改**产品行为**,
它只让**构建在本机工具链上跑得起来**。所以它设计成**环境变量驱动**:
没有环境变量时逐字节等于上游 —— 这样它在未来 rebase 时最容易重放,
也不会悄悄改变别人构建出来的产物。

**为什么先于首次构建就写出 UA 补丁**:那两个点位是 M0 实测**精确定位**的(不是猜的),
源码树在本地,`git apply --check` 能立刻验证。早写早暴露补丁本身的问题。

---

## 命名与顺序

```
0001-<一句话说明>.patch
0002-<一句话说明>.patch
```

- 文件名前缀 = `tools/20-rebase.sh` 的应用顺序(字典序)
- 一个补丁只做一件事;说明写清楚,**不写「fix」这种废话**
- 用 `git diff` 生成,`git apply --3way` 能干净应用
- 每个补丁头部加一段说明:解决什么、依据在哪、上游是否已修

## 硬规则(来自项目门规与 M0 实测)

1. **不改 UA 版本号** —— 版本必须等于内核真版本,否则特性检测对不上(ADR-006 细化)
2. **可以把品牌改成 `Google Chrome`,并去掉 headless 标识** —— 这是必需的(M0 §2.2)
3. **绝不加入任何遥测 / 上报 / 崩溃上传 / 设备标识**
4. **绝不加入任何绕过验证码或定向绕过某站的逻辑**(法律红线 L3)
5. 与检测相关的补丁,**必须在 `docs/M0-结论.md` §2.3 的「修复责任分工表」里有对应行**

## 第一批补丁(目标,来自 M0 实测)

| 待解决 | 依据 | 归 M1 的理由 |
|---|---|---|
| `userAgentData.brands` 里要有 `Google Chrome` | `docs/M0-结论.md` §2.2;ego 的实测形态 | 纯 Chromium 不带这个品牌,`pw-*` 三个 target 全红 |
| UA 去掉 `HeadlessChrome` | 同上 | Playwright/Chromium 无头模式的固有标识 |
| **Web Worker 里的 UA 也要去掉 headless** | `docs/M0-结论.md` §1.3(creepjs) | **实测**:`patchright-hardened` 在主文档侧已被 `channel="chromium"` 修好(`noChrome` 等 tell 全 false),但 creepjs 仍抓到 **worker UA 带 headless**,等级 38%(未修的是 88%)。**只改主文档 UA 不够** |
| 补 `window.chrome`(无头时缺失) | M0 §2.2 | headless-shell 特征 |
| WebGL 渲染器不要是 SwiftShader | 同上 | 软件渲染一眼假 |

**注意**:`navigator.webdriver` / `--disable-ipc-flooding-protection` /
`--disable-popup-blocking` / `ThirdPartyStoragePartitioning` / `viewport` / **WebRTC**
这六项**不需要补丁** —— 它们在**启动参数层**解决,成本是几行配置(见 ADR-012 / ADR-014)。
