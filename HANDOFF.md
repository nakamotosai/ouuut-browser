# HANDOFF · ouuut 浏览器

> 写于 2026-10-25 收口。**代码侧 M0–M7 全部完成,端到端实测通过**。
> 剩下的三件事都不在代码侧,需要人/另一台机器。

---

## 一句话现状

装好的 0.1.3 能验签安装、能起浏览器(CDP 走命名管道,不开端口)、能建标签页、
能出带真文本的快照。全量回归 **306/306**,公开化闸 **0 违规**。

```
version  = Chrome/156.0.8078.47
tab      = { targetId: "CBAAA7578D2DDAA9B8184D785D904308" }
snapshot = 454 字符 → heading "hello ouuut" / button "pay now"
```

---

## Commands run(命令 + 真实返回)

| 命令 | 真实返回 |
|---|---|
| `node --test native/binding/*.test.mjs native/bin/*.test.mjs` | `# tests 306 / # pass 306 / # fail 0`(3.5 s) |
| `node tools/check-public-ready.mjs` | `✅ 可以公开:检查了 303 个受版本控制的文件,没有 ADR-010 材料或密钥` |
| 安装(`native/bin/ouuut-install.mjs`,验签后落地) | `493` 个文件 → `F:\apps\ouuut-browser\0.1.3`(约 2 s) |
| 冒烟(`.logs\run-smoke.ps1 -Script .logs\smoke.js`) | `has hello = true` / `has pay now = true` |
| `git log --oneline` | 头 = `69ceffb`(本轮 9 个提交) |

**怎么再跑一遍冒烟**(浏览器已经在 `F:\apps\ouuut-browser\0.1.3`):

```powershell
cd F:\projects\ouuut-browser
powershell -NoProfile -ExecutionPolicy Bypass -File .logs\run-smoke.ps1 `
  -Script ".logs\smoke.js" -Out ".logs\smoke-out.txt"
```

**注意**:本机的 shell 若被提权,`chrome.exe` 会自己降权重启、原进程退 0 ——
启动器已补 `--do-not-de-elevate --no-sandbox`(坑-29 补记三)。

---

## Not verified(没亲手验过,别当成已验证)

1. **OOPIF 真跨进程 iframe** —— 只有假对端演过(`fixtures/fake-cdp-peer.mjs` 的 `WITH_OOPIF`)。
   真 iframe 的 `Target.attachToTarget` + 跨 session ref 未在真浏览器上跑过。
2. **`ouuut.auditWebrtc()` 真跑** —— 逻辑有单测,真浏览器里的候选地址没采过。
3. **自动更新真链路** —— `applyUpdate()` 有单测(原子性、哈希、回滚),但没对真服务端跑过一次。
4. **无头模式** —— 参数与桌面同一套有断言,真无头起浏览器未跑(本机只有 Windows 桌面)。
5. **真服务器三种档案** —— M5 的验收项,需要 Linux/容器机器。
6. **第三方机器从零构建** —— M7 的验收项,本机只用「卸载 + 全新目录安装」替代验证。
7. **打包件里是否含最新 JS** —— JS 不在 543 MB 包里,跑的是仓库侧 `native/`。
   换言之:**0.1.3 是「浏览器 + 仓库侧 JS」的组合,不是单文件分发**。对外发版前要把这条定下来。

---

## Next safe action(只做这一件)

**在一台干净的 Linux 机器上跑一次最小闭环**(它同时覆盖 M5 与 M7 两条缺口):

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
| 代码 | `git reset --hard 9eab757`(M7 之前的最后一个提交) |
| ADR-010 移出的材料 | `F:\projects\_private\ouuut-browser-adr010\` 里有 `MANIFEST.md`(逐文件 sha256 + 来源提交),原样搬回即复原 |
| 构建树 | `out/` 已清空。重建 = `gn gen out/Release` + 全量构建(源码树 `chromium/src` 与 `patches/` 都在) |

---

## Confidence

**4 / 5** —— 扣分项:真浏览器上的 OOPIF 与 WebRTC 自检没跑过(都是「假对端绿、真环境未知」
的那一类,和坑-29 同一性质);分发形态(浏览器 + 仓库侧 JS)还没定。

---

## 今天这一轮到底改了什么(便于回溯)

| 提交 | 内容 |
|---|---|
| `69ceffb` | 坑-29 补记四:三个只有真浏览器能暴露的 bug |
| `db08b42` | 假对端按 target 类型给树(page 的 session 回主树) |
| `e4534f4` | 端到端跑通 + 三条回归用例(303→312) |
| `616d0b5` | 补丁 0004:写端 fd 改 `_O_WRONLY` |
| `c951b8a` | 补丁 0004 重新生成:加 `FILE_FLAG_OVERLAPPED` |
| `0f44427` | 坑-29 补记三:真凶是提权 |
| `9d8fa76` | 启动参数补提权会话的两个开关 |
| `be9eeea` | 坑-29 补记二:全量构建后管道连通 |
| `6d10bd4` | 坑-29 补记:根因是补丁从未编译进二进制 |
