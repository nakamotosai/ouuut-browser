// native/binding/task-spaces.mjs —— 任务空间的**所有权状态机**与 **user-control 门**
//
// 这一片的契约完全来自 vendored harness 的源码,不是我们发明的:
//
// ## 形状(硬要求,不满足就被 harness 当场抛错)
//
// | 原生方法 | 必须返回 | 出处 |
// |---|---|---|
// | `listTaskSpaces()` | **`{taskSpaces: [...]}`**(不是裸数组!) | `helpers.ts:561-566` —— 否则抛 `listTaskSpaces expected { taskSpaces: [...] }` |
// | `createTaskSpace(name[, profileId])` | 单个空间对象 | `helpers.ts:200-210`;注意**不要显式传 undefined** |
// | `claimTaskSpace(id, name)` | 单个空间对象 | `helpers.ts:376-383` |
// | `useTaskSpace(id)` | 返回值被忽略,**但不能抛** | `helpers.ts:392-397` |
// | `listProfiles()` | `{profiles:[{id:string,name:string,isDefault:boolean}]}` | `helpers.ts:105-121`,逐字段校验 |
//
// 每条空间记录:`{taskId, id:number, name, ownership?, createdBy?, profileId?, profileName?, recentTabTitles?}`
// —— **`id` 必须是 number**(`taskSpaceNumericId` 会抛 `requires a numeric task space id`)。
//
// ## 所有权(逐字抄自 `helpers.ts:123-140` 的注释表)
//
// `ownership` ∈ `"agent" | "agentDelegatedToUser" | "user"`;前两者都算 agent 所有。
//
//   | 目标空间是 user 所有时 | 行为 |
//   |---|---|
//   | `taskSpace` / `useOrCreateTaskSpace` | 按**名字** → 抛 `EGO_TASK_SPACE_NAME_IN_USE`;按 **id** → 不认领地选中它(user-control 错误随后浮出) |
//   | `switchTaskSpace` | 抛(仅 agent 所有可用) |
//   | `claimTaskSpace` | 认领(所有权转 agent)再选中 |
//   | `handOffTaskSpace` | 跳过 → `{done:false, skipped:"user-owned"}` |
//   | `completeTaskSpace {keep:true}` | 跳过 → `{done:false, skipped:"user-owned"}` |
//   | `completeTaskSpace {keep:false}` | 认领后关闭 |
//   | `takeOverTaskSpace` / `waitForAgentControl` | 不做所有权检查 |
//
// 并明确写着:**「user-control 边界由原生桥在真正执行命令时强制,不在这里」** —— 这就是本文件下半部分。
//
// ## user-control 门的呈现方式(来自 `docs/原生层接口.md` §4.4 的实测契约)
//
// `helpers.test.mjs:1334` 写得最清楚:
//   > The probe in waitForAgentControl keys on `ego.snapshot()`'s **rejection** carrying
//   > `error_code === EGO_TASK_SPACE_USER_IN_CONTROL`(the documented contract), **not on message wording**.
//
// ⇒ 交给用户之后:
//   * `snapshot()` 必须 **reject**,且 `error_code` **精确等于** `EGO_TASK_SPACE_USER_IN_CONTROL`(文案随便写)
//   * 会改浏览器的 CDP 命令必须被拦(走 `onSendCDPMessageError`),**不能静默放过**
//
// 为什么门要做在**发送侧**而不是等浏览器报错:交给用户之后浏览器那边未必知道
// "现在是 agent 在偷偷发命令",只有我们这层知道当前空间的所有权状态。

/** 交给用户、agent 被挡住时用的代号(harness 按**代号**判定,不按文案)。 */
export const USER_IN_CONTROL = "EGO_TASK_SPACE_USER_IN_CONTROL";
export const NAME_IN_USE = "EGO_TASK_SPACE_NAME_IN_USE";
export const INVALID_ARGUMENT = "EGO_INVALID_ARGUMENT";

export class TaskSpaceError extends Error {
  constructor(message, errorCode) {
    super(message);
    this.name = "TaskSpaceError";
    this.error_code = errorCode;
  }
}

/** 只会挡住"会改变浏览器状态"的方法;只读查询放行,否则用户连看一眼都不行。 */
const MUTATING_CDP_METHOD_PREFIXES = [
  "Page.navigate",
  "Page.reload",
  "Page.captureScreenshot",
  "Input.",
  "Runtime.evaluate",
  "Runtime.callFunctionOn",
  "DOM.",
  "Target.createTarget",
  "Target.closeTarget",
  "Target.activateTarget",
  "Target.attachToTarget",
  "Browser.",
  "Network.set",
  "Storage.",
  "Emulation.",
];

/** 这些即使已交给用户也放行 —— 它们不改任何东西,挡了只会让 agent 变瞎。 */
const ALWAYS_ALLOWED_CDP = new Set([
  "Target.getTargets",
  "Target.getBrowserContexts",
  "Browser.getVersion",
  "Page.getNavigationHistory",
]);

export function isCdpBlockedByUserControl(method) {
  if (typeof method !== "string" || method.length === 0) return false;
  if (ALWAYS_ALLOWED_CDP.has(method)) return false;
  return MUTATING_CDP_METHOD_PREFIXES.some((p) => method.startsWith(p));
}

/**
 * 任务空间注册表。纯内存、无产品副作用 —— 它只管**所有权与选中态**,
 * 浏览器侧的隔离(档案/context)是 M3 的事。
 */
