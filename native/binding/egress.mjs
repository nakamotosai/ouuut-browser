// native/binding/egress.mjs —— 出口一致性(F6 / 工作包 P4)
//
// 要解决的问题:画像说"我是日本人",出口却在别的国家 —— 这是最容易把身份做废的一类错,
// 而且**它的失败方式是静默的**(坑-40 就是:代理参数配了、页面却落在默认 context,整场走直连)。
//
// ## 为什么用"台账"而不是通用 GeoIP
//
// 通用 GeoIP 要么发网络请求(把出口信息交给第三方)、要么背一个几十 MB 的库(许可证+体积都要谈)。
// 而这里真正要回答的问题只有一个:**"我们自己配的出口,是哪个国家?"** ——
// 出口是我们自己选的、数量是个位数,所以答案是**运营时核实一次、记在台账里**。
// 台账只覆盖 "我们实测过的段";**不认识的 IP 不拒**(见下),因此台账不全不会把正常用法打死。
//
// ## 判定策略(三条,都要有)
//
//   1. 画像国家 vs 实测出口国家 —— 不一致 ⇒ **拒绝启动**(`OUUUT_EGRESS_MISMATCH`);
//   2. 声明的出口国家 vs 实测出口国家 —— 不一致 ⇒ 同样拒绝(声明与事实不符,等于"你以为走了 A 其实走了 B");
//   3. 台账里**没有**这个 IP ⇒ 不拒,但明确标"未核实"(不能把"没查到"当成"查到了没问题",也不能因此拒绝正常使用)。
//
// 越权开关 `--allow-egress-mismatch`:只在**给了**的时候放行,并且把不一致写进诊断(标红)。

/** 出口国家的**台账**(不是通用 GeoIP)。每条都必须能追到一次实测。 */
export const EGRESS_COUNTRY_TABLE = Object.freeze([
  {
    cidr: "124.211.130.0/24",
    country: "JP",
    source: "2026-10-25 本机直连实测出口 124.211.130.95(KDDI/东京);用来抓「代理静默失效」",
  },
  {
    cidr: "129.225.148.0/24",
    country: "JP",
    source: "2026-10-25 实测 pin-jp `socks5://198.51.100.7:41105` 的出口 129.225.148.47(Oracle/大阪)",
  },
  {
    cidr: "161.33.5.0/24",
    country: "JP",
    source: "docs/下一步方案.md 记的 pin-jp 机房地址 161.33.5.222(Oracle/大阪,同 AS31898)",
  },
]);

/** 量出口 IP 用的端点:与 `probe/` 那套同源(见 `probe/tools/scan_pinned_egress.py`)。 */
export const EGRESS_IP_ENDPOINT = "https://api.ipify.org";

export class EgressError extends Error {
  constructor(message, { code = "OUUUT_EGRESS_MISMATCH" } = {}) {
    super(message);
    this.name = "EgressError";
    this.error_code = code;
  }
}

const isIpv4 = (s) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(s) && s.split(".").every((n) => Number(n) <= 255);
const toInt = (ip) => ip.split(".").reduce((acc, n) => acc * 256 + Number(n), 0);

/** `ip` 是否落在 `cidr`(只支持 IPv4 —— 我们的出口都是 IPv4;IPv6 一律走"未核实")。 */
export function ipv4InCidr(ip, cidr) {
  if (!isIpv4(ip)) return false;
  const [net, bitsRaw] = String(cidr).split("/");
  if (!isIpv4(net)) return false;
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return ((toInt(ip) & mask) >>> 0) === ((toInt(net) & mask) >>> 0);
}

/**
 * 查出口 IP 的国家。
 * @returns {{country: string, source: string, cidr: string}|null} 台账里没有就返回 `null`(**不是猜一个**)
 */
export function lookupEgressCountry(ip, { table = EGRESS_COUNTRY_TABLE } = {}) {
  if (typeof ip !== "string" || !isIpv4(ip.trim())) return null;
  const v = ip.trim();
  for (const e of table) if (ipv4InCidr(v, e.cidr)) return { country: e.country, source: e.source, cidr: e.cidr };
  return null;
}

