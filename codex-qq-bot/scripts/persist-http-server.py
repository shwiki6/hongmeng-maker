#!/usr/bin/env python3
"""Start a fully-detached static HTTP server that survives shell/codex turn exit.

Usage:
  python3 persist-http-server.py --root /path/to/site --port 9901
"""
import argparse
import os
import signal
import socket
import sys
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except Exception:
        return False


def port_open(port: int, host: str = "127.0.0.1", timeout: float = 0.4) -> bool:
    s = socket.socket()
    s.settimeout(timeout)
    try:
        s.connect((host, port))
        return True
    except Exception:
        return False
    finally:
        try:
            s.close()
        except Exception:
            pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--pidfile", default="")
    ap.add_argument("--logfile", default="")
    args = ap.parse_args()

    root = os.path.abspath(args.root)
    if not os.path.isdir(root):
        print(f"ERROR: root not found: {root}", file=sys.stderr)
        sys.exit(2)

    pidfile = args.pidfile or f"/tmp/codex-qq-http-{args.port}.pid"
    logfile = args.logfile or f"/tmp/codex-qq-http-{args.port}.log"

    # Reuse existing healthy server.
    if os.path.exists(pidfile):
        try:
            old = int(open(pidfile).read().strip())
            if pid_alive(old) and port_open(args.port):
                print(f"REUSED pid={old} port={args.port} root={root}")
                print(f"URL http://127.0.0.1:{args.port}/")
                return
            try:
                os.kill(old, signal.SIGTERM)
            except Exception:
                pass
        except Exception:
            pass

    if port_open(args.port):
        print(f"PORT_BUSY port={args.port} (already accepting connections)")
        print(f"URL http://127.0.0.1:{args.port}/")
        return

    # Double-fork daemonize so we leave the caller's session/process group.
    if os.fork() > 0:
        # parent: wait until listen or fail
        for _ in range(40):
            time.sleep(0.1)
            if port_open(args.port):
                pid = open(pidfile).read().strip() if os.path.exists(pidfile) else "?"
                print(f"STARTED pid={pid} port={args.port} root={root}")
                print(f"URL http://127.0.0.1:{args.port}/")
                print(f"LOG {logfile}")
                return
        print("ERROR: server did not become ready", file=sys.stderr)
        sys.exit(1)

    os.setsid()
    if os.fork() > 0:
        os._exit(0)

    os.chdir(root)
    sys.stdout.flush()
    sys.stderr.flush()
    with open(logfile, "a", buffering=1) as log:
        os.dup2(log.fileno(), 1)
        os.dup2(log.fileno(), 2)
    dn = os.open(os.devnull, os.O_RDONLY)
    os.dup2(dn, 0)

    with open(pidfile, "w") as f:
        f.write(str(os.getpid()))

    class QuietHandler(SimpleHTTPRequestHandler):
        def log_message(self, fmt, *a):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % a))
            sys.stderr.flush()

    ThreadingHTTPServer.allow_reuse_address = True
    httpd = ThreadingHTTPServer((args.host, args.port), QuietHandler)
    print(f"DAEMON READY pid={os.getpid()} host={args.host} port={args.port} root={root}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
