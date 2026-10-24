"""probe.targets —— 被测对象适配器。

每个模块暴露一个 `launch(spec: LaunchSpec)` 上下文管理器,并把自己注册进
`probe.base` 的注册表。文件名以 `_` 开头的不会被执行器扫描为 target(只作共享代码)。
"""
