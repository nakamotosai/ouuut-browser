# chromium/patches —— 自有补丁集

> **现状:目录为空。** 补丁要在**第一次成功构建之后**才落位 ——
> 先证明「能编出干净的基底」,再往上打补丁。顺序反了会分不清是补丁的毛病还是环境的毛病。

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
