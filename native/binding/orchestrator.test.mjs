// native/binding/orchestrator.test.mjs —— 多机编排(纯调度,不发网络)
//
// 三条硬要求各有用例守着:
//   1. 容量是硬的
//   2. 放不下要**报出来**,绝不静默丢弃
//   3. 同样的输入永远同样的分配(确定性)

import test from "node:test";
import assert from "node:assert/strict";

import { planAssignments, replanAfterFailure } from "./orchestrator.mjs";

const hosts = (...specs) => specs.map(([id, max]) => ({ id, max }));

// ---- 1. 基本分配 ----------------------------------------------------------

test("空输入 → 空结果,不抛", () => {
  const r = planAssignments({});
  assert.deepEqual(r.assignments, []);
  assert.deepEqual(r.unassigned, []);
  assert.deepEqual(r.load, {});
});

test("★ 平均分配:3 台机 6 个任务 → 每台恰好 2 个", () => {
  const r = planAssignments({
    hosts: hosts(["a", 2], ["b", 2], ["c", 2]),
    jobs: ["j1", "j2", "j3", "j4", "j5", "j6"].map((id) => ({ id })),
  });
  assert.equal(r.assignments.length, 6);
  assert.deepEqual(r.unassigned, []);
  for (const h of ["a", "b", "c"]) {
    assert.equal(r.load[h].used, 2, `${h} 应该分到 2 个`);
  }
});

test("★ 容量是**硬的**:2 台各 1 个名额,3 个任务 → 第 3 个进 unassigned", () => {
  const r = planAssignments({
    hosts: hosts(["a", 1], ["b", 1]),
    jobs: [{ id: "j1" }, { id: "j2" }, { id: "j3" }],
  });
  assert.equal(r.assignments.length, 2);
  assert.equal(r.unassigned.length, 1, "放不下的必须报出来,不许静默丢");
  assert.equal(r.unassigned[0].jobId, "j3");
  assert.equal(r.unassigned[0].reason, "OUUUT_NO_CAPACITY");
});

test("★ 不健康的机器**不参与**调度,但要在负载表里可见", () => {
  const r = planAssignments({
    hosts: [{ id: "dead", max: 4, healthy: false }, { id: "alive", max: 4 }],
    jobs: [{ id: "j1" }],
  });
  assert.deepEqual(r.assignments, [{ jobId: "j1", host: "alive" }]);
  assert.equal(r.load.dead.skipped, "unhealthy", "跳过了也要让人看得见");
  assert.equal(r.load.dead.cap, 0);
});

test("亲和性:指定了机器就只放那台", () => {
  const r = planAssignments({
    hosts: hosts(["a", 5], ["b", 5]),
    jobs: [{ id: "j1", host: "b" }],
  });
  assert.deepEqual(r.assignments, [{ jobId: "j1", host: "b" }]);
});

test("★ 亲和性指向不存在的机器 → 报错,不许偷偷换一台", () => {
  const r = planAssignments({
    hosts: hosts(["a", 5]),
    jobs: [{ id: "j1", host: "ghost" }],
  });
  assert.deepEqual(r.assignments, []);
  assert.equal(r.unassigned[0].reason, "OUUUT_HOST_UNAVAILABLE");
});

test("★ 确定性:同样输入跑两次,分配逐项相同", () => {
  const input = () => ({
    hosts: hosts(["a", 2], ["b", 2], ["c", 2]),
    jobs: Array.from({ length: 5 }, (_, i) => ({ id: `j${i}` })),
  });
  const one = planAssignments(input());
  const two = planAssignments(input());
  assert.deepEqual(one.assignments, two.assignments);
});

test("负载相同时按 hosts 给定顺序(确定性来源)", () => {
  const r = planAssignments({ hosts: hosts(["a", 1], ["b", 1]), jobs: [{ id: "j1" }] });
  assert.equal(r.assignments[0].host, "a", "第一台先拿");
});

test("缺 id 的任务不许悄悄消失", () => {
  const r = planAssignments({ hosts: hosts(["a", 1]), jobs: [{}, { id: "ok" }] });
  assert.equal(r.assignments.length, 1);
  assert.equal(r.unassigned[0].reason, "OUUUT_JOB_INVALID");
});

// ---- 2. 故障重排 ----------------------------------------------------------

test("★ 机器挂了:没跑完的重新分配,已跑完的**保留记录**", () => {
  const r = replanAfterFailure({
    assignments: [
      { jobId: "j1", host: "a" },
      { jobId: "j2", host: "a" },
      { jobId: "j3", host: "b" },
    ],
    done: ["j1"],
    failedHost: "a",
    hosts: [{ id: "a", max: 2, healthy: false }, { id: "b", max: 2 }],
    jobs: [{ id: "j1" }, { id: "j2" }, { id: "j3" }],
  });

  assert.deepEqual(r.requeued, ["j2"], "只有没跑完的才重排");
  // j1 保留在 a 上(它确实跑完了),j2 挪到 b,j3 还在 b
  const byJob = Object.fromEntries(r.assignments.map((a) => [a.jobId, a.host]));
  assert.equal(byJob.j1, "a", "已完成的保留原记录");
  assert.equal(byJob.j2, "b", "没跑完的挪到还活着的机器");
  assert.equal(byJob.j3, "b");
});

test("★ 重排要把**已占用的名额**算进去,不许把机器挤爆", () => {
  const r = replanAfterFailure({
    assignments: [
      { jobId: "j1", host: "b" },
      { jobId: "j2", host: "a" },
      { jobId: "j3", host: "a" },
    ],
    done: [],
    failedHost: "a",
    hosts: [{ id: "a", max: 3, healthy: false }, { id: "b", max: 1 }],
    jobs: [{ id: "j1" }, { id: "j2" }, { id: "j3" }],
  });
  // b 只剩 0 个名额(j1 已占满)→ j2/j3 必须进 unassigned,不能硬塞
  assert.equal(r.load.b.used, 1);
  assert.equal(r.assignments.filter((x) => x.host === "b").length, 1);
  assert.equal(r.unassigned.length, 2, "塞不下就要报出来");
  for (const u of r.unassigned) assert.equal(u.reason, "OUUUT_NO_CAPACITY");
});

test("没有机器挂时重排等于不变", () => {
  const r = replanAfterFailure({
    assignments: [{ jobId: "j1", host: "a" }],
    done: [],
    failedHost: "nobody",
    hosts: [{ id: "a", max: 2 }],
    jobs: [{ id: "j1" }],
  });
  assert.deepEqual(r.assignments, [{ jobId: "j1", host: "a" }]);
  assert.deepEqual(r.requeued, []);
});
