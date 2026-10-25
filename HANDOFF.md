# HANDOFF · ouuut 浏览器

> 写于 2026-10-25 收口,**2026-10-25 经只读核验后修正**(见文末「核验记录」)。
> 代码侧 M0–M7 全部完成,端到端实测通过。剩下的都不在代码侧,需要人/另一台机器。

---

## 一句话现状

装好的 0.1.3 能验签安装、能起浏览器(CDP 走命名管道,不开端口)、能建标签页、
能出带真文本的快照。全量回归 **306/306**,公开化闸 **0 违规(304 个受控文件)**。

```
version  = Chrome/156.0.8078.47
tab      = { targetId: "CBAAA7578D2DDAA9B8184D785D904308" }
snapshot = 454 字符 → heading "hello ouuut" / button "pay now"
```

---

## Commands run(命令 + 真实返回)

| 命令 | 真实返回 |
|---|---|
| `node --test native/binding/*.test.mjs native/bin/*.test.mjs` | `# tests 306 / # pass 306 / # fail 0`(约 3.5 s) |
| `node tools/check-public-ready.mjs` | `✅ 可以公开:检查了 304 个受版本控制的文件,没有 ADR-010 材料或密钥` |
| 安装(`native/bin/ouuut-install.mjs`,验签后落地) | `493` 个文件 → `F:\apps\ouuut-browser\0.1.3`(盘上 494 = 493 + 运行时 `debug.log`) |
| 冒烟(`.logs\run-smoke.ps1 -Script .logs\smoke.js`) | `has hello = true` / `has pay now = true` / `EXITCODE=0` |
| `git log --oneline` | 头 = `3dec593`(收口后) |

**怎么再跑一遍冒烟**(浏览器已经在 `F:\apps\ouuut-browser\0.1.3`):

```powershell
cd F:\projects\ouuut-browser
powershell -NoProfile -ExecutionPolicy Bypass -File .logs\run-smoke.ps1 `
  -Script ".logs\smoke.js" -Out ".logs\smoke-out.txt"
```

该脚本走的是 **`--headless`**(`native/bin/launch-args.mjs` 翻成 `--headless=new`)。

**注意**:本机 shell 若被提权,`chrome.exe` 会自己降权重启、原进程退 0 ——
启动器已补 `--do-not-de-elevate --no-sandbox`(坑-29 补记三)。

---

## 已经在真浏览器上验过的(别再当"未验")

1. **端到端链路** —— 验签 → 493 文件落地 → 命名管道起浏览器 → createTab → 真快照。
2. **OOPIF 跨进程取树** —— `.logs/targets-out.txt` 里有
   `chrome-untrusted://new-tab-page/one-google-bar…` 的 `iframe` target、
   `Target.attachToTarget` 返回的真 sessionId,以及带该 session 取回的 AX 树;
   快照里出现 `[frame …]` 标记(该标记只在真 attach 成功且取回非空树时才生成)。
3. **无头模式** —— 上面那条冒烟就是 `--headless` 跑的,退出码 0 且拿到真快照。

---

## Not verified(没亲手验过,别当成已验证)

1. **`ouuut.auditWebrtc()` 真跑** —— 逻辑有单测,真浏览器里的候选地址没采过。
2. **自动更新真链路** —— `applyUpdate()` 有单测(原子性、哈希、回滚),没对真服务端跑过一次。
3. **真服务器三种档案** —— `--profile-kind real|persona|disposable` 需要 Linux/容器机器。
4. **第三方机器从零构建** —— 本机只用「卸载 + 全新目录安装」替代验证过。
5. **分发形态** —— 0.1.3 的 payload 里 **`*.mjs` = 0 个**:JS 跑的是仓库侧 `native/`。
   换言之这是「浏览器 + 仓库侧 JS」的组合,不是单文件分发。对外发版前要把这条定下来。

---

## Next safe action(只做这一件)

**在一台干净的 Linux 机器上跑一次最小闭环**(同时覆盖 M5 与 M7 两条缺口):

```bash
git clone ssh://git@vps-jp-gitea/sai/ouuut-browser.git && cd ouuut-browser
node --test native/binding/*.test.mjs native/bin/*.test.mjs      # 期望 306/306
node native/bin/ouuut.mjs --profile-kind disposable --headless \
     --version                                                    # 期望打印 Chrome/156.0.8078.47
```

