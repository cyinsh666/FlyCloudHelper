"""Python Spider 常驻 worker：检查使用 AST，实际调用才导入源脚本。"""

import argparse
import ast
import asyncio
import base64
import importlib
import importlib.abc
import importlib.util
import inspect
import json
import os
import sys
import tokenize

# 关键变量：单条消息有明确大小上限，源脚本打印内容不能占用 RPC 通道。
MAX_REQUEST_BYTES = 1024 * 1024
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_SCRIPT_BYTES = 2 * 1024 * 1024
CONTENT_METHODS = ("homeContent", "homeVideoContent", "categoryContent", "detailContent", "searchContent", "playerContent")


class WorkerFailure(Exception):
    """只向宿主暴露固定错误码，不暴露脚本异常正文。"""

    def __init__(self, code):
        """保存可公开错误码。"""
        super().__init__(code)
        self.code = code


class CryptoAliasLoader(importlib.abc.Loader):
    """为 Debian 的 Cryptodome 提供同一模块对象的 Crypto 兼容入口。"""

    def __init__(self, target_name):
        """只记录已确定的 Cryptodome 模块名。"""
        self.target_name = target_name
        self.original_spec = None

    def create_module(self, spec):
        """复用已安装库的模块，避免同一个加密模块被重复执行。"""
        module = importlib.import_module(self.target_name)
        self.original_spec = module.__spec__
        return module

    def exec_module(self, module):
        """保留真实库的模块规格，别名不会改变库内部的资源定位。"""
        module.__spec__ = self.original_spec


class CryptoAliasFinder(importlib.abc.MetaPathFinder):
    """仅处理 Crypto 子模块，不影响其他 Python 模块的查找。"""

    def find_spec(self, fullname, path=None, target=None):
        """把 Crypto 的固定命名空间映射到已安装的 Cryptodome。"""
        if not fullname.startswith("Crypto."):
            return None
        target_name = "Cryptodome" + fullname[len("Crypto"):]
        spec = importlib.util.find_spec(target_name)
        if spec is None:
            return None
        return importlib.util.spec_from_loader(fullname, CryptoAliasLoader(target_name),
                                              is_package=spec.submodule_search_locations is not None)


def install_crypto_alias():
    """只在 Crypto 缺失而 Cryptodome 已安装时启用别名，不自动安装依赖。"""
    if importlib.util.find_spec("Crypto") is not None:
        return
    if importlib.util.find_spec("Cryptodome") is None:
        return
    sys.modules["Crypto"] = importlib.import_module("Cryptodome")
    sys.meta_path.insert(0, CryptoAliasFinder())


def clear_source_error(target):
    """调用前清空文本错误状态，上一调用失败不能污染当前结果。"""
    if isinstance(getattr(target, "last_error", None), str):
        target.last_error = ""
    protocol = getattr(target, "protocol", None)
    if protocol is not None and isinstance(getattr(protocol, "last_detail_error", None), str):
        protocol.last_detail_error = ""


def check_source_error(target):
    """识别源主动报告的失败，只输出固定错误码而不回传原始错误文字。"""
    protocol = getattr(target, "protocol", None)
    if protocol is not None and getattr(protocol, "last_detail_error", None) == "server_version_guard":
        raise WorkerFailure("python_source_version_guard")
    message = getattr(target, "last_error", None)
    if isinstance(message, str) and message:
        raise WorkerFailure("python_source_call_failed")


def literal_names(statements):
    """静态读取字符串赋值，不计算表达式或导入任何模块。"""
    names = {}
    for statement in statements:
        if isinstance(statement, ast.Assign) and isinstance(statement.value, ast.Constant) and isinstance(statement.value.value, str):
            for target in statement.targets:
                if isinstance(target, ast.Name):
                    names[target.id] = statement.value.value
        elif isinstance(statement, ast.AnnAssign) and isinstance(statement.target, ast.Name):
            value = statement.value
            if isinstance(value, ast.Constant) and isinstance(value.value, str):
                names[statement.target.id] = value.value
    return names


