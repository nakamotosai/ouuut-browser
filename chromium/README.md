# chromium · M1 底座(构建流水线)

> **M1 的验收是:本机能启动;`rebase` 一条命令完成;第三方能复现同一二进制。**
> 本目录只放**构建脚本与补丁**,不放 Chromium 源码(源码由 fetch 脚本拉,已在 `.gitignore`)。

---

## 一、当前状态(2026-10-24 实测)

| 前置 | 状态 |
|---|---|
| 磁盘 | ✅ F: **608 GB** 可用(Chromium 全量构建约需 100–150 GB) |
| CPU | ✅ 24 逻辑核 |
| **Visual Studio 2022 Build Tools(含「使用 C++ 的桌面开发」)** | ❌ **未安装** |
| **Windows 11 SDK** | ❌ **未安装** |
| **depot_tools** | ❌ **未安装** |
| **管理员权限** | ❌ **当前 shell 非管理员** —— 装 VS Build Tools 会弹 UAC,**必须用户点确认** |

**结论:M1 目前卡在一个用户动作上** —— 见 §二 第 0 步。

---

## 二、跑通 M1 的完整步骤

### 第 0 步(需要用户):装工具链

```powershell
# 必须**以管理员身份**打开 PowerShell,然后:
tools\00-bootstrap-toolchain.ps1
```

它做两件事:
1. `winget install Microsoft.VisualStudio.2022.BuildTools` 并加上工作负载
   `Microsoft.VisualStudio.Workload.VCTools` + Windows 11 SDK
2. 拉 `depot_tools` 到 `F:\depot_tools` 并把它加进 PATH

**约束**:这一步会下载约 **7–10 GB**,耗时 **30–60 分钟**,可能需要重启。

### 第 1 步:取源码

```bash
tools/10-fetch-chromium.sh            # 取「当前 stable」对应的版本
tools/10-fetch-chromium.sh 156.0.8078.47-1   # 或指定 ungoogled 的 tag
```

约 **50 GB** 下载。

### 第 2 步:一条命令 rebase(**M1 的核心验收**)

```bash
tools/20-rebase.sh                    # 用 chromium/UPSTREAM 里记录的版本
tools/20-rebase.sh 157.0.8103.15-1    # 或换到指定版本
tools/20-rebase.sh --dry-run          # 只打印将要执行的动作,不落地
```

它按顺序做:
1. 记下当前 `chromium/UPSTREAM`
2. `gclient sync` 到目标版本
3. 依次 `git apply --3way` 应用 `chromium/patches/*.patch`(**按文件名排序**)
4. `gn gen out/Release`
5. `autoninja -C out/Release chrome`
6. 写新的 `chromium/UPSTREAM`(版本 + commit SHA + 补丁清单哈希 + 产物 sha256)

**补丁失败即中止**,并打印冲突文件 —— 不静默跳过。

---

## 三、版本策略(ADR-006)

- **基线** = ungoogled-chromium 当前 stable tag,滚动跟随,约 4 周一版
- **不做 LTS**;**绝不靠改 UA 假装新版本**(版本号 = 内核真版本)
- **品牌**要伪装成 `Google Chrome`(版本真、品牌像)—— 见 `docs/M0-结论.md` §2.2
- 取证时的真实版本基线(2026-10-24):
  - Chrome stable(Windows)= `157.0.8103.15`
  - ungoogled-chromium 最新 tag = `156.0.8078.47-1`
  - 查询接口见 `docs/环境与资产.md` §五

---

## 四、补丁布局(尚未建立,等第 1 次成功构建后落位)

```
chromium/patches/
  0001-<一句话>.patch        # 文件名前缀 = 应用顺序
  ...
```

规则(写进 `AGENTS.md` 的门规):
1. **一个补丁只做一件事**,文件名说清做什么
2. 每个补丁必须能在**下一个上游版本**上 `git apply --3way` 成功,或明确记录「已合并上游,可删」
3. **不改 UA 版本号**(只改品牌与 headless 标识,见 ADR-006 细化)
4. 与检测相关的补丁必须在 `docs/M0-结论.md` §2.3 的「修复责任分工表」里有对应行

**首次构建的目标补丁(来自 M0 实测,已定)**:

| 补丁要解决的问题 | 层级 | 依据 |
|---|---|---|
| `userAgentData.brands` 里要有 `Google Chrome` | 内核 | M0 §2.2(ego 的形态) |
| UA 去掉 `HeadlessChrome`;补 `window.chrome`;WebGL 不用 SwiftShader | 内核 | M0 §2.2 |

---

## 五、尚未验证(不掩饰)

本目录的脚本是**按 Chromium / ungoogled-chromium 的公开构建流程写的**,
但**尚未在本机真实跑通**(工具链未装)。第一次实跑时,以下必须逐项核对:

- [ ] `winget` 的 VS Build Tools 包 ID 与工作负载参数在当前版本上有效
- [ ] `gclient sync` 的目标版本写法(用 tag 还是 commit SHA)
- [ ] ungoogled-chromium 补丁集的**取用方式**(是 clone 其仓库后 `utils/patches.py`, 还是直接 `git apply patches/**`)
- [ ] `gn args` 的完整清单(是否用 `is_official_build=true`;`symbol_level` 取值对构建时间的影响)
- [ ] 首次构建的实际耗时与磁盘峰值

**头一次跑通后,把上面的勾全部打上,并把 `chromium/UPSTREAM` 填实** —— 那才算 M1 验收。
