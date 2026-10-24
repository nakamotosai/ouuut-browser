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

## 二·五、本机实测的工具链配方(**2026-10-24 全部验证过**)

> 这一节是踩了 7 次之后回填的。**照它做,别照 Chromium 官方文档做** ——
> 官方文档假设你装的是标准 VS 与标准 SDK,而本机两样都不是。
> 每一关的完整取证见 `docs/坑与解法.md` 坑-21。

### 一次性:装对组件

```powershell
# ① C++ 工作负载 + SDK + **ATL**(ATL 不在 includeRecommended 里,必须显式加)
#    用 bootstrapper,**不要用 vs_installer modify**(见下方「不要做什么」)
& "$env:TEMP\vs_BuildTools.exe" --quiet --wait --norestart --nocache `
    --add Microsoft.VisualStudio.Workload.VCTools `
    --add Microsoft.VisualStudio.Component.Windows11SDK.26100 `
    --add Microsoft.VisualStudio.Component.VC.ATL `
    --includeRecommended
```

```powershell
# ② SDK 的 Debugging Tools —— VS 组件里没有,catalog 里也没有单独的组件。
#    它只硬要求一个文件:dbghelp.dll。SDK **自己**的 App Certification Kit 里就有。
$d = 'C:\Program Files (x86)\Windows Kits\10\Debuggers\x64'
New-Item -ItemType Directory -Force $d | Out-Null
Copy-Item 'C:\Program Files (x86)\Windows Kits\10\App Certification Kit\DbgHelp.dll' "$d\dbghelp.dll" -Force
Copy-Item 'C:\Program Files (x86)\Windows Kits\10\App Certification Kit\symsrv.dll'  "$d\symsrv.dll"  -Force
```

### 每次构建:四个环境变量 + 两个 unset

```bash
export DEPOT_TOOLS_WIN_TOOLCHAIN=0
export vs2022_install="C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools"
export OUUUT_WINDOWS_SDK_VERSION="10.0.26100.0"
export OUUUT_NTDDI_VERSION="NTDDI_WIN11_GE"
unset PYTHONUTF8 PYTHONIOENCODING
```

四个变量**都已写进 `tools/20-rebase.sh`**,正常情况下你不需要手动设。
两个 `unset` 也在脚本里。

### **不要做什么**(都是实测撞过的墙)

| 不要 | 为什么 |
|---|---|
| 用 `vs_installer.exe modify --add ...` 补装组件 | 本机 VS 实例**未正确注册**(注册表 `Setup\instanceIds` 为空),它认不出命令 → **退 87 并打印用法帮助**。用 bootstrapper |
| 在 gn args 里写 `visual_studio_path` 等 | 那条分支**上游客是坏的**(`visual_studio_runtime_dirs` 列表 vs 消费者要字符串)→ `This is not a string`。用两个环境变量让自动探测工作 |
| 用 `vswhere -products *` 判断 VS 装没装 | 本机**看不到**这个实例。要查 `cl.exe` 与 SDK 目录**实体** |
| 构建时带着 `PYTHONUTF8=1` | `set_appcontainer_acls.py` 不指定编码读 `icacls`(本机输出 GBK)→ `UnicodeDecodeError` |
| 直接装 SDK 10.0.28000(上游钉的版本) | `vs_installer --add ...Windows11SDK.28000` 退 87;VS catalog 里也没有。想装得走 NuGet(`Microsoft.Windows.SDK.CPP` 有 `10.0.28000.2705`)—— 见坑-21 |

---

## 二·六、跑通 M1 的完整步骤

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

它按顺序做(共 7 个阶段):

| 阶段 | 做什么 |
|---|---|
| 1/7 | 前置检查(**含「`chromium/src` 必须是自己一个 git 工作树」的守卫** —— 否则 `git checkout -f` 会误改本项目工作区) |
| 2/7 | `gclient sync` 到目标版本(tag 与 commit SHA 两种输入分别处理) |
| 3/7 | 依次 `git apply --3way` 应用 `chromium/patches/*.patch`(**按文件名排序**) |
| 4/7 | `gn gen out/Release` |
| 5/7 | `autoninja -C out/Release chrome` |
| 6/7 | **冒烟**:启动产物取版本 |
| 7/7 | 写 `chromium/UPSTREAM`(**原子替换**;冒烟不过就不写,免得留下假锚) |

