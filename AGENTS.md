# AGENTS.md · ouuut 浏览器

本文件是**项目级操作手册**。全局规则(`~/.omp/agent/AGENTS.md`)仍然适用;此处只写
本项目特有的东西。**冲突时以本文件为准。**

---

## 一、项目心跳

- 生产根:`F:\projects\ouuut-browser`
- 真相源登记:`docs/00-真相源索引.md` —— **动手前先看它,别猜哪个文件说了算**
- 当前状态与「唯一 next」:**只认 `README.md`**
- 进度与验收证据:**只认 `docs/里程碑.md`**

---

## 二、门规(动手前必过)

### 2.1 三问(任何新功能/新文件/新依赖)

1. 它对应 `docs/竞品缺点-切入点对照.md` 的哪一行?**指不到 = 不在立项理由内。**
2. 它在 `docs/功能范围.md` 的「做」表里吗?**不在 = 默认不做。**
3. 它的验收第三方能复现吗?**不能 = 那不是功能,是愿望。**

三条都过不了还想做 → **先改文档,再写代码**。

### 2.2 法律红线(不可越过,详见 `docs/法律红线.md`)

- **L1** 不打包 / 不派生 / 不逆向复制任何第三方二进制
- **L2** 只 fork MIT / MPL / BSD 组件
- **L3** 不做自动过验证码、不做未授权认证系统访问

**本仓库任何代码、脚本、测试、示例都不得违反 L1–L3。** 提到就停,先问。

### 2.3 真相源纪律

- 每个事实只有**一个**正本文件(见 `docs/00-真相源索引.md`)
- 引用别的文件时**写路径,不复制内容**;发现复制 → 改成指针
- 改了事实 → 同时改正本 + 在 `docs/决策记录.md` 记一条(若属决策)

---

## 三、代码约定

### 3.1 目录

| 目录 | 放什么 | 不放什么 |
|---|---|---|
| `docs/` | 真相源与方案 | 不放代码 |
| `chromium/` | 构建脚本、补丁集、`UPSTREAM` 版本锚 | 不放 Chromium 源码(它由 fetch 脚本拉) |
| `harness/` | fork 的 ego MIT harness | 不混入原生层代码 |
| `native/` | 自写原生层(快照 / 通道 / 指纹) | —— |
| `probe/` | 检测探针与 M0 取证脚本 | 不放生产代码 |
| `tools/` | 构建、rebase、发布脚本 | —— |

### 3.2 构建

- **rebase 必须是一条命令**(`tools/20-rebase.sh`),这是 M1 的硬验收
- 任何手工步骤都要写进脚本;手工步骤 = bug
- 构建产物不入库;入库的是「能复现它的脚本 + 版本锚」

### 3.3 绝不

- 绝不写入任何遥测、上报、崩溃上传、设备标识
- 绝不把 `Runtime.enable` 加回默认路径(见 `docs/决策记录.md` ADR-005)
- 绝不为了过检测而伪造 UA 版本(UA 版本 = 内核真实版本)

---

## 四、验收与核验级别

按全局 `verify-tiering` 定级。本项目补充:

- **改内核/补丁/通道** → 必须过 `docs/里程碑.md` 里该里程碑的**可复现验收**,并在
  `docs/里程碑.md` 附证据(命令 + 输出摘要)
- **改文档** → 至少核对所有被引用路径仍存在(`grep` 一遍)
- **声称「过了检测站」** → 必须附**同机同代理**的分数矩阵 + 探针脚本版本

**禁止只跑测试就宣布完成。** 浏览器类改动必须真启动、真访问、真观测。

---

## 五、凭据

- 凭据一律在 `<凭据目录>\`,用 `python <你的家目录>/.omp/agent/scripts/secrets_manager.py`
  读(list / read / search / write)
- **禁止**把任何凭据值写进本仓库任何文件(含测试、示例、日志、commit message)
- `.gitignore` 已排除 `.env*`、`*.key`、`secrets*`

---

## 六、常用命令

```bash
# 读项目状态
cat README.md; cat docs/里程碑.md

# 构建(工具链未装,见 chromium/README.md §二)
tools/20-rebase.sh --dry-run          # 一条命令 rebase(干跑)
tools/20-rebase.sh <chromium-version> # 真跑

# M0 探针(已建成,契约见 probe/README.md)
probe/.venv/Scripts/python.exe probe/run.py --list
probe/.venv/Scripts/python.exe probe/run.py --all
```

**注意**:`bash` 按名字解析可能落到 WSL 启动器(见 `docs/坑与解法.md` 坑-1)。
脚本类调用一律写全路径:`"C:/Program Files/Git/bin/bash.exe"`。

---

## 七、和全局规则的关系

| 全局规则 | 本项目加强 |
|---|---|
| 禁止裸起 chrome/puppeteer | **进 M0 探针脚本时必须经 `probe/` 的统一入口**,便于登记与复现 |
| 交付给绝对路径 | 同 |
| 收工走 `sai-closeout` | 关项目走 `sai-closeout` + 更新 `README.md` 心跳与 `docs/里程碑.md` |
