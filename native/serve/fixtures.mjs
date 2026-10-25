// native/serve/*.test.mjs 的公共夹具:一个**假 core / 假 api**
//
// 服务层不该靠真浏览器来测:传输、鉴权、协议形状都是纯逻辑,假对象就够,
// 而且能测到真浏览器测不出来的分支(超时、错误码、缺参)。

import { PassThrough } from "node:stream";

/** 假 core:每个操作都记一笔,返回值可控。 */
export function fakeCore(overrides = {}) {
  const calls = [];
  return {
    calls,
    async goto(url, opts = {}) {
      calls.push({ op: "goto", url, opts });
      return { targetId: `T-${calls.length}`, url };
    },
    async snapshot(options = {}) {
      calls.push({ op: "snapshot", options });
      return { text: "[p1 标题 | space x]\n正文一行" };
    },
    async tabs() {
      calls.push({ op: "tabs" });
      return { tabs: [{ targetId: "T-1", url: "https://example.com" }] };
    },
    async version() {
      calls.push({ op: "version" });
      return { version: "Chrome/156.0.8078.47" };
    },
    async wait(options = {}) {
      calls.push({ op: "wait", options });
      return { waitedFor: "loadState", loadState: "load", timeoutMs: 30000, elapsedMs: 1 };
    },
    async profile() {
      calls.push({ op: "profile" });
      return {
        profileId: "default",
        kind: null,
        isDefault: true,
        archiveReachable: false,
        profiles: [],
        capabilities: { create: false, close: false, reason: "假 core:未接线" },
      };
    },
    ...overrides,
  };
}

/** 假 harness:装过 SDK 之后的那一面(`taskSpace` 等)。 */
export function fakeHarness(overrides = {}) {
  const calls = [];
  return {
    calls,
    async switchTaskSpace(id) {
      calls.push({ op: "switchTaskSpace", id });
    },
    async taskSpace(name) {
      calls.push({ op: "taskSpace", name });
      return {
        async newPage() {
          calls.push({ op: "newPage" });
          return {
            targetId: "T-page-1",
            async goto(url, opts = {}) {
              calls.push({ op: "goto", url, opts });
            },
            async snapshot(options = {}) {
              calls.push({ op: "snapshot", options });
              return '[p2 "标题" | space "serve"(1)]\n正文一行';
            },
            async waitForSelector(selector, options = {}) {
              calls.push({ op: "waitForSelector", selector, options });
              return true;
            },
            async waitForFunction(expression, argument, options = {}) {
              calls.push({ op: "waitForFunction", expression, argument, options });
              return true;
            },
            async waitForLoadState(state = "load", options = {}) {
              calls.push({ op: "waitForLoadState", state, options });
            },
          };
        },
      };
    },
    async getBrowserVersion() {
      return { product: "Chrome/156.0.8078.47" };
    },
    ...overrides,
  };
}

/** 假原生 api(只用于传输层:列页)。 */
export function fakeApi(overrides = {}) {
  return {
    async listTabs() {
      return { tabs: [{ targetId: "T-page-1" }] };
    },
    async getBrowserVersion() {
      return { product: "Chrome/156.0.8078.47" };
    },
    ...overrides,
  };
}

/** 假 stdin/stdout:喂几行、读回几行。 */
export function pipes() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const lines = [];
  let buf = "";
  stdout.on("data", (c) => {
    buf += c.toString("utf8");
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      lines.push(JSON.parse(buf.slice(0, nl)));
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
    }
  });
  const errText = [];
  stderr.on("data", (c) => errText.push(c.toString("utf8")));
  return { stdin, stdout, stderr, lines, errText };
}