**补丁失败即中止**,并打印冲突文件 —— 不静默跳过。

---

## 三、尚未验证的前提(第一次实跑前必读)

脚本是照 Chromium / ungoogled-chromium 的公开流程写的,但**本机没有工具链,一行都没真跑过**。
以下每一条都可能需要现场调整:

- [ ] `winget` 的 VS Build Tools 包 ID 与工作负载 / SDK 组件 ID 在当前版本上有效
- [ ] **`.gclient` 手写模板可用** —— `10-fetch-chromium.sh` 没有走 `fetch chromium`,
      而是自己写了 `.gclient`(内容与 `fetch chromium` 生成的一致),让源码落在
      `chromium/src` 而不是 `chromium/chromium/src`。**这一点没人验证过**
- [x] ~~**blobless partial clone 能满足 `git apply --3way`**~~
      —— **前提已不成立,本条作废(2026-10-24)**:脚本实际用的是
      `git clone --branch <tag> --depth=1` 且**不带任何 `--filter`**(见
      `tools/10-fetch-chromium.sh`),所以该 commit 的 blob 全在本地、`--3way` 的基对象必然可用。
      实测:补丁以 `Applied patch to 'components/embedder_support/user_agent_utils.cc' cleanly.` 干净落地,无联网补 blob
      (见 `docs/坑与解法.md` 坑-22:浅克隆 + `--with_tags` 才是真陷阱,但那是 fetch 的问题,不是 clone 的)
- [x] ~~**`gclient sync --with_branch_heads --with_tags` 之后 `git HEAD` 是否仍是目标版本**~~
      —— **已解决(2026-10-24)**:那两个 flag **已被删除**(见 `docs/坑与解法.md` 坑-22),
      它们正是浅克隆下 `git fetch` 退化成「拉 29,397,996 个对象」的元凶。
      实测:裸 `gclient sync` 之后 `HEAD` **仍是** `1d17a2e2ee…`(= 目标 tag),checkout 未被改动
      (根因:`chromium/.gclient` 里 src 是 `"managed": False`,`gclient` 不碰它的 git 状态)
- [ ] **`gn args` 的完整清单** —— 是否该用 `is_official_build=true`;
      `symbol_level` 取值对构建时间与产物体积的影响
- [x] ~~**`chrome.exe --version` 在 Windows 上的行为**~~
      —— **已解决(2026-10-24)**:它确实是**无输出的 GUI no-op**(实测 `rc=0`、输出长度 **0**、
      `stdout` 空 —— GUI 子系统二进制没有附着的控制台)。
      所以第 6 步的冒烟已**改为读 PE 版本资源**并做**真断言**
      (`(Get-Item <chrome.dll>).VersionInfo.FileVersion`,实测给出 `156.0.8078.47`,与目标 tag 一致)。
      见 `docs/坑与解法.md` 坑-24
- [ ] **ungoogled-chromium 补丁集的取用方式** —— 是 clone 其仓库后跑 `utils/patches.py`,
      还是直接 `git apply patches/**`?本项目的 `chromium/patches/` 只放**我们自己的**补丁;
      上游补丁集怎么接进来,**尚未决定**(留到首次构建成功后处理)
- [ ] **首次构建的实际耗时与磁盘峰值**

**头一次跑通后,把上面的勾全部打上,并确认 `chromium/UPSTREAM` 有实测值** —— 那才算 M1 验收。

---

## 四、版本策略(ADR-006)

- **基线** = ungoogled-chromium 当前 stable tag,滚动跟随,约 4 周一版
- **不做 LTS**;**绝不靠改 UA 假装新版本**(版本号 = 内核真版本)
- **品牌**要伪装成 `Google Chrome`(版本真、品牌像)—— 见 `docs/M0-结论.md` §2.2
- 取证时的真实版本基线(2026-10-24):
  - Chrome stable(Windows)= `157.0.8103.15`
  - ungoogled-chromium 最新 tag = `156.0.8078.47-1`
  - 查询接口见 `docs/环境与资产.md` §五

---

## 五、补丁布局(尚未建立,等第 1 次成功构建后落位)

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
