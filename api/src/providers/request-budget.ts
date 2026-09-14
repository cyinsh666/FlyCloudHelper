import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";

interface RequestScope { accountKey: string }
interface Budget { active: number; waiting: number }
const scope = new AsyncLocalStorage<RequestScope>();
const budgets = new Map<string, Budget>(); // 只保存账号摘要哈希及活跃计数，不保存凭据。

/** 将音乐任务内的真实 Provider 请求归入同一账号预算，其他调用保持原流程。 */
export function withMusicRequestBudget<T>(accountKey: string, action: () => Promise<T>): Promise<T> {
  return scope.run({ accountKey }, action);
}

/** 获取跨服务共享名额；等待可取消，释放回调可重复调用但只扣减一次。 */
export async function acquireMusicBudget(kind: "api" | "bytes" | "file" | "online", signal?: AbortSignal): Promise<() => void> {
  const current = scope.getStore();
  if (!current) return () => {};
  const key = kind === "file" || kind === "online" ? `global:${kind}` : `${current.accountKey}:${kind}`;
  const maximum = kind === "file" ? 8 : 4;
  let budget = budgets.get(key);
  if (!budget) { budget = { active: 0, waiting: 0 }; budgets.set(key, budget); }
  budget.waiting += 1;
  try {
    while (budget.active >= maximum) await delay(50, undefined, { signal });
    signal?.throwIfAborted();
    budget.active += 1;
  } finally {
    budget.waiting -= 1;
    if (!budget.active && !budget.waiting) budgets.delete(key);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    budget.active -= 1;
    if (!budget.active && !budget.waiting) budgets.delete(key);
  };
}
