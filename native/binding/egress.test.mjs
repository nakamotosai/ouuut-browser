// native/binding/egress.test.mjs —— 出口一致性(F6/P4)的验收
//
// 这一片的重点是**两个方向都要有**:
//   * 该拒绝时拒绝(画像 US + 出口 JP ⇒ 抛 `OUUUT_EGRESS_MISMATCH`);
//   * 该放行时放行(画像 JP + 出口 JP ⇒ 过),别把正常用法打死。
// 外加两条容易做错的边界:**台账里没有的 IP 不拒但要标"未核实"**、**越权开关必须在诊断里留痕**。

import test from "node:test";
import assert from "node:assert/strict";

import {
  EGRESS_COUNTRY_TABLE,
  EgressError,
  checkEgress,
  ipv4InCidr,
  lookupEgressCountry,
  measureEgressIp,
} from "./egress.mjs";

const JP_IP = "129.225.148.47"; // 台账里那条 pin-jp 出口
const HOME_IP = "124.211.130.95"; // 台账里那条"直连"出口

test("台账:命中已知段、不认识的不许猜、IPv6 一律「未核实」", () => {
  assert.equal(lookupEgressCountry(JP_IP).country, "JP");
  assert.equal(lookupEgressCountry(HOME_IP).country, "JP");
  assert.ok(lookupEgressCountry(JP_IP).source.includes("实测"), "每条台账都要能追到一次实测");
  assert.equal(lookupEgressCountry("8.8.8.8"), null, "不认识的 IP 必须返回 null,不许猜一个国家");
  assert.equal(lookupEgressCountry("2001:db8::1"), null);
  assert.equal(lookupEgressCountry(""), null);
  assert.equal(lookupEgressCountry(null), null);
  for (const e of EGRESS_COUNTRY_TABLE) assert.ok(e.source && e.cidr && e.country, JSON.stringify(e));
});

test("CIDR 判定:边界", () => {
  assert.ok(ipv4InCidr("10.0.0.1", "10.0.0.0/8"));
  assert.ok(ipv4InCidr("10.255.255.255", "10.0.0.0/8"));
  assert.ok(!ipv4InCidr("11.0.0.1", "10.0.0.0/8"));
  assert.ok(ipv4InCidr("1.2.3.4", "1.2.3.4/32"));
  assert.ok(!ipv4InCidr("1.2.3.5", "1.2.3.4/32"));
  assert.ok(ipv4InCidr("1.2.3.4", "0.0.0.0/0"));
  assert.ok(!ipv4InCidr("1.2.3.4", "1.2.3.4/33"), "非法掩码不许「碰巧」为真");
  assert.ok(!ipv4InCidr("1.2.3.4", "1.2.3.4"), "缺掩码 = 非法");
});

test("★ 该拒绝时拒绝:画像 US + 出口 JP ⇒ OUUUT_EGRESS_MISMATCH", () => {
  assert.throws(
    () => checkEgress({ measuredIp: JP_IP, identityCountry: "US" }),
    (e) => {
      assert.ok(e instanceof EgressError);
      assert.equal(e.error_code, "OUUUT_EGRESS_MISMATCH");
      assert.match(e.message, /US/);
      assert.match(e.message, /JP/);
      assert.match(e.message, /allow-egress-mismatch/, "要说清怎么越权,别让人去翻文档");
      assert.match(e.message, new RegExp(JP_IP.replace(/\./g, "\\.")), "要把实测 IP 说出来");
      return true;
    },
  );
});

test("★ 该放行时放行:画像 JP + 出口 JP ⇒ ok(两条:pin-jp 与直连)", () => {
  for (const ip of [JP_IP, HOME_IP]) {
    const r = checkEgress({ measuredIp: ip, identityCountry: "jp" }); // 大小写不该影响判定
    assert.equal(r.level, "ok");
    assert.equal(r.country, "JP");
  }
});

test("声明的出口国家与实测不符 ⇒ 同样拒绝(声明不能与事实脱钩)", () => {
  // 这条抓的是"你以为走了 A,其实走了 B"(坑-40 那一类静默走直连)
  assert.throws(
    () => checkEgress({ measuredIp: HOME_IP, declaredEgressCountry: "US" }),
    (e) => e.error_code === "OUUUT_EGRESS_MISMATCH",
  );
  assert.equal(checkEgress({ measuredIp: HOME_IP, declaredEgressCountry: "JP" }).level, "ok");
});

test("台账里没有的 IP:不拒,但必须标「未核实」(不许把没查到当成没问题)", () => {
  const r = checkEgress({ measuredIp: "8.8.8.8", identityCountry: "US" });
  assert.equal(r.level, "unverified");
  assert.equal(r.country, null);
  assert.ok(r.notes.join(" ").includes("未核实"));
  assert.ok(r.notes.join(" ").includes("8.8.8.8"), `带上 IP 才有线索:${r.notes.join(" ")}`);
});

test("越权开关:只在给了的时候放行,并且**必须在诊断里留痕**", () => {
  const r = checkEgress({ measuredIp: JP_IP, identityCountry: "US", allowMismatch: true });
  assert.equal(r.level, "overridden");
  assert.ok(r.notes.join(" ").includes("⚠️"), "越权要显眼");
  assert.ok(r.notes.join(" ").includes("US"), `说清谁跟谁不一致:${r.notes.join(" ")}`);
});

test("两条都不声明时:只报事实,不拒绝(没有身份可对,就没什么可拒)", () => {
  const r = checkEgress({ measuredIp: JP_IP });
  assert.equal(r.level, "ok");
  assert.equal(r.country, "JP");
});

test("量出口:用运行期 API 打开端点读 IP;读到的不是 IP 要报错(别把错误页当 IP)", async () => {
  const mk = (body) => ({ probeEgressIp: async () => body });
  assert.equal(await measureEgressIp(mk("  129.225.148.47 \n")), "129.225.148.47");
  await assert.rejects(() => measureEgressIp(mk("<html>错误</html>")), (e) => e.error_code === "OUUUT_EGRESS_PROBE_BAD_REPLY");
  await assert.rejects(() => measureEgressIp(null), (e) => e.error_code === "OUUUT_EGRESS_PROBE_UNAVAILABLE");
});
