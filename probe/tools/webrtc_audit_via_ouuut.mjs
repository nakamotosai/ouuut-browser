// probe/tools/webrtc_audit_via_ouuut.mjs —— `ouuut.auditWebrtc()` 的**真跑**(ADR-014 的验收)
//
// 用法(仓库根):
//   node native/bin/ouuut.mjs nodejs --timeout 60 < probe/tools/webrtc_audit_via_ouuut.mjs
//
// ADR-014 要求「抑制**真的生效**」,而不只是启动参数里有一行 —— 判据是:
// **出现公网候选即判失败**(mDNS `.local` 是缓解,不算泄漏;局域网地址降级为警告)。
// 本脚本打印原始候选,便于与 ADR-014 记录的那 4 条对比。

const r = await ouuut.auditWebrtc();
console.log("__WEBRTC__" + JSON.stringify(r));

// 顺带把「抑制开关到底在不在」也报出来 —— 免得只看结论而漏掉"开关根本没传"
console.log("__ARGS__ " + JSON.stringify(
  (await ouuut.getBrowserVersion()).currentVersion
));
