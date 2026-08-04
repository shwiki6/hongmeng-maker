#!/usr/bin/env python3
"""Standalone WeChat Official Account article publisher.

Credentials come from the skill-local wechat.env file or WECHAT_APPID and
WECHAT_APPSECRET environment variables. No project-specific endpoint, session,
database, or local application is required.
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import pathlib
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid

API = "https://api.weixin.qq.com"
MAX_COVER = 2 * 1024 * 1024
ENV_FILE = pathlib.Path(__file__).resolve().parents[1] / "wechat.env"


def load_env_file() -> None:
    """Load simple KEY=VALUE entries without adding a dotenv dependency."""
    path = pathlib.Path(os.environ.get("WECHAT_ENV_FILE", str(ENV_FILE)))
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key and key not in os.environ:
            os.environ[key] = value


def fail(message: str, code: int = 1) -> None:
    print(json.dumps({"success": False, "message": message}, ensure_ascii=False), file=sys.stderr)
    raise SystemExit(code)


def request_json(url: str, payload: dict | None = None, method: str = "POST") -> dict:
    body = None if method == "GET" else json.dumps(payload or {}, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method=method,
        headers={} if method == "GET" else {"Content-Type": "application/json; charset=utf-8"},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            data = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError) as exc:
        fail(f"微信 JSON 接口请求失败: {exc}")
    if int(data.get("errcode", 0)) != 0:
        fail(f"微信接口错误: {data.get('errmsg', data.get('errcode'))}")
    return data


def credentials() -> tuple[str, str]:
    appid = os.environ.get("WECHAT_APPID", "").strip()
    secret = os.environ.get("WECHAT_APPSECRET", "").strip()
    placeholders = ("replace_with_", "your_", "<", ">")
    if not appid or not secret or any(mark in appid.lower() or mark in secret.lower() for mark in placeholders):
        fail("请先编辑技能目录中的 wechat.env，填写真实的 WECHAT_APPID 和 WECHAT_APPSECRET")
    return appid, secret


def access_token() -> str:
    appid, secret = credentials()
    query = urllib.parse.urlencode({"grant_type": "client_credential", "appid": appid, "secret": secret})
    data = request_json(f"{API}/cgi-bin/token?{query}", method="GET")
    token = data.get("access_token")
    if not token:
        fail("微信没有返回 access_token")
    return str(token)


def multipart_request(url: str, field: str, path: pathlib.Path, mime: str) -> dict:
    content = path.read_bytes()
    boundary = uuid.uuid4().hex
    filename = path.name.replace('"', "_")
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'
        f"Content-Type: {mime}\r\n\r\n"
    ).encode() + content + f"\r\n--{boundary}--\r\n".encode()
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            data = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError) as exc:
        fail(f"微信素材接口请求失败: {exc}")
    if int(data.get("errcode", 0)) != 0:
        fail(f"微信素材接口错误: {data.get('errmsg', data.get('errcode'))}")
    return data


def upload_cover(token: str, cover: str) -> str:
    path = pathlib.Path(cover)
    if not path.is_file():
        fail(f"封面文件不存在: {path}")
    if path.stat().st_size > MAX_COVER:
        fail("封面不能超过 2MB")
    mime = mimetypes.guess_type(path.name)[0] or ""
    if mime not in {"image/jpeg", "image/png", "image/gif"}:
        fail("封面仅支持 JPG、PNG、GIF；SVG 不能直接作为微信封面")
    query = urllib.parse.urlencode({"access_token": token, "type": "image"})
    data = multipart_request(f"{API}/cgi-bin/material/add_material?{query}", "media", path, mime)
    media_id = data.get("media_id")
    if not media_id:
        fail("微信没有返回封面 media_id")
    return str(media_id)


def rasterize_svg(svg_path: str) -> pathlib.Path:
    """Convert generated SVG artwork to a temporary PNG for WeChat cover upload."""
    source = pathlib.Path(svg_path)
    if not source.is_file():
        fail(f"SVG 封面文件不存在: {source}")
    fd, output_name = tempfile.mkstemp(prefix="wechat-cover-", suffix=".png")
    os.close(fd)
    output = pathlib.Path(output_name)
    # Let ImageMagick create the PNG instead of relying on an empty placeholder.
    output.unlink(missing_ok=True)
    try:
        subprocess.run(
            ["convert", "-background", "none", str(source), str(output)],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
    except FileNotFoundError:
        output.unlink(missing_ok=True)
        fail("未找到 ImageMagick convert，无法把 SVG 转成 PNG 封面")
    except subprocess.CalledProcessError as exc:
        output.unlink(missing_ok=True)
        fail(f"SVG 转 PNG 失败: {exc.stderr.strip()}")
    if output.stat().st_size > MAX_COVER:
        output.unlink(missing_ok=True)
        fail("SVG 转换后的 PNG 封面超过 2MB")
    return output


def read_content(args: argparse.Namespace) -> str:
    if args.content_file:
        content = pathlib.Path(args.content_file).read_text(encoding="utf-8")
    else:
        content = args.content or ""
    content = content.strip()
    if not content:
        fail("文章正文不能为空")
    if len(content) > 200000:
        fail("文章正文不能超过 200000 个字符")
    return content


def create_draft(args: argparse.Namespace, token: str) -> dict:
    title = args.title.strip()
    author = args.author.strip()
    digest = args.digest.strip()
    if not title or len(title) > 64:
        fail("标题不能为空且不能超过 64 个字符")
    if len(author) > 32 or len(digest) > 120:
        fail("作者最多 32 个字符，摘要最多 120 个字符")
    # Generated SVG is the preferred cover path. Existing material IDs are an
    # explicit fallback only, never selected implicitly.
    thumb = ""
    if args.cover_svg:
        raster = rasterize_svg(args.cover_svg)
        try:
            thumb = upload_cover(token, str(raster))
        finally:
            raster.unlink(missing_ok=True)
    elif args.cover:
        thumb = upload_cover(token, args.cover)
    elif args.thumb_media_id.strip():
        thumb = args.thumb_media_id.strip()
    else:
        fail("请提供 --cover-svg（默认推荐）、--cover，或明确指定 --thumb-media-id")
    source = args.source_url.strip()
    if source and urllib.parse.urlparse(source).scheme not in {"http", "https"}:
        fail("--source-url 必须是 http:// 或 https:// 地址")
    payload = {"articles": [{
        "title": title,
        "author": author,
        "digest": digest,
        "content": read_content(args),
        "content_source_url": source,
        "thumb_media_id": thumb,
        "need_open_comment": 0,
        "only_fans_can_comment": 0,
    }]}
    data = request_json(f"{API}/cgi-bin/draft/add?access_token={urllib.parse.quote(token)}", payload)
    return {"success": True, "media_id": data.get("media_id"), "cover_media_id": thumb, "message": "草稿创建成功"}


def publish_draft(token: str, media_id: str, confirm: bool) -> dict:
    if not confirm:
        fail("发布不可撤回；请添加 --confirm 明确确认")
    if not media_id.strip():
        fail("草稿 media_id 不能为空")
    request_json(f"{API}/cgi-bin/freepublish/submit?access_token={urllib.parse.quote(token)}", {"media_id": media_id.strip()})
    return {"success": True, "message": "文章已提交发布", "media_id": media_id.strip()}


def main() -> None:
    load_env_file()
    parser = argparse.ArgumentParser(description="独立微信图文草稿与发布工具")
    sub = parser.add_subparsers(dest="command", required=True)
    draft = sub.add_parser("create-draft", help="创建微信草稿")
    draft.add_argument("--title", required=True)
    draft.add_argument("--author", default="")
    draft.add_argument("--digest", default="")
    draft.add_argument("--content")
    draft.add_argument("--content-file")
    draft.add_argument("--source-url", default="")
    draft.add_argument("--thumb-media-id", default="")
    draft.add_argument("--cover-svg", help="优先使用：生成的 SVG 封面，自动转换为 PNG 上传")
    draft.add_argument("--cover", help="已有 JPG/PNG/GIF 封面；不会自动使用素材库图片")
    publish = sub.add_parser("publish", help="发布已有草稿")
    publish.add_argument("--media-id", required=True)
    publish.add_argument("--confirm", action="store_true")
    args = parser.parse_args()
    token = access_token()
    result = create_draft(args, token) if args.command == "create-draft" else publish_draft(token, args.media_id, args.confirm)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
