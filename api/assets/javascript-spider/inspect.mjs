import { parse } from "acorn";
import { readFile } from "node:fs/promises";

/** 固定错误码跨进程传递，不能把源代码或原始异常输出给用户。 */
export class JavaScriptSourceFailure extends Error {
  /** 保存宿主可识别的错误码。 */
  constructor(code, diagnostics) { super(code); this.code = code; this.diagnostics = diagnostics; }
}

export const METHOD_ALIASES = {
  init: ["init"], homeContent: ["homeContent", "home"], homeVideoContent: ["homeVideoContent", "homeVod"],
  categoryContent: ["categoryContent", "category"], detailContent: ["detailContent", "detail"],
  searchContent: ["searchContent", "search"], playerContent: ["playerContent", "play"],
  localProxy: ["localProxy", "proxy"], destroy: ["destroy"],
};

/** 统一映射本地内置库，不下载或执行源脚本声明的远程依赖。 */
export function dependencyKind(specifier) {
  const kinds = {
    "assets://js/lib/cat.js": "cat", "./lib/cat.js": "cat", "./cat.js": "cat", "cat": "cat",
    "assets://js/lib/cheerio.min.js": "cheerio", "assets://js/lib/cheerio.js": "cheerio", "cheerio": "cheerio",
    "assets://js/lib/crypto-js.js": "crypto", "assets://js/lib/crypto-js.min.js": "crypto", "crypto-js": "crypto",
    "assets://js/lib/pako.min.js": "pako", "assets://js/lib/pako.js": "pako", "pako": "pako",
    "buffer": "buffer", "node:buffer": "buffer",
  };
  return kinds[specifier] ?? null;
}

/** 递归访问 AST 节点，仅检查语法和静态声明，不求值任何源代码。 */
function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const entry of node) walk(entry, visit); return; }
  if (typeof node.type === "string") visit(node);
  for (const [key, value] of Object.entries(node)) if (key !== "start" && key !== "end") walk(value, visit);
}

/** 对象导出只读取方法名；计算属性必须是明确的字符串。 */
function propertyName(property) {
  if (property.type !== "Property" || property.kind !== "init") return "";
  if (!property.computed && property.key.type === "Identifier") return property.key.name;
  return typeof property.key.value === "string" ? property.key.value : "";
}

/** 从 export default 或 __jsEvalReturn 返回的对象中取得公开方法。 */
function exportedObject(tree) {
  const bindings = new Map();
  for (const statement of tree.body) {
    const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type === "FunctionDeclaration") bindings.set(declaration.id.name, declaration);
    if (declaration?.type === "VariableDeclaration") for (const entry of declaration.declarations) {
      if (entry.id.type === "Identifier") bindings.set(entry.id.name, entry.init);
    }
  }
  /** 只解析脚本内的简单标识符引用，拒绝循环引用。 */
  function resolve(node, seen = new Set()) {
    if (node?.type !== "Identifier") return node;
    if (seen.has(node.name)) return null;
    seen.add(node.name);
    return resolve(bindings.get(node.name), seen);
  }
  for (const statement of tree.body) {
    if (statement.type === "ExportDefaultDeclaration") {
      const object = resolve(statement.declaration);
      if (object?.type === "ObjectExpression") return { object, resolve };
    }
  }
  const factory = bindings.get("__jsEvalReturn");
  if (factory?.type === "FunctionDeclaration" || factory?.type === "FunctionExpression" || factory?.type === "ArrowFunctionExpression") {
    const returns = factory.body.type === "BlockStatement" ? factory.body.body.filter((entry) => entry.type === "ReturnStatement").map((entry) => entry.argument) : [factory.body];
    for (const value of returns) {
      const object = resolve(value);
      if (object?.type === "ObjectExpression") return { object, resolve };
    }
  }
  throw new JavaScriptSourceFailure("javascript_source_exports_invalid");
}

/** 只用 AST 检查独立 ES Module 的五个内容接口和本地依赖。 */
export async function inspectJavaScript(scriptPath) {
  const bytes = await readFile(scriptPath);
  if (bytes.length > 2 * 1024 * 1024) throw new JavaScriptSourceFailure("javascript_source_message_too_large");
  let source;
  let tree;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    tree = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch { throw new JavaScriptSourceFailure("javascript_source_syntax_invalid"); }
  walk(tree, (node) => {
    if (node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration" || (node.type === "ExportNamedDeclaration" && node.source)) {
      if (!dependencyKind(String(node.source.value))) throw new JavaScriptSourceFailure("javascript_source_dependency_unsupported");
    }
    if (node.type === "ImportExpression" && (!node.source || node.source.type !== "Literal" || !dependencyKind(String(node.source.value)))) {
      throw new JavaScriptSourceFailure("javascript_source_dependency_unsupported");
    }
  });
  const { object, resolve } = exportedObject(tree);
  const functions = new Map();
  for (const property of object.properties) {
    const name = propertyName(property);
    const value = resolve(property.value);
    if (name && ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(value?.type)) functions.set(name, value);
  }
  const methods = Object.entries(METHOD_ALIASES).filter(([, aliases]) => aliases.some((alias) => functions.has(alias))).map(([name]) => name);
  for (const method of ["homeContent", "categoryContent", "detailContent", "searchContent", "playerContent"]) {
    if (!methods.includes(method)) throw new JavaScriptSourceFailure("javascript_source_method_missing");
  }
  const search = functions.get("searchContent") ?? functions.get("search");
  const searchPaged = search.params.length >= 3 || search.params.some((parameter) => parameter.type === "RestElement");
  let declaredName = "";
  for (const statement of tree.body) {
    const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const variable of declaration.declarations) {
      if (["display_name", "displayName"].includes(variable.id.name) && typeof variable.init?.value === "string") declaredName = variable.init.value;
    }
  }
  const headerName = source.match(/@header\s*\(\s*\{[\s\S]*?\btitle\s*:\s*['"]([^'"\r\n]{1,100})['"]/u)?.[1] ?? "";
  return { name: declaredName || headerName, methods, mediaType: "video", searchPaged };
}
