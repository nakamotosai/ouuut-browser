// probe/tools/phone_home_blocked_via_ouuut.mjs —— 回连域名是不是真的被挡住(P9 的解析层那半)
//
// 用法(仓库根):`node native/bin/ouuut.mjs nodejs --headless < probe/tools/phone_home_blocked_via_ouuut.mjs`
//
// 做法:拿那几个**回连域名**直接导航一次,看失败**类型**:
//   * `ERR_NAME_NOT_RESOLVED` ⇒ 解析层拦住了(连 DNS 都没查)✓
//   * `ERR_PROXY_CONNECTION_FAILED` / 别的 ⇒ 没被拦住(请求真的发出去了)✗
//
// ⚠️ 这条只覆盖**直连**(浏览器自己解析)。产品常态是走代理,而 Chrome 的 `socks5://` 本身就是
//    **远端解析** —— 那时域名交给代理去解,`--host-resolver-rules` 不生效,
//    拦截点应该在**代理侧的拒绝清单**(见坑-46)。

const HOSTS = [
  "update.googleapis.com",
  "clients2.google.com",
  "accounts.google.com",
  "www.google.com",
];

const t = await taskSpace("p9-phonehome");
const results = {};
for (const host of HOSTS) {
  const p = await t.newPage();
  try {
    await p.goto(`https://${host}/`, { timeout: 8000 });
    results[host] = "REACHABLE";
  } catch (e) {
    const msg = String(e?.message ?? e);
    results[host] = /ERR_NAME_NOT_RESOLVED/.test(msg)
      ? "BLOCKED_BY_RESOLVER"
      : msg.replace(/^page\.goto failed:\s*/, "").slice(0, 60);
    try {
      await p.close?.();
    } catch {
      /* 关不掉就算了 */
    }
  }
}

console.log("__PHONEHOME__" + JSON.stringify(results));
const blocked = HOSTS.filter((h) => results[h] === "BLOCKED_BY_RESOLVER");
if (blocked.length === HOSTS.length) {
  console.log("__VERDICT__ PASS:四个回连域名在**直连**下都被解析层挡住(ERR_NAME_NOT_RESOLVED)");
} else if (blocked.length === 0) {
  console.log("__VERDICT__ FAIL:一个都没挡住 —— --host-resolver-rules 没生效");
  process.exitCode = 1;
} else {
  console.log(`__VERDICT__ PARTIAL:挡住了 ${blocked.length}/${HOSTS.length}:${JSON.stringify(blocked)}`);
  process.exitCode = 1;
}
