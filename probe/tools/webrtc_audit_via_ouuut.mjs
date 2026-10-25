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

const v = (await ouuut.getBrowserVersion()).currentVersion;
console.log("__VERSION__ " + JSON.stringify(v));

// ⚠️ **`ok === false` 时 `counts` 全是 0、`leaks` 是空数组** —— 那表示"没量成",
// **不是**"公网候选 = 0"。所以这里额外打一条显式的判定,并在失败时给非零退出码,
// 免得把"没量成"当成"通过"写进任何记录里(ADR-014 的判据只能是 `ok === true && public === 0`)。
if (r.ok && r.counts.public === 0) {
  console.log("__VERDICT__ PASS(公网候选 = 0;mDNS .local 属缓解,不算泄漏)");
} else if (!r.ok) {
  console.log("__VERDICT__ NOT_MEASURED(自检没跑成 —— 不能当成通过):" + r.error);
  process.exitCode = 1;
} else {
  console.log("__VERDICT__ FAIL(公网候选 = " + r.counts.public + ",判失败):" + JSON.stringify(r.leaks));
  process.exitCode = 1;
}
