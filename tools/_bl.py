#!/usr/bin/env python3
"""Talk to the blender-mcp addon's socket directly.

The MCP wrapper (`uvx blender-mcp`) speaks this same protocol; driving the
socket ourselves means the channel works inside the session that set it up,
rather than only in the next one.
"""
import json, socket, sys

def call(cmd, params=None, timeout=120):
    s = socket.create_connection(("127.0.0.1", 9876), timeout=timeout)
    try:
        s.sendall(json.dumps({"type": cmd, "params": params or {}}).encode())
        chunks = []
        s.settimeout(timeout)
        while True:
            b = s.recv(65536)
            if not b:
                break
            chunks.append(b)
            try:
                return json.loads(b"".join(chunks).decode())
            except json.JSONDecodeError:
                continue
        raise RuntimeError("connection closed before a full reply")
    finally:
        s.close()

def code(src, timeout=180):
    r = call("execute_code", {"code": src}, timeout)
    if r.get("status") != "success":
        raise RuntimeError(r.get("message") or r)
    return r["result"]

if __name__ == "__main__":
    if sys.argv[1] == "code":
        print(json.dumps(code(sys.stdin.read()), indent=1)[:4000])
    else:
        print(json.dumps(call(sys.argv[1]), indent=1)[:4000])
