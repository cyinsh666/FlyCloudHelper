"""YSP 专用运行入口：保留上传脚本原始字节，补齐 HLS 属性内相对资源地址。"""
import argparse
import re
import runpy
import sys
import urllib.parse
import urllib.request


def absolute_attributes(text, base_url):
    """密钥、初始化段和子清单属性按实际源地址解析，不能误指向私有网关根目录。"""
    return re.sub(r'URI="([^"]+)"', lambda match: 'URI="' + urllib.parse.urljoin(base_url, match.group(1)) + '"', text)


def fetch_playlist(url, depth=0):
    """沿用 YSP 普通线路请求头与主清单选择规则，并为完整 URI 保留最终重定向基址。"""
    request = urllib.request.Request(url, headers={
        "User-Agent": "qqlive", "Referer": "https://live.cctv.cn/",
        "Accept": "application/vnd.apple.mpegurl,application/json,*/*", "Accept-Encoding": "identity"})
    with urllib.request.urlopen(request, timeout=10) as response:
        raw = response.read(2 * 1024 * 1024 + 1)
        final_url = response.geturl()
    if len(raw) > 2 * 1024 * 1024:
        raise ValueError("直播播放清单过大")
    text = raw.decode("utf-8", "replace")
    lines = text.splitlines()
    if depth < 2:
        for index, line in enumerate(lines):
            if line.strip().startswith("#EXT-X-STREAM-INF"):
                for child in lines[index + 1:]:
                    if child.strip() and not child.strip().startswith("#"):
                        return fetch_playlist(urllib.parse.urljoin(final_url, child.strip()), depth + 1)
                break
    return "\n".join(absolute_attributes(line, final_url) if not line.strip() or line.strip().startswith("#")
                     else urllib.parse.urljoin(final_url, line.strip()) for line in lines)


def main():
    """只装配已识别 YSP 的固定适配点，启动参数和数据目录仍由云助手统一管理。"""
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--script", required=True)
    arguments, source_arguments = parser.parse_known_args()
    namespace = runpy.run_path(arguments.script, run_name="__cloud_helper_ysp__")
    module = namespace["main"].__globals__
    original_rewrite = module["rewrite_playlist_urls"]

    def rewrite_playlist(text, base_url):
        """设备线路保留原有分片签名代理，只补充 HLS 属性中的绝对地址。"""
        return absolute_attributes(original_rewrite(text, base_url), base_url)

    module["rewrite_playlist_urls"] = rewrite_playlist
    module["fetch_abs_playlist"] = fetch_playlist
    sys.argv = [arguments.script] + source_arguments
    module["main"]()


if __name__ == "__main__":
    main()
