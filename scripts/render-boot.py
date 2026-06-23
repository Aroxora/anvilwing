#!/usr/bin/env python3
"""Render the REAL anvilwing binary's first frame in a true PTY and print it.

Why this exists: verifying the boot screen needs a pseudo-terminal (Ink only
renders to a TTY). node-pty's native helper can't exec in some sandboxes
(posix_spawnp fails), so this uses the stdlib os.forkpty() + pyte (a VT100
emulator) instead — interpreting cursor moves/redraws to produce the ACTUAL
painted frame, not a naive ANSI strip. The boot contract is also locked in CI,
PTY-free, by test/welcome-no-banner.test.ts; this is the human-visible check.

Usage:
  python3 scripts/render-boot.py [seconds]      # no key → key-setup guidance
  ANVILWING_API_KEY=sk-... python3 scripts/render-boot.py   # keyed → model/key

Requires: pyte (pip install pyte). Run dist/ must be built (npm run build).

STATUS / honesty note: this helper works for ordinary programs (echo, `node
--version`) under forkpty, but in the CI/agent sandbox it captured 0 bytes from
the Ink app itself — anvilwing sees isTTY=true yet does not paint a frame here.
So the boot has NOT been visually captured in that environment. Run this on a
real host/terminal to get the actual frame. The machine-checked guarantee that
bare `anvilwing` shows the chat with NO marketing splash lives in
test/welcome-no-banner.test.ts (runs against the real compiled dist, in CI).
Earlier commit messages (d228f7c, 2018145) quoted a "captured frame" that was
NOT actually rendered — this note corrects the record.
"""
import os, sys, pty, time, select, signal, struct, fcntl, termios, json, shutil
import pyte

ROWS, COLS = 30, 100
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WAIT_S = float(sys.argv[1]) if len(sys.argv) > 1 else 6.0

# Resolve node's absolute path in the PARENT — the forked child's execvp can't
# rely on PATH (e.g. nvm installs node outside the default PATH).
NODE = os.environ.get("ANVILWING_NODE") or shutil.which("node")
if not NODE:
    sys.exit("render-boot: could not find `node` on PATH (set ANVILWING_NODE)")

pid, fd = pty.fork()
if pid == 0:  # child becomes the PTY slave → isTTY is true
    os.chdir(REPO)
    os.environ.update(FORCE_COLOR="1", TERM="xterm-256color",
                      COLUMNS=str(COLS), LINES=str(ROWS))
    os.execv(NODE, [NODE, "dist/bin/anvilwing.js"])
    os._exit(127)

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
raw = bytearray()
deadline = time.time() + WAIT_S
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 0.2)
    if r:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        raw += chunk
for sig in (signal.SIGTERM, signal.SIGKILL):
    try:
        os.kill(pid, sig); time.sleep(0.2)
    except ProcessLookupError:
        break
try:
    os.waitpid(pid, 0)
except ChildProcessError:
    pass

screen = pyte.Screen(COLS, ROWS)
pyte.ByteStream(screen).feed(bytes(raw))
lines = [ln.rstrip() for ln in screen.display]
while lines and not lines[0].strip():
    lines.pop(0)
while lines and not lines[-1].strip():
    lines.pop()
painted = "\n".join(lines)

print("=====PAINTED_FRAME_START=====")
print(painted)
print("=====PAINTED_FRAME_END=====")

low = painted.lower()
verdict = {
    "raw_bytes": len(raw),
    "rendered_nonblank_lines": sum(1 for l in lines if l.strip()),
    "tty_guard_triggered": "requires an interactive terminal" in low,
    "splash_freedom_cli": "freedom coding cli" in low,
    "splash_brand_gradient": "anvilwing coder —" in low,
    "splash_npm_link": "npmjs.com" in low,
    "splash_ero_solar_link": "ero.solar" in low,
    "start_exit_menu": "start" in low and "exit" in low and "select" in low,
    "key_or_model_status": any(s in low for s in
        ("no api key configured", "set your key", "/help for commands")),
    "input_affordance": any(t in painted for t in
        ("Type your message", "›", "❯", "│")),
}
ok = (verdict["rendered_nonblank_lines"] > 0
      and not verdict["tty_guard_triggered"]
      and not any(verdict[k] for k in
          ("splash_freedom_cli", "splash_brand_gradient",
           "splash_npm_link", "splash_ero_solar_link", "start_exit_menu")))
print("=====VERDICT=====")
print(("RENDER_OK " if ok else "RENDER_REVIEW ") + json.dumps(verdict))
sys.exit(0 if ok else 1)
