import { createInterface } from "node:readline";
import { recognizeVideoDirectory } from "./core.js";
import type { VideoRecognitionInput } from "./models.js";

/** 从标准输入逐行读取目录快照，直接运行公共规则，不连接网盘或数据库。 */
async function main(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const input = JSON.parse(line) as VideoRecognitionInput;
      process.stdout.write(JSON.stringify(recognizeVideoDirectory(input)) + "\n");
    } catch (error) {
      const message = error instanceof Error ? error.message : "目录快照无效";
      process.stdout.write(JSON.stringify({ error: message }) + "\n");
      process.exitCode = 1;
    }
  }
}

await main();
