"""常用 base.spider 兼容接口；只提供 requests 会话和基础工具。"""

import json as json_module
import sys


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