def source_class(tree):
    """静态识别 Spider/spider 类及指向脚本内类的简单别名。"""
    classes = {node.name: node for node in tree.body if isinstance(node, ast.ClassDef)}
    aliases = {}
    for statement in tree.body:
        if isinstance(statement, ast.Assign) and isinstance(statement.value, ast.Name):
            for target in statement.targets:
                if isinstance(target, ast.Name):
                    aliases[target.id] = statement.value.id
    for entry in ("Spider", "spider"):
        seen = set()
        while entry not in seen:
            if entry in classes:
                return classes[entry], classes
            seen.add(entry)
            entry = aliases.get(entry)
            if entry is None:
                break
    return None, classes


def class_statements(selected, classes, visited=None):
    """汇总脚本内明确声明的继承方法；不会加载外部父类或执行类体。"""
    visited = set() if visited is None else visited
    if selected.name in visited:
        return []
    visited.add(selected.name)
    statements = []
    for base in selected.bases:
        if isinstance(base, ast.Name) and base.id in classes:
            statements.extend(class_statements(classes[base.id], classes, visited))
    statements.extend(selected.body)
    return statements


def inspect_script(script_path):
    """只解析 AST；名称来自 display_name 或 getName 的静态字符串。"""
    try:
        if os.path.getsize(script_path) > MAX_SCRIPT_BYTES:
            raise WorkerFailure("python_source_message_too_large")
        with tokenize.open(script_path) as source_file:
            source = source_file.read(MAX_SCRIPT_BYTES + 1)
        if len(source.encode("utf-8")) > MAX_SCRIPT_BYTES:
            raise WorkerFailure("python_source_message_too_large")
        tree = ast.parse(source, filename="<python-source>")
    except (SyntaxError, UnicodeError, LookupError):
        raise WorkerFailure("python_source_syntax_invalid") from None
    except OSError:
        raise WorkerFailure("python_source_script_unavailable") from None
    selected, classes = source_class(tree)
    statements = class_statements(selected, classes) if selected is not None else tree.body
    functions = [node for node in statements if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))]
    names = literal_names(tree.body)
    names.update(literal_names(statements))
    name = names.get("display_name", "")
    if not name:
        get_name = next((node for node in reversed(functions) if node.name == "getName"), None)
        if get_name is not None:
            for statement in get_name.body:
                if not isinstance(statement, ast.Return):
                    continue
                value = statement.value
                if isinstance(value, ast.Constant) and isinstance(value.value, str):
                    name = value.value
                elif isinstance(value, ast.Name):
                    name = names.get(value.id, "")
                elif isinstance(value, ast.Attribute) and isinstance(value.value, ast.Name) and value.value.id in ("self", "cls"):
                    name = names.get(value.attr, "")
                if name:
                    break
    return {"name": name,
            "methods": sorted({node.name for node in functions if not node.name.startswith("_")})}


def json_value(value):
    """二进制使用专用 JSON 标记，其余非 JSON 对象明确拒绝。"""
    if isinstance(value, (bytes, bytearray, memoryview)):
        return {"__python_bytes__": base64.b64encode(bytes(value)).decode("ascii")}
    raise TypeError("unsupported result type")


def restore_bytes(value):
    """把宿主传入的受控二进制标记还原为 bytes，供代理请求体等接口使用。"""
    if len(value) == 1 and isinstance(value.get("__python_bytes__"), str):
        return base64.b64decode(value["__python_bytes__"], validate=True)
    return value


def await_result(value):
    """兼容同步方法和返回协程的方法，整个实例仍按顺序执行。"""
    if inspect.isawaitable(value):
        async def consume():
            """将任意 awaitable 包装成 asyncio.run 可执行的协程。"""
            return await value
        return asyncio.run(consume())
    return value


def function_signature(function):
    """提前读取绑定函数签名，避免根据源内部抛出的 TypeError 重复执行。"""
    try:
        return inspect.signature(function)
    except (TypeError, ValueError):
        return None


