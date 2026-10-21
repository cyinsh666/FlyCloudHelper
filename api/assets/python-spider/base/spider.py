"""常用 base.spider 兼容接口；只提供 requests 会话和基础工具。"""

import json as json_module
import html as html_module
import re
import sys
from urllib.parse import urljoin


class Spider:
    """基础 Spider；每个具体源对象保存独立 HTTP Cookie 会话。"""

    def __init__(self):
        """创建会话但不联网；缺少 requests 时交给宿主报告依赖错误。"""
        import requests
        self.session = requests.Session()

    def _session(self):
        """兼容源子类未调用 super 构造函数的情况，首次请求才创建会话。"""
        if not hasattr(self, "session"):
            import requests
            self.session = requests.Session()
        return self.session

    def init(self, extend=""):
        """基础初始化不做网络请求，具体源可以覆盖。"""
        return None

    def fetch(self, url, params=None, headers=None, cookies=None, timeout=15,
              verify=True, stream=False, allow_redirects=True, **kwargs):
        """按 requests GET 语义返回 Response，保留流式、跳转和 Cookie 参数。"""
        return self._session().get(url, params=params, headers=headers, cookies=cookies,
                                   timeout=timeout, verify=verify, stream=stream,
                                   allow_redirects=allow_redirects, **kwargs)

    def post(self, url, data=None, params=None, headers=None, cookies=None, timeout=15,
             verify=True, stream=False, allow_redirects=True, **kwargs):
        """按 requests POST 语义返回 Response，额外 json 等参数直接交给 requests。"""
        return self._session().post(url, data=data, params=params, headers=headers,
                                    cookies=cookies, timeout=timeout, verify=verify,
                                    stream=stream, allow_redirects=allow_redirects, **kwargs)

    def postJson(self, url, json=None, **kwargs):
        """兼容常见 Spider 的 JSON POST 入口，仍使用本源自己的 Cookie 会话。"""
        return self.post(url, json=json, **kwargs)

    def str2json(self, value):
        """兼容旧源的 JSON 文本解析名称，不运行字符串内的脚本。"""
        return self.json(value)

    def cleanText(self, value):
        """移除标题中的 HTML 标签并还原实体，保留原有文字顺序。"""
        text = str(value or "")
        return html_module.unescape(re.sub(r"<[^>]*>", "", text)).strip()

    def regStr(self, value, pattern, group=1):
        """按旧 Spider 的参数约定读取正则分组，没有匹配时返回空文本。"""
        match = re.search(pattern, str(value or ""), re.DOTALL)
        return match.group(group) if match is not None else ""

    def fixUrl(self, value):
        """使用源自己声明的站点基址补齐相对地址。"""
        # 关键变量：只查常用 Spider 属性，不改变源自行配置的站点或授权。
        base_url = next((getattr(self, name) for name in
                         ("host", "HOST", "base_url", "site", "site_url", "siteUrl")
                         if isinstance(getattr(self, name, None), str) and getattr(self, name)), "")
        return urljoin(base_url.rstrip("/") + "/", str(value or ""))

    def html(self, value):
        """使用已安装的 lxml 解析 HTML；依赖缺失时明确交给 worker 报错。"""
        from lxml import etree
        content = value.content if hasattr(value, "content") else value
        if isinstance(content, str):
            content = content.encode("utf-8")
        return etree.HTML(content or b"", parser=etree.HTMLParser(encoding="utf-8", recover=True))

    def xpTextList(self, document, expression):
        """返回 XPath 中的真实文本，不将空结果伪装为默认内容。"""
        if document is None:
            return []
        values = document.xpath(expression)
        if not isinstance(values, list):
            values = [values]
        return ["".join(value.itertext()) if hasattr(value, "itertext") else str(value)
                for value in values]

    def xpText(self, document, expression):
        """兼容只取首个 XPath 文本值的源接口。"""
        values = self.xpTextList(document, expression)
        return values[0] if values else ""

    def setProxyUrl(self, value):
        """仅保存宿主注入的虚拟代理基址，本进程不启动 HTTP 服务。"""
        self._cloud_helper_proxy_url = str(value or "")

    def getProxyUrl(self):
        """让 localProxy 源生成可由云助手识别的虚拟地址。"""
        return getattr(self, "_cloud_helper_proxy_url", "")

    def sourceFailure(self, message):
        """记录本次源调用失败，防止源外层捕获异常后伪装成空目录成功。"""
        self.last_error = "source_request_failed"
        raise RuntimeError(str(message))

    def pageResult(self, items, page, page_count=None, page_size=None, total=None):
        """构造真实分页；没有总量时仅声明有数据页之后仍可继续查询。"""
        if not isinstance(items, list):
            return self.sourceFailure("源站列表结构无效")
        page = max(1, int(page))
        result = {"list": items, "page": page}
        if page_count is not None:
            result["pagecount"] = max(page, int(page_count))
        else:
            result["pagecount"] = page + 1 if items else page
        if page_size is not None and int(page_size) > 0:
            result["limit"] = int(page_size)
        if total is not None:
            result["total"] = max(0, int(total))
        return result

    def json(self, value):
        """把 JSON 文本或 Response 转为 Python 数据，已有字典和列表直接返回。"""
        if isinstance(value, (dict, list)):
            return value
        if hasattr(value, "text"):
            value = value.text
        return json_module.loads(value)

    def log(self, message, *args):
        """记录源日志事件而不输出消息正文，避免日志带出地址、Cookie 或密钥。"""
        record = {"日志关键字": "codex-python-source", "事件": "Python 源调用日志方法",
                  "参数数量": 1 + len(args), "消息类型": type(message).__name__}
        sys.stderr.write(json_module.dumps(record, ensure_ascii=False) + "\n")

    def getName(self):
        """优先使用源明确声明的名称。"""
        return getattr(self, "display_name", self.__class__.__name__)

    def getDependence(self):
        """基础层不主动加载其他源脚本。"""
        return []

    def destroy(self):
        """正常停止时关闭本实例的 HTTP 连接池。"""
        session = getattr(self, "session", None)
        if session is not None:
            session.close()
