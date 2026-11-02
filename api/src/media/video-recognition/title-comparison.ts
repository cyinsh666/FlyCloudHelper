/** 标题比较只处理大小写、空白和标点，保留数字、正文及有区分度的符号。 */
export function compareVideoTitle(value: string): string {
  return value.toLowerCase().replace(/[\s\p{P}\p{Z}\u200b-\u200f\ufeff]/gu, "");
}
