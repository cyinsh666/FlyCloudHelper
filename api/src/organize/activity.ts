import fs from "node:fs/promises";
import path from "node:path";

/** 扫描任务读取整理任务的持久状态，不依赖整理执行器实例。 */
export async function hasActiveOrganizeTask(exportDirectory: string, serviceId: string): Promise<boolean> {
  const directory = path.join(exportDirectory, "service-organize");
  const names = await fs.readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  });
  for (const name of names) {
    if (!/^(?:job|plan)-[0-9a-f-]{36}\.json$/iu.test(name)) continue;
    let task: { serviceId?: string; status?: string };
    try {
      task = JSON.parse(await fs.readFile(path.join(directory, name), "utf8")) as { serviceId?: string; status?: string };
    } catch (error) {
      // 历史异常文件不应让其他网盘的扫描任务一并失败；原文件仍保留供整理页排查。
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (task.serviceId !== serviceId) continue;
    if (name.startsWith("plan-") && task.status === "preparing") return true;
    if (name.startsWith("job-") && ["queued", "running", "paused"].includes(task.status ?? "")) return true;
  }
  return false;
}
