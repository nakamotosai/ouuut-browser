# REA 任务 · 逆向分析 ego lite 浏览器(Citro Labs)

## 目标文件

Windows PE 文件,均位于 `<你的家目录>\AppData\Local\Citro Labs\ego lite\Application\`:

| 文件 | 大小 | 说明 |
|---|---|---|
| `0.6.0.22\chrome.dll` | 323 MB | 疑似 Chromium 主模块 |
| `0.6.0.22\chrome_elf.dll` | 111 MB | **尺寸异常**(正常应 1–2 MB),重点查它嵌了什么 |
| `0.6.0.22\ego-browser.exe` | 3.6 MB | CLI(在 PATH 上,`ego-browser`) |
| `ego.exe` | 4.3 MB | 主程序 |
| `0.6.0.22\local-ego-daemon\` | — | 未知本地守护进程,查全部文件 |
| `0.6.0.22\ego-skills\` | — | 技能目录,查结构 |

已知:`ego-browser --version` 报告 `0.6.0.22 / chromium 154.0.8037.44 / node v24.21.0`。

## 需要回答的问题(按重要性排序)

1. **【最关键】它的浏览器自动化通道是什么协议?**
   CDP(Chrome DevTools Protocol)?自研协议?命名管道(named pipe)?本地 WebSocket?
   请找出:协议名、监听地址/端口/管道名常量、消息格式字符串、JSON 字段名。
   特别确认:**它是否使用 `Runtime.enable`**(这是被 Cloudflare/DataDome 重点检测的命令)。

2. **Chromium 基底版本与定制程度。**
   它是不是在 Chromium 基础上打过补丁的私有 fork?找出:版本字符串、构建配置标志、
   与官方 Chromium 差异的证据(新增的模块/符号/字符串)。

3. **是否编译进反检测/指纹伪装能力?**
   搜索 `fingerprint` / `spoof` / `canvas` / `webgl` / `webrtc` / `timezone` /
   `useragent` / `stealth` / `automation` 相关字符串与符号。有无 `--fingerprint-*`
   之类的命令行开关?

4. **`chrome_elf.dll` 为什么有 111 MB?**
   它嵌入了什么?是否有打包的 Node.js 运行时、Python、模型权重、或其他大体积资源?
   给出证据(节表、嵌入资源、字符串分布)。

5. **`local-ego-daemon` 是什么?**
   它做什么?监听什么端口/命名管道?暴露什么 API?是否随浏览器常驻?

6. **`ego-skills` 目录里是什么?** 列出结构与格式(skill 定义文件?Markdown?JSON?)。

7. **网络端点。** 提取遥测、自动更新、许可校验的域名/IP 常量。有无 `update_telemetry.json` 的对应代码?

8. **代码签名。** 签名主体是谁?证书链是否可信?是否使用 EV 证书?

9. **原生集成接口。** 是否导出可用于第三方集成的接口(导出函数、COM 接口、IPC 端点、
   本地 HTTP/WebSocket 服务)?

## 硬约束

- **只做只读静态分析。** 不运行浏览器实例;不修改、不移动、不删除任何文件。
- 不要清空任何 cookie / 缓存 / 存储。
- 每条结论必须挂 REA Evidence id(或命令 + 产物路径 + digest)。

## 交付形态

按报告格式产出:1) 结论 2) 证据 3) 限制与未知 4) 可复现步骤。
把报告全文写进工作目录的 `REA-REPORT.md`,并在最终回复里也给全文。
