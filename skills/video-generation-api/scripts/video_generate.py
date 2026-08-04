#!/usr/bin/env python3
"""Standalone asynchronous OpenAI-compatible video client."""
from __future__ import annotations
import argparse, json, os, pathlib, sys, time, urllib.error, urllib.parse, urllib.request

ENV_FILE = pathlib.Path(__file__).resolve().parents[1] / "video.env"

def fail(message: str) -> None:
    print(f"错误: {message}", file=sys.stderr)
    raise SystemExit(1)

def load_env() -> None:
    path = pathlib.Path(os.environ.get("VIDEO_ENV_FILE", str(ENV_FILE)))
    if not path.is_file(): return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line: continue
        key, value = (part.strip() for part in line.split("=", 1))
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'": value = value[1:-1]
        if key and key not in os.environ: os.environ[key] = value

def config() -> tuple[str, str]:
    load_env()
    base, key = os.environ.get("VIDEO_API_BASE_URL", "").strip().rstrip("/"), os.environ.get("VIDEO_API_KEY", "").strip()
    if not base or not key or key.startswith("REPLACE_"): fail("请在技能目录的 video.env 中填写接口地址和密钥")
    return base, key

def request_json(url: str, key: str, method: str = "GET", payload: dict | None = None) -> dict:
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode()
    req = urllib.request.Request(url, data=data, method=method, headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as response: result = json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        detail = f"HTTP {exc.code}"
        try:
            body = json.loads(exc.read().decode()); err = body.get("error", body) if isinstance(body, dict) else body
            if isinstance(err, dict): detail = str(err.get("message", err.get("code", detail)))
            elif isinstance(err, str): detail = err
        except (UnicodeDecodeError, json.JSONDecodeError): pass
        fail(f"视频接口请求失败: {detail}")
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        fail(f"视频接口请求失败: {getattr(exc, 'reason', str(exc))}")
    if not isinstance(result, dict): fail("视频接口返回格式无效")
    if result.get("error"): fail(str(result["error"].get("message", result["error"]) if isinstance(result["error"], dict) else result["error"]))
    return result

def nested(data: dict, *keys: str):
    value = data
    for key in keys:
        if not isinstance(value, dict): return None
        value = value.get(key)
    return value

def list_models() -> None:
    base, key = config(); data = request_json(f"{base}/models", key).get("data", [])
    for item in data if isinstance(data, list) else []:
        if isinstance(item, dict) and item.get("id"): print(item["id"])

def generate(args: argparse.Namespace) -> None:
    base, key = config(); model = args.model or os.environ.get("VIDEO_MODEL", "agnes-video-v2.0")
    payload = {"model": model, "prompt": args.prompt, "seconds": str(args.seconds), "size": args.size}
    result = request_json(f"{base}/video/generations", key, "POST", payload)
    task = result.get("task_id") or result.get("id") or nested(result, "data", "task_id") or nested(result, "data", "id")
    if not task: fail("视频接口没有返回任务 ID")
    interval = max(1, int(os.environ.get("VIDEO_POLL_SECONDS", "5"))); timeout = max(interval, int(os.environ.get("VIDEO_TIMEOUT_SECONDS", "600")))
    started = time.monotonic()
    while time.monotonic() - started <= timeout:
        time.sleep(interval)
        status = request_json(f"{base}/video/generations?task_id={urllib.parse.quote(str(task))}", key)
        state = str(status.get("status") or nested(status, "data", "status") or "").lower()
        if state in {"failed", "error", "cancelled"}: fail(f"视频生成失败: {status.get('message', state)}")
        url = status.get("video_url") or status.get("url") or nested(status, "data", "video_url") or nested(status, "data", "url")
        if url:
            if urllib.parse.urlparse(str(url)).scheme not in {"http", "https"}: fail("视频 URL 必须是 http:// 或 https://")
            req = urllib.request.Request(str(url), headers={"User-Agent": "codex-video-generation-skill/1.0"})
            try:
                with urllib.request.urlopen(req, timeout=180) as response: content = response.read()
            except (urllib.error.URLError, TimeoutError) as exc: fail(f"视频下载失败: {getattr(exc, 'reason', str(exc))}")
            if not content: fail("下载到的影片为空")
            output = pathlib.Path(args.output).expanduser(); output.parent.mkdir(parents=True, exist_ok=True); output.write_bytes(content)
            if output.stat().st_size == 0: fail("视频保存失败")
            print(output); return
        print(f"状态: {state or 'processing'}", file=sys.stderr)
    fail("视频生成超时，请稍后使用任务 ID 查询")

def main() -> None:
    parser = argparse.ArgumentParser(description="调用独立异步视频生成接口")
    sub = parser.add_subparsers(dest="command", required=True); sub.add_parser("list-models")
    gen = sub.add_parser("generate"); gen.add_argument("--prompt", required=True); gen.add_argument("--output", required=True); gen.add_argument("--model", default=""); gen.add_argument("--seconds", type=int, default=5); gen.add_argument("--size", default="1280x720")
    args = parser.parse_args()
    if args.command == "list-models": list_models()
    else:
        if not 1 <= args.seconds <= 20: fail("--seconds 必须在 1 到 20 之间")
        generate(args)
if __name__ == "__main__": main()
