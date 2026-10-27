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
import re
import sys
import tokenize

# 关键变量：单条消息有明确大小上限，源脚本打印内容不能占用 RPC 通道。
MAX_REQUEST_BYTES = 1024 * 1024
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
# 关键变量：代理仅放宽二进制回应，普通目录消息继续使用原来的 8 MiB 上限。
MAX_PROXY_BODY_BYTES = 16 * 1024 * 1024
MAX_PROXY_RESPONSE_BYTES = (MAX_PROXY_BODY_BYTES * 4 + 2) // 3 + 64 * 1024
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


def inspect_live_source(tree):
    """只静态识别有具体运行适配的 YSP 服务，不执行入口、设备注册或网络代码。"""
    classes = {node.name for node in tree.body if isinstance(node, ast.ClassDef)}
    functions = {node.name for node in tree.body if isinstance(node, ast.FunctionDef)}
    literals = {}
    for statement in tree.body:
        if isinstance(statement, ast.Assign):
            for target in statement.targets:
                if isinstance(target, ast.Name):
                    try:
                        literals[target.id] = ast.literal_eval(statement.value)
                    except (ValueError, TypeError, SyntaxError):
                        pass
    if not ({"Handler", "Resolver", "ChannelDirectory"} <= classes
            and {"main", "start_companion_engine", "jce_timeshift_url", "bk_playurls"} <= functions):
        return None
    channels = literals.get("DEFAULT_CHANNELS")
    if not isinstance(channels, list) or not 1 <= len(channels) <= 256:
        return None
    backend = literals.get("BACKEND_CHANNELS", set())
    catchup = literals.get("TIMESHIFT_SUPPORTED", set())
    tvg = literals.get("TVG_IDS", {})
    logo = literals.get("LOGO_BASE", "")
    output = []
    for channel in channels:
        if not isinstance(channel, (tuple, list)) or len(channel) != 5:
            return None
        slug, name = channel[:2]
        if not isinstance(slug, str) or not isinstance(name, str):
            return None
        output.append({"id": slug, "name": name, "group": "央视" if slug.startswith(("cctv", "cgtn")) else "卫视",
                       "tvgId": tvg.get(slug, slug), "logo": str(logo).rstrip("/") + "/" + slug + ".png" if logo else "",
                       "catchup": slug in catchup, "requiresRelay": slug in backend})
    return {"name": "央视频直播", "mediaType": "video", "methods": [], "sourceType": "ysp_live",
            "liveConfig": {"engine": "ysp", "channels": output,
                           "epgUrls": ["https://epg.zsdc.eu.org/t.xml.gz", "https://epg.pw/xmltv/epg_CN.xml.gz"]}}


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
    live = inspect_live_source(tree)
    if live is not None:
        return live
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
    # 关键变量：类型只读取静态类属性，不为识别有声书执行第三方脚本。
    media_type = names.get("cloud_helper_media_type", "video")
    if media_type not in ("video", "audiobook"):
        raise WorkerFailure("python_source_result_invalid")
    return {"name": name, "mediaType": media_type,
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
    # 关键变量：有些 CatVod Python 源签名是 key,pg,filter，页码不能传到 filter。
    page_names = {"pg", "page", "pagenum", "page_num", "pageno", "page_no"}
    supports_pages = callable(paged_function) or accepts_variable_arguments(signature)
    if not accepts_variable_arguments(signature):
        supports_pages = supports_pages or any(parameter.name.lower() in page_names
                                               for parameter in parameters[1:])
        if len(parameters) >= 3:
            supports_pages = True
        if len(parameters) >= 2 and parameters[1].name.lower() in page_names:
            quick = arguments[1] if len(arguments) > 1 else False
            arguments = [arguments[0] if arguments else "", page]
            if len(parameters) >= 3:
                arguments.append(quick)
        elif callable(paged_function) and len(parameters) == 2:
            arguments = [arguments[0] if arguments else "", page]
    if not supports_pages and page > 1:
        raise WorkerFailure("python_source_paging_unsupported")
    return function, arguments, supports_pages


def proxy_response(value, request_headers=None):
    """将标准 localProxy 数组转换为有界二进制 RPC，不输出原始响应正文。"""
    if not isinstance(value, (list, tuple)) or len(value) not in (3, 4):
        raise WorkerFailure("python_source_result_invalid")
    status, content_type, body = value[:3]
    if isinstance(status, bool) or not isinstance(status, int) or not 100 <= status <= 599:
        raise WorkerFailure("python_source_result_invalid")
    if not isinstance(content_type, str) or "\r" in content_type or "\n" in content_type:
        raise WorkerFailure("python_source_result_invalid")
    if isinstance(body, str):
        body = body.encode("utf-8")
    elif isinstance(body, (bytearray, memoryview)):
        body = bytes(body)
    if not isinstance(body, bytes):
        raise WorkerFailure("python_source_result_invalid")
    if len(body) > MAX_PROXY_BODY_BYTES:
        raise WorkerFailure("python_source_message_too_large")
    headers = value[3] if len(value) >= 4 and isinstance(value[3], dict) else {}
    selected_headers = {}
    for name, header_value in headers.items():
        if not isinstance(name, str) or not isinstance(header_value, (str, int)):
            raise WorkerFailure("python_source_result_invalid")
        header_text = str(header_value)
        if any(character in name + header_text for character in ("\r", "\n")):
            raise WorkerFailure("python_source_result_invalid")
        selected_headers[name] = header_text
    status, body, selected_headers = proxy_range(status, content_type, body, selected_headers, request_headers or {})
    return {"statusCode": status, "contentType": content_type,
            "bodyBase64": base64.b64encode(body).decode("ascii"), "headers": selected_headers}


def proxy_range(status, content_type, body, headers, request_headers):
    """在源完成格式转换后的字节上处理单段 Range，已有部分回应保持原样。"""
    if status != 200 or "mpegurl" in content_type.lower() or body.lstrip().startswith(b"#EXTM3U"):
        return status, body, headers
    requested = {str(name).lower(): str(value) for name, value in request_headers.items()}
    response_headers = {name.lower(): value for name, value in headers.items()}
    range_value = requested.get("range", "")
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_value.strip(), re.IGNORECASE)
    if match is None or not any(match.groups()):
        return status, body, headers
    # 关键变量：If-Range 没有匹配的强 ETag 或明确 Last-Modified 时，回应完整 200。
    condition = requested.get("if-range")
    if condition:
        etag = response_headers.get("etag", "")
        modified = response_headers.get("last-modified", "")
        matches_etag = bool(etag and not etag.startswith("W/") and not condition.startswith("W/") and etag == condition)
        if not matches_etag and (not modified or condition != modified):
            return status, body, headers
    size = len(body)
    first, last = match.groups()
    if first:
        start = int(first)
        end = min(int(last), size - 1) if last else size - 1
    else:
        suffix = int(last)
        start, end = max(0, size - suffix), size - 1
        if suffix == 0:
            start = size
    selected_headers = {name: value for name, value in headers.items()
                        if name.lower() not in ("content-range", "content-length", "accept-ranges")}
    selected_headers["Accept-Ranges"] = "bytes"
    if start >= size or start > end:
        selected_headers["Content-Range"] = "bytes */%s" % size
        selected_headers["Content-Length"] = "0"
        return 416, b"", selected_headers
    selected = body[start:end + 1]
    selected_headers["Content-Range"] = "bytes %s-%s/%s" % (start, end, size)
    selected_headers["Content-Length"] = str(len(selected))
    return 206, selected, selected_headers


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
        self.proxy_url = ""

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
            # 关键变量：在源 init 之前注入地址，初始化期间生成的封面代理也能识别。
            setattr(self.target, "_cloud_helper_proxy_url", self.proxy_url)
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
        if method == "__set_proxy__":
            if len(args) != 1 or not isinstance(args[0], str):
                raise WorkerFailure("python_source_protocol_failed")
            self.proxy_url = args[0]
            if self.target is not None:
                setattr(self.target, "_cloud_helper_proxy_url", self.proxy_url)
            return None
        if method == "__proxy__":
            return self.proxy(args)
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

    def proxy(self, args):
        """只调用本实例 localProxy，传入通用请求头，不自动请求任何远端地址。"""
        if len(args) != 2 or not isinstance(args[0], dict) or not isinstance(args[1], dict):
            raise WorkerFailure("python_source_protocol_failed")
        self.initialize()
        function = getattr(self.target, "localProxy", None)
        if not callable(function):
            raise WorkerFailure("python_source_method_missing")
        parameters = dict(args[0])
        parameters["headers"] = dict(args[1])
        parameters["requestHeaders"] = dict(args[1])
        try:
            clear_source_error(self.target)
            result = invoke_function(function, [parameters])
            check_source_error(self.target)
            return proxy_response(result, args[1])
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


def write_response(output, response, maximum_bytes=MAX_RESPONSE_BYTES):
    """输出有界 JSON 行，序列化失败不输出源对象或异常正文。"""
    try:
        line = json.dumps(response, ensure_ascii=False, allow_nan=False, default=json_value, separators=(",", ":"))
        if len(line.encode("utf-8")) + 1 > maximum_bytes:
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
                maximum_bytes = MAX_PROXY_RESPONSE_BYTES if request.get("method") == "__proxy__" else MAX_RESPONSE_BYTES
                write_response(output, {"id": request_id, "ok": True, "value": value}, maximum_bytes)
            except WorkerFailure as error:
                write_response(output, {"id": request_id, "ok": False, "error": {"code": error.code}})
            except BaseException:
                write_response(output, {"id": request_id, "ok": False, "error": {"code": "python_source_protocol_failed"}})
    finally:
        worker.destroy()
        output.close()


if __name__ == "__main__":
    main()
