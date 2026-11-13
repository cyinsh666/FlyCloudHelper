# coding=utf-8
"""黄果访客视频源。接口及封面格式参考 HGhubX（66a2cbb），限非商业使用。

PolyForm Noncommercial License 1.0.0: https://polyformproject.org/licenses/noncommercial/1.0.0
Required Notice: Copyright (c) 2026 HGhubX contributors (https://github.com/zxsos/HGhubX)
"""

import base64
import re
from collections import OrderedDict
from urllib.parse import urlencode, urljoin, urlsplit

from base.spider import Spider as BaseSpider


class Spider(BaseSpider):
    """以访客身份读取短剧目录、封面、分集和播放地址。"""

    display_name = "黄果视频源"

    SITE = "https://huangguoai.com"
    API_HOSTS = ("huangguoai.com", "huangguoai.ai")
    # 黄果主站与 HGhubX 已记录的图片 CDN 后缀，代理跳转也使用同一范围。
    COVER_HOSTS = API_HOSTS + ("drleao.cn",)
    CATEGORY = {"type_id": "all", "type_name": "全部短剧", "type_all": True}
    PAGE_SIZE = 20
    MAX_COVER_BYTES = 4 * 1024 * 1024
    COVER_CACHE_BYTES = 16 * 1024 * 1024
    COVER_CACHE_COUNT = 240
    PLAY_LINE = "黄果访客"
    COVER_KEY = b"f5d965df75336270"
    COVER_IV = b"97b60394abc2fbe1"

    def init(self, extend=""):
        """初始化请求头和封面缓存，等待宿主实际发起请求。"""
        self.media_headers = {
            "Referer": self.SITE + "/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                          "AppleWebKit/537.36 (KHTML, like Gecko) "
                          "Chrome/131.0.0.0 Safari/537.36",
        }
        self.cover_cache = OrderedDict()
        self.cover_cache_size = 0

    def _positive_number(self, value):
        """读取源站数字 ID、集号或页码，拒绝布尔值和非数字标识。"""
        raw = str(value)
        return int(raw) if re.fullmatch(r"[1-9][0-9]{0,18}", raw) else 0

    def _https_url(self, value, base, allowed_hosts=(), allow_subdomains=False):
        """补齐相对地址，保持上游签名参数原样；代理请求限定到已知域名。"""
        if not isinstance(value, str) or not value.strip():
            return ""
        try:
            address = urljoin(base, value.strip())
            parsed = urlsplit(address)
            host = parsed.hostname or ""
            if (parsed.scheme != "https" or not host or parsed.port not in (None, 443)
                    or parsed.username is not None or parsed.password is not None):
                return ""
        except ValueError:
            return ""
        if allowed_hosts and not any(host == domain or (allow_subdomains and host.endswith("." + domain))
                                     for domain in allowed_hosts):
            return ""
        return address

    def _edge(self, path, query=None, method="GET", missing_statuses=()):
        """调用 HGhubX 使用的访客网关，保留业务失败与空目录之间的区别。"""
        if query:
            path += "?" + urlencode(query)
        # 逻辑 POST 的播放接口接收空 JSON 对象，网关信封仍使用 HTTP POST。
        envelope = {
            "method": method,
            "path": path,
            "body": base64.b64encode(b"{}").decode("ascii") if method == "POST" else "",
            "content_type": "application/json" if method == "POST" else "",
        }
        target = self.SITE + "/api/edge/request"
        headers = {**self.media_headers, "Accept": "application/json"}
        for _ in range(3):
            with self.post(target, headers=headers, json=envelope, timeout=(4, 8),
                           allow_redirects=False) as response:
                status = response.status_code
                if status in (301, 302, 303) and method == "GET":
                    target = self._https_url(response.headers.get("Location"), target, self.API_HOSTS)
                    if not target:
                        raise RuntimeError("黄果访客网关跳转地址不可用")
                    continue
                if status in missing_statuses:
                    return None
                if status in (401, 403):
                    raise RuntimeError("黄果访客无权访问当前内容")
                if not 200 <= status < 300:
                    raise RuntimeError(f"黄果访客网关返回 HTTP {status}")
                result = response.json()
                if not isinstance(result, dict) or result.get("status") != 1:
                    raise RuntimeError("黄果访客网关未返回成功结果")
                data = result.get("data")
                if not isinstance(data, dict):
                    raise RuntimeError("黄果访客网关返回的数据格式无效")
                return data
        raise RuntimeError("黄果访客网关跳转次数过多")

    def _card(self, item):
        """保留原作品 ID 和卡片字段，封面交给当前媒体库的图片代理。"""
        if not isinstance(item, dict):
            raise RuntimeError("黄果短剧条目格式无效")
        item_id = self._positive_number(item.get("id"))
        title = item.get("title")
        if not item_id or not isinstance(title, str) or not title.strip():
            raise RuntimeError("黄果短剧缺少作品 ID 或标题")
        cover = self._https_url(item.get("cover"), self.SITE + "/", self.COVER_HOSTS, True)
        # 封面定位保存在媒体库，worker 重启后可按原作品 ID 刷新失效的 CDN 地址。
        proxy = self.getProxyUrl()
        cover_url = f"{proxy}&{urlencode({'id': item_id, 'cover': cover})}" if cover and proxy else ""
        return {
            **self.CATEGORY,
            "vod_id": str(item_id),
            "vod_name": title.strip(),
            "vod_pic": cover_url,
            "vod_content": item.get("description") or "",
        }

    def _page(self, path, page, query):
        """读取源站实际页，使用上游返回的分页信息。"""
        data = self._edge(path, {**query, "page": page, "size": self.PAGE_SIZE})
        items = data.get("items")
        pagination = data.get("pagination")
        if not isinstance(items, list) or not isinstance(pagination, dict):
            raise RuntimeError("黄果未返回有效目录或分页")
        pages = self._positive_number(pagination.get("pages"))
        size = self._positive_number(pagination.get("size")) or self.PAGE_SIZE
        result = {"list": [self._card(item) for item in items], "page": page, "limit": size}
        if pages or not items:
            result["pagecount"] = pages or page
        total = pagination.get("total")
        if type(total) is int and total >= 0:
            result["total"] = total
        return result

    def homeContent(self, filter):
        """提供源站的全量视频目录，供管理员建库时选择。"""
        return {"class": [self.CATEGORY.copy()], "list": []}

    def categoryContent(self, tid, pg, filter, extend):
        """按页返回全部短剧的摘要。"""
        page = self._positive_number(pg)
        if str(tid) != self.CATEGORY["type_id"] or not page:
            raise ValueError("黄果分类或页码无效")
        return self._page("/api/videos", page, {})

    def searchContent(self, key, quick, pg="1"):
        """搜索源站视频目录，结果使用同一全量分类。"""
        page = self._positive_number(pg)
        if not page:
            raise ValueError("黄果搜索页码无效")
        keyword = str(key or "").strip()
        if not keyword:
            return {"list": [], "page": page, "pagecount": 1, "total": 0}
        return self._page("/api/search", page, {"q": keyword, "type": "video"})

    def _detail(self, item_id):
        """按作品 ID 读取访客详情，确认返回的仍是同一部剧。"""
        data = self._edge(f"/api/videos/{item_id}", missing_statuses=(404,))
        if data is not None and self._positive_number(data.get("id")) != item_id:
            raise RuntimeError("黄果详情返回的作品 ID 不一致")
        return data

    def detailContent(self, ids):
        """按需读取选集，给云助手保留源站真实集号。"""
        item_id = self._positive_number(ids[0]) if ids else 0
        if not item_id:
            return {"list": []}
        data = self._detail(item_id)
        if data is None:
            return {"list": []}
        episodes = data.get("episodes")
        if not isinstance(episodes, list):
            raise RuntimeError("黄果未返回访客选集")
        # 宿主以「第N集」识别实际集号；取址标识只保留作品 ID 和集号。
        numbers = set()
        for episode in episodes:
            number = self._positive_number(episode.get("ep_num")) if isinstance(episode, dict) else 0
            if number:
                numbers.add(number)
        if not numbers:
            raise RuntimeError("黄果未返回可识别的访客分集")
        return {"list": [{
            **self._card(data),
            "vod_play_from": self.PLAY_LINE,
            "vod_play_url": "#".join(f"第{number}集${item_id}:{number}" for number in sorted(numbers)),
        }]}

    def _play_address(self, data):
        """取上游授权的主播放线路，优先使用现有主线路字段。"""
        streams = data.get("streams")
        main = streams.get("main") if isinstance(streams, dict) else None
        for candidate in (data.get("video_url"), main):
            address = self._https_url(candidate, self.SITE + "/")
            if address:
                return address
        return ""

    def playerContent(self, flag, id, vipFlags):
        """在播放时请求当前集的临时地址，供云助手现有媒体中转使用。"""
        item, _, episode = str(id).partition(":")
        item_id, number = self._positive_number(item), self._positive_number(episode)
        if flag != self.PLAY_LINE or not item_id or not number:
            raise ValueError("黄果分集播放标识无效")
        data = self._edge(f"/api/videos/{item_id}/episodes/{number}/playback", method="POST",
                          missing_statuses=(404, 405))
        address = self._play_address(data or {})
        if not address:
            data = self._edge(f"/api/videos/{item_id}/play", {"ep": number, "page_texts": 0})
            address = self._play_address(data)
        if not address:
            raise RuntimeError("黄果未返回访客可播地址")
        result = {"parse": 0, "url": address, "header": self.media_headers.copy()}
        path = urlsplit(address).path.lower()
        if path.endswith(".m3u8"):
            result["type"] = "hls"
        elif path.endswith(".mp4"):
            result["type"] = "mp4"
        return result

    def _image_type(self, content):
        """按封面实际字节判断格式。"""
        if content.startswith(b"\xff\xd8\xff"):
            return "image/jpeg"
        if content.startswith(b"\x89PNG\r\n\x1a\n"):
            return "image/png"
        if content.startswith((b"GIF87a", b"GIF89a")):
            return "image/gif"
        if content.startswith(b"RIFF") and content[8:12] == b"WEBP":
            return "image/webp"
        return ""

    def _read_cover(self, target):
        """只从源站图片域读取有界封面；过期状态交给调用方刷新地址。"""
        for _ in range(3):
            with self.fetch(target, headers=self.media_headers, stream=True, timeout=(3, 5),
                            allow_redirects=False) as response:
                status = response.status_code
                if status in (301, 302, 303, 307, 308):
                    target = self._https_url(response.headers.get("Location"), target, self.COVER_HOSTS, True)
                    if not target:
                        raise RuntimeError("黄果封面跳转地址不可用")
                    continue
                if status in (401, 403, 404):
                    return None
                if status != 200:
                    raise RuntimeError(f"黄果封面返回 HTTP {status}")
                body = bytearray()
                for chunk in response.iter_content(64 * 1024):
                    if len(body) + len(chunk) > self.MAX_COVER_BYTES:
                        raise RuntimeError("黄果封面超过大小限制")
                    body.extend(chunk)
                return bytes(body)
        raise RuntimeError("黄果封面跳转次数过多")

    def _decode_cover(self, content):
        """返回普通图片，或用源站封面格式解密后再识别 MIME。"""
        mime = self._image_type(content)
        if mime:
            return mime, content
        if not content or len(content) % 16:
            raise RuntimeError("黄果封面格式无效")
        from Crypto.Cipher import AES

        clear = AES.new(self.COVER_KEY, AES.MODE_CBC, self.COVER_IV).decrypt(content)
        padding = clear[-1]
        if 1 <= padding <= 16 and clear[-padding:] == bytes([padding]) * padding:
            clear = clear[:-padding]
        mime = self._image_type(clear)
        if not mime:
            raise RuntimeError("黄果封面解密后未识别为图片")
        return mime, clear

    def localProxy(self, param):
        """通过宿主图片入口返回封面，复用缓存并按需更新过期地址。"""
        item_id = self._positive_number(param.get("id"))
        cover = self._https_url(param.get("cover"), self.SITE + "/", self.COVER_HOSTS, True)
        if not item_id or not cover:
            return [404, "text/plain", b""]
        cache_key = (item_id, cover)
        cached = self.cover_cache.get(cache_key)
        if cached is not None:
            self.cover_cache.move_to_end(cache_key)
            return [200, *cached]
        content = self._read_cover(cover)
        if content is None:
            detail = self._detail(item_id)
            fresh = self._https_url((detail or {}).get("cover"), self.SITE + "/", self.COVER_HOSTS, True)
            if fresh and fresh != cover:
                content = self._read_cover(fresh)
        if content is None:
            return [404, "text/plain", b""]
        mime, image = self._decode_cover(content)
        self.cover_cache[cache_key] = (mime, image)
        self.cover_cache_size += len(image)
        while len(self.cover_cache) > self.COVER_CACHE_COUNT or self.cover_cache_size > self.COVER_CACHE_BYTES:
            _, (_, expired_image) = self.cover_cache.popitem(last=False)
            self.cover_cache_size -= len(expired_image)
        return [200, mime, image]