def positional_parameters(signature):
    """绑定方法的 self 已被 signature 移除，只统计实际可传入的位置参数。"""
    if signature is None:
        return []
    return [parameter for parameter in signature.parameters.values()
            if parameter.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)]


def accepts_variable_arguments(signature):
    """带星号位置参数的方法保留宿主传入的全部参数。"""
    return signature is None or any(parameter.kind == inspect.Parameter.VAR_POSITIONAL
                                    for parameter in signature.parameters.values())


def invoke_function(function, args):
    """按实际位置参数裁去兼容接口的多余尾参数，源方法仅执行一次。"""
    signature = function_signature(function)
    selected = args if accepts_variable_arguments(signature) else args[:len(positional_parameters(signature))]
    if signature is not None:
        signature.bind(*selected)
    return await_result(function(*selected))


def search_invocation(target, function, args):
    """优先使用专门分页方法；普通两参数搜索绝不能把第二页当成第一页。"""
    arguments = list(args)
    page = int(arguments[2]) if len(arguments) > 2 else 1
    paged_function = getattr(target, "searchContentPage", None)
    if callable(paged_function):
        function = paged_function
        signature = function_signature(function)
        parameters = positional_parameters(signature)
        # 专门分页入口也常采用 key,page 两参数，不能把 quick 误传成页码。
        if not accepts_variable_arguments(signature) and len(parameters) == 2:
            arguments = [arguments[0] if arguments else "", page]
        return function, arguments, True
    signature = function_signature(function)
    supports_pages = accepts_variable_arguments(signature) or len(positional_parameters(signature)) >= 3
    if not supports_pages and page > 1:
        raise WorkerFailure("python_source_paging_unsupported")
    return function, arguments, supports_pages


def mark_search_result(result, supports_pages):
    """首页搜索带明确分页能力标记；JSON 文本同样能交由既有适配器读取。"""
    if supports_pages:
        return result
    value = result
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (TypeError, ValueError):
            return result
    if isinstance(value, dict):
        value = dict(value)
        value["__python_search_paged__"] = False
        return value
    return result


class SpiderWorker:
    """一个 worker 对应一个源实例，模块、Spider 和 Cookie 会话保持常驻。"""

    def __init__(self, script_path, plugin_root):
        """只保存入口；初始化 worker 本身不导入源脚本。"""
        self.script_path = script_path
        self.plugin_root = plugin_root
        self.target = None
        self.initialized = False
        self.initial_result = None
        self.destroyed = False

    def initialize(self, extend=""):
        """首次实际调用时导入源并执行 init，后续调用保留同一个实例。"""
        if self.initialized:
            return self.initial_result
        try:
            script_directory = os.path.dirname(self.script_path)
            for directory in (self.plugin_root, script_directory):
                if directory not in sys.path:
                    sys.path.insert(0, directory)
            install_crypto_alias()
            spec = importlib.util.spec_from_file_location("_flycloud_python_source", self.script_path)
            if spec is None or spec.loader is None:
                raise WorkerFailure("python_source_script_unavailable")
            module = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = module
            spec.loader.exec_module(module)
            self.target = module
            for name in ("Spider", "spider"):
                candidate = getattr(module, name, None)
                if inspect.isclass(candidate) and any(callable(getattr(candidate, method, None)) for method in CONTENT_METHODS):
                    self.target = candidate()
                    break
            initializer = getattr(self.target, "init", None)
            if callable(initializer):
                clear_source_error(self.target)
                self.initial_result = invoke_function(initializer, [extend])
                check_source_error(self.target)
            self.initialized = True
            return self.initial_result
        except WorkerFailure:
            raise
        except (ModuleNotFoundError, ImportError):
            raise WorkerFailure("python_source_dependency_missing") from None
        except BaseException:
            raise WorkerFailure("python_source_load_failed") from None

    def dispatch(self, method, args):
        """分发公开 Spider 接口；检查入口始终不触发源导入。"""
        if method == "__inspect__":
            return inspect_script(self.script_path)
        if method == "init":
            return self.initialize(args[0] if args else "")
        if not isinstance(method, str) or not method.isidentifier() or method.startswith("_"):
            raise WorkerFailure("python_source_invalid_method")
        self.initialize()
        if method == "destroy":
            return self.destroy()
        function = getattr(self.target, method, None)
        if not callable(function):
            raise WorkerFailure("python_source_method_missing")
        try:
            supports_pages = True
            if method == "searchContent":
                function, args, supports_pages = search_invocation(self.target, function, args)
            clear_source_error(self.target)
            result = invoke_function(function, args)
            check_source_error(self.target)
            return mark_search_result(result, supports_pages) if method == "searchContent" else result
        except WorkerFailure:
            raise
        except (ModuleNotFoundError, ImportError):
            raise WorkerFailure("python_source_dependency_missing") from None
        except BaseException:
            raise WorkerFailure("python_source_call_failed") from None

    def destroy(self):
        """正常退出时至多调用一次 destroy；强制终止由宿主保证释放进程。"""
        if self.destroyed or self.target is None:
            return None
        self.destroyed = True
        function = getattr(self.target, "destroy", None)
        if callable(function):
            try:
                return await_result(function())
            except BaseException:
                return None
        return None


