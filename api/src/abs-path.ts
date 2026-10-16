import { validationError } from "./errors.js";

/** ABS 单库兼容服务地址的原始值和唯一查询值。 */
export interface AbsPathSuffixValue {
  value: string;
  lookup: string;
}

/** 校验固定 /abs/ 前缀后的单层路径，不允许吞掉云助手自身 API。 */
export function validateAbsPathSuffix(input: unknown): AbsPathSuffixValue {
  if (typeof input !== "string") throw validationError("absPathSuffix", "ABS 地址后缀格式无效");
  const value = input.trim();
  if (!value || Array.from(value).length > 64 || !/^[\p{L}\p{N}_-]+$/u.test(value)) {
    throw validationError("absPathSuffix", "ABS 地址后缀须为 1 至 64 个文字、数字、短横线或下划线");
  }
  return { value, lookup: value.toLowerCase() };
}

/** 生成客户端填写的 ABS 服务根地址。 */
export function buildAbsPath(pathSuffix: string): string {
  return `/abs/${encodeURIComponent(pathSuffix)}`;
}