const norm = (cc) => (typeof cc === "string" && cc.trim() !== "" ? cc.trim().toUpperCase() : null);

/**
 * 判定出口是否与身份/声明一致。
 *
 * @param {object} o
 * @param {string} o.measuredIp            实测到的出口 IP
 * @param {string} [o.identityCountry]     画像声明的国家(如 `JP`)
 * @param {string} [o.declaredEgressCountry] 运营者声明的**出口**国家(如 `JP`)
 * @param {boolean} [o.allowMismatch]      越权开关(`--allow-egress-mismatch`)
 * @returns {{ok: true, level: "ok"|"unverified"|"overridden", country: string|null, notes: string[]}}
 * @throws {EgressError} 不一致且没给越权开关
 */
export function checkEgress({
  measuredIp,
  identityCountry = null,
  declaredEgressCountry = null,
  allowMismatch = false,
  table = EGRESS_COUNTRY_TABLE,
} = {}) {
  const hit = lookupEgressCountry(measuredIp, { table });
  const wantIdentity = norm(identityCountry);
  const wantDeclared = norm(declaredEgressCountry);

  if (!hit) {
    return {
      ok: true,
      level: "unverified",
      country: null,
      notes: [
        `出口 IP ${measuredIp} 不在台账里 ⇒ **未核实**(不是"没问题"):台账只记我们实测过的段,` +
          `核对不上时按"不拒"放过,但要当它没验过。`,
      ],
    };
  }

  const mismatches = [];
  if (wantIdentity && wantIdentity !== hit.country) {
    mismatches.push(`画像国家 ${wantIdentity} ≠ 出口国家 ${hit.country}(IP ${measuredIp})`);
  }
  if (wantDeclared && wantDeclared !== hit.country) {
    mismatches.push(`声明的出口国家 ${wantDeclared} ≠ 实测出口国家 ${hit.country}(IP ${measuredIp})—— 声明与事实不符`);
  }
  if (mismatches.length === 0) {
    return { ok: true, level: "ok", country: hit.country, notes: [`出口 ${measuredIp} = ${hit.country}(${hit.source})`] };
  }

  const how = "要照旧跑:加 `--allow-egress-mismatch`(会在诊断里标出这次不一致);" + "或者把出口/画像换成同国。";
  if (!allowMismatch) {
    throw new EgressError(`出口与身份不一致,拒绝启动:\n  - ${mismatches.join("\n  - ")}\n${how}`);
  }
  return {
    ok: true,
    level: "overridden",
    country: hit.country,
    notes: [`⚠️ **越权放行**(--allow-egress-mismatch)`, ...mismatches],
  };
}

/**
 * 在**浏览器起来之后、脚本跑之前**量一次出口 IP。
 *
 * 为什么不在起浏览器之前量:那要自己实现 SOCKS/HTTP 代理握手(零依赖下是几百行协议代码),
 * 而"拒绝启动"的效果是一样的 —— 脚本一行都还没跑。量完这个页面就被扔掉(不碰目标站)。
 *
 * @param {object} api 运行期 API(`globalThis.<ns>`,由 `createOuUutRuntime()` 给)
 */
export async function measureEgressIp(api, { endpoint = EGRESS_IP_ENDPOINT, timeout = 20000 } = {}) {
  if (!api || typeof api.probeEgressIp !== "function") {
    throw new EgressError("量出口需要一个可用的运行期 API(api.probeEgressIp)", {
      code: "OUUUT_EGRESS_PROBE_UNAVAILABLE",
    });
  }
  // 真正的实现放在原生层(`ouuut-runtime.mjs` 的 `probeEgressIp`):它要复用 `createTab()`,
  // 从而把自检页建在**档案自己的 context** 里 —— 量到的才是这个档案的出口。
  const text = String(await api.probeEgressIp({ endpoint, timeout })).trim();
  if (!isIpv4(text)) {
    throw new EgressError(`出口端点返回的不是 IP:${JSON.stringify(text.slice(0, 100))}`, {
      code: "OUUUT_EGRESS_PROBE_BAD_REPLY",
    });
  }
  return text;
}