export function createTaskSpaceRegistry({ now = () => Date.now() } = {}) {
  /** @type {Map<number, object>} */
  const spaces = new Map();
  let nextId = 1;
  let selectedId = null;

  const normalize = (s) => ({
    taskId: s.taskId,
    id: s.id,
    name: s.name,
    ownership: s.ownership,
    ...(s.createdBy !== undefined ? { createdBy: s.createdBy } : {}),
    ...(s.profileId !== undefined ? { profileId: s.profileId } : {}),
    ...(s.profileName !== undefined ? { profileName: s.profileName } : {}),
    ...(s.recentTabTitles !== undefined ? { recentTabTitles: s.recentTabTitles } : {}),
  });

  const assertId = (id, op) => {
    if (typeof id !== "number" || !Number.isFinite(id)) {
      throw new TaskSpaceError(`${op} requires a numeric task space id, got ${JSON.stringify(id)}`, INVALID_ARGUMENT);
    }
  };

  return {
    /** `listTaskSpaces()` —— **必须包成 `{taskSpaces}`**。 */
    list() {
      return { taskSpaces: [...spaces.values()].map(normalize) };
    },

    get(id) {
      return spaces.get(id) ?? null;
    },

    get selectedId() {
      return selectedId;
    },

    get selected() {
      return selectedId === null ? null : spaces.get(selectedId) ?? null;
    },

    /** 当前是否处于"已交给用户"态(门只看这个)。 */
    get isUserInControl() {
      const s = this.selected;
      return Boolean(s && s.ownership === "agentDelegatedToUser");
    },

    create(name, profileId) {
      if (typeof name !== "string" || name.trim().length === 0) {
        throw new TaskSpaceError("createTaskSpace requires a non-empty name", INVALID_ARGUMENT);
      }
      const clash = [...spaces.values()].find((s) => s.name === name);
      if (clash) {
        // 按名字创建撞到 **user 所有**的空间 → 用代号拒绝(harness 的表就是这么定的)
        if (clash.ownership === "user") {
          throw new TaskSpaceError(
            `task space name ${JSON.stringify(name)} is already used by a user-owned space`,
            NAME_IN_USE,
          );
        }
        // agent 自己的同名空间:幂等返回,不新建(避免每轮跑脚本都堆一堆空壳)
        return normalize(clash);
      }
      const id = nextId++;
      const space = {
        taskId: `space-${id}`,
        id,
        name,
        ownership: "agent",
        createdBy: "agent",
        ...(profileId !== undefined ? { profileId } : {}),
        createdAt: now(),
        recentTabTitles: [],
      };
      spaces.set(id, space);
      return normalize(space);
    },

    /** 认领:所有权转 agent(harness 的表:`claimTaskSpace` → claims it, then selects it)。 */
    claim(id, name) {
      assertId(id, "claimTaskSpace");
      const space = spaces.get(id);
      if (!space) {
        // 允许"认领一个我们没登记过的空间" —— 那是用户自己建的,名字由调用方给
        const adopted = {
          taskId: `space-${id}`,
          id,
          name: typeof name === "string" && name ? name : `space-${id}`,
          ownership: "agent",
          createdBy: "agent",
          recentTabTitles: [],
        };
        spaces.set(id, adopted);
        return normalize(adopted);
      }
      space.ownership = "agent";
      return normalize(space);
    },

    select(id) {
      assertId(id, "useTaskSpace");
      const space = spaces.get(id);
      if (!space) {
        // 选中一个未登记的空间:登记它并把所有权留成 `user`
        // (harness 的表:*按 id* 选中 user 所有空间时,**不认领**)
        const adopted = {
          taskId: `space-${id}`,
          id,
          name: `space-${id}`,
          ownership: "user",
          createdBy: "user",
          recentTabTitles: [],
        };
        spaces.set(id, adopted);
      }
      selectedId = id;
      return null; // 返回值被 harness 忽略
    },

    /** 交给用户 —— 门从这里合上。 */
    handOff() {
      const s = this.selected;
      if (!s) throw new TaskSpaceError("handOffTaskSpace requires a selected task space", INVALID_ARGUMENT);
      if (s.ownership === "user") {
        return { done: false, skipped: "user-owned" };
      }
      s.ownership = "agentDelegatedToUser";
      return { done: true };
    },

    /** 拿回来 —— 门从这里打开。 */
    takeOver() {
      const s = this.selected;
      if (!s) throw new TaskSpaceError("takeOverTaskSpace requires a selected task space", INVALID_ARGUMENT);
      if (s.ownership === "agentDelegatedToUser") s.ownership = "agent";
      return { done: true };
    },

    /** 结束:`{keep:true}` 保留空间、`{keep:false}` 关闭它。 */
    complete({ keep = false } = {}) {
      const s = this.selected;
      if (!s) throw new TaskSpaceError("completeTaskSpace requires a selected task space", INVALID_ARGUMENT);
      if (s.ownership === "user" && keep) {
        return { done: false, skipped: "user-owned" };
      }
      if (!keep) {
        spaces.delete(s.id);
        if (selectedId === s.id) selectedId = null;
      }
      return { done: true };
    },

    close() {
      const s = this.selected;
      if (!s) throw new TaskSpaceError("closeTaskSpace requires a selected task space", INVALID_ARGUMENT);
      spaces.delete(s.id);
      if (selectedId === s.id) selectedId = null;
      return { done: true };
    },
  };
}