跑通了就把结果贴进 `docs/里程碑.md` M5/M7 的「未完成」处并删掉对应条目。
**跑不通先看 `docs/坑与解法.md` 坑-29**(管道三个坑:提权 / overlapped / 写端 fd)。

---

## Rollback

| 动了什么 | 怎么退 |
|---|---|
| 装了浏览器 | 删掉 `F:\apps\ouuut-browser\0.1.3` 整个目录。不写注册表、不改 PATH、不留服务 |
| 代码(退到 M7 之前) | `git reset --hard 2f077ad`(M6 的提交)。**注意 `9eab757` 就是 M7 本体,不是「M7 之前」** |
| 代码(只退今天这一轮) | `git reset --hard 9eab757`(退掉端到端修复与收口文档,共 13 个提交) |
| ADR-010 移出的材料 | `F:\projects\_private\ouuut-browser-adr010\` 里有 `MANIFEST.md`(15 文件 / 6,296,162 B,逐文件 sha256 + 来源提交),原样搬回即复原 |
| 构建树 | **在 `chromium/src/out/Release`(26 GB),没被删**。`.ninja_log` 完整,改补丁后增量重建即可 |

---

## 构建树在哪(别再找错地方)

`chromium/src/out/Release/` —— `chrome.dll` 347,962,880 B @ 11:36 ·
`chrome.exe` 4,023,296 B @ 11:37。**仓库根的 `out/` 不存在**,别去那儿找。

---

## Confidence

**4 / 5** —— 扣分项:`auditWebrtc()` 与自动更新都没在真环境跑过(和坑-29 同一性质:
假对端绿、真环境未知);分发形态(浏览器 + 仓库侧 JS)还没定。

---

## 今天这一轮到底改了什么(便于回溯)

| 提交 | 内容 |
|---|---|
| `3dec593` | 真相源索引登记 HANDOFF |
| `d78bf5c` | 收口:README/里程碑回写 M7 实测 + 新增 HANDOFF |
| `69ceffb` | 坑-29 补记四:三个只有真浏览器能暴露的 bug |
| `db08b42` | 假对端按 target 类型给树 → **全量 306/306** |
| `e4534f4` | 端到端跑通 + 三条回归用例(该提交时全量 306 条,**其中 2 条红**,下一条修) |
| `616d0b5` | 补丁 0004:写端 fd 改 `_O_WRONLY` |
| `c951b8a` | 补丁 0004 重新生成:加 `FILE_FLAG_OVERLAPPED` |
| `0f44427` | 坑-29 补记三:真凶是提权 |
| `9d8fa76` | 启动参数补提权会话的两个开关 |
| `be9eeea` | 坑-29 补记二:全量构建后管道连通 |
| `6d10bd4` | 坑-29 补记:根因是补丁从未编译进二进制 |

---

## 核验记录(2026-10-25)

派了一个只读核验分身,逐条对照仓库真实状态查了 **31 条,10 条不成立**,已全部改正:

| 原说法 | 实际 |
|---|---|
| OOPIF「只有假对端演过」 | **真浏览器已跑通**(targets-out.txt + `[frame …]` 标记) |
| 无头「没跑过」 | **跑过**(冒烟脚本就是 `--headless`) |
| `9eab757` 是「M7 之前」 | 它就是 **M7 本体**;之前是 `2f077ad` |
| `out/` 已清空 | **在 `chromium/src/out/Release`,26 GB,没删** |
| 受控文件 303 / 300 | 现为 **304** |
| HEAD `69ceffb` | 现为 **`3dec593`** |
| `e4534f4`「303→312 用例」 | 该提交全量 306 条,2 条红 |
| `release.test.mjs` 19 条 | **26 条** |
| 材料 13 + 2 + 1 = 15 | 实际 **12 个 `re/ego-lite/` + 3 个 `docs/`** |
| 索引标题「十真相源」 | 表里 **12 行** |

另核:`dist/ouuut-0.1.3-win-x64/payload` 恰 493 文件;五份收口文档 grep 私钥/token 模式 **0 命中**。