def write_response(output, response):
    """输出有界 JSON 行，序列化失败不输出源对象或异常正文。"""
    try:
        line = json.dumps(response, ensure_ascii=False, allow_nan=False, default=json_value, separators=(",", ":"))
        if len(line.encode("utf-8")) + 1 > MAX_RESPONSE_BYTES:
            raise WorkerFailure("python_source_message_too_large")
    except WorkerFailure as error:
        line = json.dumps({"id": response.get("id"), "ok": False, "error": {"code": error.code}})
    except (TypeError, ValueError, RecursionError):
        line = json.dumps({"id": response.get("id"), "ok": False, "error": {"code": "python_source_result_invalid"}})
    output.write(line + "\n")
    output.flush()


def main():
    """读取串行 RPC；打印与原生 stdout 都转入被宿主丢弃的 stderr 管道。"""
    parser = argparse.ArgumentParser()
    parser.add_argument("--script", required=True)
    parser.add_argument("--plugin-root", required=True)
    arguments = parser.parse_args()
    # 关键变量：保留独立 RPC 描述符，源脚本 print 和子进程输出不污染 JSON 通信。
    rpc_descriptor = os.dup(sys.stdout.fileno())
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr
    output = os.fdopen(rpc_descriptor, "w", encoding="utf-8", buffering=1)
    worker = SpiderWorker(os.path.abspath(arguments.script), os.path.abspath(arguments.plugin_root))
    try:
        while True:
            raw = sys.stdin.buffer.readline(MAX_REQUEST_BYTES + 1)
            if not raw:
                break
            if len(raw) > MAX_REQUEST_BYTES:
                write_response(output, {"id": None, "ok": False, "error": {"code": "python_source_message_too_large"}})
                break
            request_id = None
            try:
                request = json.loads(raw, object_hook=restore_bytes)
                if not isinstance(request, dict) or not isinstance(request.get("id"), str) or not isinstance(request.get("args"), list):
                    raise WorkerFailure("python_source_protocol_failed")
                request_id = request["id"]
                if request.get("method") == "__shutdown__":
                    break
                value = worker.dispatch(request.get("method"), request["args"])
                write_response(output, {"id": request_id, "ok": True, "value": value})
            except WorkerFailure as error:
                write_response(output, {"id": request_id, "ok": False, "error": {"code": error.code}})
            except BaseException:
                write_response(output, {"id": request_id, "ok": False, "error": {"code": "python_source_protocol_failed"}})
    finally:
        worker.destroy()
        output.close()


if __name__ == "__main__":
    main()
