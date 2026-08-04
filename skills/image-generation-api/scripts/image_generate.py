#!/usr/bin/env python3
"""Standalone OpenAI-compatible image generation client."""
from __future__ import annotations

import argparse
import base64
import json
import os
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request

ENV_FILE = pathlib.Path(__file__).resolve().parents[1] / "image.env"


def fail(message: str) -> None:
    print(f"错误: {message}", file=sys.stderr)
    raise SystemExit(1)


def load_env() -> None:
    path = pathlib.Path(os.environ.get("IMAGE_ENV_FILE", str(ENV_FILE)))
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


def config() -> tuple[str, str]:
    load_env()
    base = os.environ.get("IMAGE_API_BASE_URL", "").strip().rstrip("/")
    key = os.environ.get("IMAGE_API_KEY", "").strip()
    if not base or not key or key == "REPLACE_WITH_API_KEY":
        fail("请在技能目录的 image.env 中填写 IMAGE_API_BASE_URL 和 IMAGE_API_KEY")
    return base, key


def request_json(url: str, key: str, method: str = "GET", payload: dict | None = None, retry_without_response_format: bool = True) -> dict:
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url, data=data, method=method,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = "HTTP " + str(exc.code)
        try:
            body = json.loads(exc.read().decode("utf-8"))
            error = body.get("error", body) if isinstance(body, dict) else body
            if isinstance(error, dict) and error.get("message"):
                detail = str(error["message"])
            elif isinstance(error, str):
                detail = error
        except (UnicodeDecodeError, json.JSONDecodeError):
            pass
        if (retry_without_response_format and payload and "response_format" in payload
                and "response_format" in detail):
            retry_payload = dict(payload)
            retry_payload.pop("response_format", None)
            return request_json(url, key, method, retry_payload, retry_without_response_format=False)
        fail(f"图片接口请求失败: {detail}")
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        fail(f"图片接口请求失败: {getattr(exc, 'reason', str(exc))}")
    if not isinstance(result, dict):
        fail("图片接口返回格式无效")
    if result.get("error"):
        error = result["error"]
        fail(error.get("message", "接口返回错误") if isinstance(error, dict) else str(error))
    return result


def list_models() -> None:
    base, key = config()
    result = request_json(f"{base}/models", key)
    entries = result.get("data", [])
    if not isinstance(entries, list):
        fail("模型列表格式无效")
    for entry in entries:
        if isinstance(entry, dict) and entry.get("id"):
            print(entry["id"])


def choose_model(base: str, key: str, requested: str) -> str:
    selected = requested.strip() or os.environ.get("IMAGE_MODEL", "").strip()
    if selected:
        return selected
    result = request_json(f"{base}/models", key)
    entries = result.get("data", [])
    ids = [str(item["id"]) for item in entries if isinstance(item, dict) and item.get("id")]
    if not ids:
        fail("没有找到可用模型，请在 image.env 填写 IMAGE_MODEL")
    hints = ("image", "dall", "flux", "sd", "gemini", "qwen", "画")
    return next((item for item in ids if any(hint in item.lower() for hint in hints)), ids[0])


def save_item(item: dict, path: pathlib.Path) -> pathlib.Path:
    if item.get("b64_json"):
        try:
            content = base64.b64decode(item["b64_json"], validate=True)
        except (ValueError, TypeError) as exc:
            fail(f"图片 base64 无效: {exc}")
    elif item.get("url"):
        url = str(item["url"])
        if urllib.parse.urlparse(url).scheme not in {"http", "https"}:
            fail("图片 URL 必须是 http:// 或 https://")
        request = urllib.request.Request(url, headers={"User-Agent": "codex-image-generation-skill/1.0"})
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                content = response.read()
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as exc:
            fail(f"图片下载失败: {getattr(exc, 'reason', str(exc))}")
    else:
        fail("接口结果缺少 b64_json 或 url")
    if not content:
        fail("接口返回了空图片")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    if path.stat().st_size == 0:
        fail("图片保存失败")
    return path


def generate(args: argparse.Namespace) -> None:
    base, key = config()
    model = choose_model(base, key, args.model)
    payload = {"model": model, "prompt": args.prompt, "n": args.n, "size": args.size, "response_format": "b64_json"}
    result = request_json(f"{base}/images/generations", key, "POST", payload)
    entries = result.get("data", [])
    if not isinstance(entries, list) or not entries:
        fail("接口没有返回图片")
    target = pathlib.Path(args.output).expanduser()
    for index, item in enumerate(entries, 1):
        if not isinstance(item, dict):
            fail("图片结果格式无效")
        path = target if len(entries) == 1 else target.with_name(f"{target.stem}-{index}{target.suffix}")
        print(save_item(item, path))


def main() -> None:
    parser = argparse.ArgumentParser(description="调用独立 OpenAI 兼容生图接口")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list-models", help="列出接口可用模型")
    command = sub.add_parser("generate", help="生成图片并保存到本地")
    command.add_argument("--prompt", required=True)
    command.add_argument("--output", required=True)
    command.add_argument("--model", default="")
    command.add_argument("--size", default="1024x1024")
    command.add_argument("--n", type=int, default=1)
    args = parser.parse_args()
    if args.command == "list-models":
        list_models()
    else:
        if not 1 <= args.n <= 4:
            fail("--n 必须在 1 到 4 之间")
        generate(args)


if __name__ == "__main__":
    main()
