# Anvilwing Coder

[![npm version](https://img.shields.io/npm/v/anvilwing)](https://www.npmjs.com/package/anvilwing)
[![CI](https://github.com/Aroxora/anvilwing/actions/workflows/ci.yml/badge.svg)](https://github.com/Aroxora/anvilwing/actions/workflows/ci.yml)

**A Claude Code–class terminal coding agent you fully control — for a fraction of the price.**

Anvilwing Coder is an Ink-rendered CLI coding agent (the same terminal-UI engine Claude Code uses) that reads code, edits files, runs commands, and searches the web — rendered with the exact `⏺` / `⎿` transcript shape, permission modes, and colored diffs you know from Claude Code. The difference: it runs on **Anvilwing v4 Pro at max thought** with **your own API keys**, so a month of heavy daily use costs less than a *single* Claude Max 20× subscription, and it does the work you ask without an approval-nag or hosted-refusal layer in the way.

```bash
npm install -g anvilwing
anvilwing
```

---

## Why Anvilwing

| | Anvilwing Coder | Claude Code (Max 20×) |
|---|---|---|
| **Model** | Anvilwing v4 Pro, 1M context, **max thinking budget always on** | Claude Opus/Sonnet |
| **Cost** | Your Anvilwing + Tavily keys — **~$10–30/mo heavy use** | **$200/mo** flat subscription |
| **Control** | No approval nags, no hosted-refusal layer — runs your tools and commands | Vendor approval/permission prompts |
| **Operating mode** | **Ultracode baked in** — phased, long-horizon, multi-file, self-verifying | `/effort` levels, opt-in |
| **UX** | Ink TUI · `⏺`/`⎿` · colored diffs · Shift+Tab permission modes · adversarial verifier | Ink TUI · diffs · permission modes |
| **Account** | None. Bring your own key, no login | Anthropic account + subscription |
| **Design** | Open + inspectable | Closed |

### A fraction of the cost

Anvilwing v4 Pro lists at **$0.435 / 1M input tokens** and **$0.87 / 1M output tokens** (cache-hit input is ~$0.0036/1M — a ~99% discount on the stable prompt prefixes a coding agent reuses constantly). Tavily web search has a **free 1,000-credit/month tier** that covers normal use.

In the maintainer's own testing, a full month of heavy daily use — the equivalent of maxing a Claude **Max 20×** plan every week — came to **under $50** across Anvilwing + Tavily combined. At list rates that pencils out to roughly **$10–30/month** for 30–50M tokens of real coding-agent work. Claude Max 20× is **$200/month** flat.

> Numbers are list pricing as of June 2026 (Anvilwing `api-docs` pricing; Tavily pricing; Anthropic `claude.com/pricing/max`). The "<$50/mo" figure is the maintainer's measured spend, not a list-rate guarantee — your mileage depends on token volume and cache-hit rate.

### Built for long horizons (ultracode, always on)

Ultracode is **baked in — there is no toggle**. Every session runs Anvilwing v4 Pro on its **maximum thinking budget**, with a system directive tuned for substantial, multi-step work:

- **Phased execution** — research → verify load-bearing facts → design → build the whole thing → verify the result against the real artifact.
- **Living TODO plan** — for large refactors/migrations, it enumerates every unit of work up front, marks progress as it goes, and re-derives what's left so it never loses the thread of a long task.
- **Repo-wide multi-file changes** — it finds *every* affected site first, edits each, then re-searches to confirm nothing was missed.
- **Doesn't stop early** — the task is done only when every TODO item is complete and the build + tests pass.
- **Adversarial self-check** — an always-on critic reviews the finished answer and high-impact tool calls (toggle with `/adversarial`).

Trivial turns stay direct — ultracode does not orchestrate a greeting.

### Looks and works like Claude Code

- **`⏺` action bullets and `⎿` result summaries** — every assistant turn and tool call.
- **Colored diffs after every write/edit** — additions in green, removals in red, context dim, with line numbers (`formatDiffClaudeStyle`).
- **Shift+Tab permission modes** — cycle `default → accept edits → plan`. Plan mode is genuinely read-only: write/edit/bash/commit are blocked at the tool runtime so the agent investigates and proposes a plan before changing anything.
- **Rounded input box**, dim hint line, animated working spinner (`✻ Synthesizing… · esc to interrupt`), and a minimal status line — no emoji chrome. Follow-ups typed while the agent works are accepted live into a transient queue and processed at the next turn boundary (Claude Code parity; no waiting for the full original task).

The example sessions are rendered from the *exact* strings the binary emits (`src/shell/toolPresentation.ts` + `ChatStatic`), so what you see is what the installed CLI prints.

---

## Install & run

```bash
npm install -g anvilwing
```

Exposes the `anvilwing` command on PATH. The bin is **interactive-only**: running it launches the Ink shell. There are no argv flags, no print/headless mode, and a non-TTY invocation (`anvilwing < /dev/null`, piping, CI without a PTY) fails fast on purpose.

```bash
anvilwing           # launch the Ink shell
```

### Keys

Bring your own Anvilwing key (no login, no account):

- In-shell: `/key sk-...`
- Or env: `export ANVILWING_API_KEY=sk-...`

Optional: set a Tavily key for web search (`TAVILY_API_KEY`) — the free tier covers light use; without it the agent falls back to direct page fetches.

### Slash commands

The surface is intentionally lean — the model is locked to `anvilwing` on max thought, so there's nothing to switch:

| Command | Purpose |
|---|---|
| `/key <sk-...>` | Set your Anvilwing API key for this machine |
| `/auto` | Toggle auto-continue (off → on → dual → off) |
| `/bash <cmd>` | Run a one-shot local shell command |
| `/adversarial [on\|off]` | Toggle the always-on adversarial verifier |
| `/debug [on\|off]` | Toggle debug logging |
| `/keys` | Show keyboard shortcuts |
| `/clear` | Clear the screen |
| `/exit` | Quit |

### Keyboard shortcuts

| Key | Action |
|---|---|
| `Shift+Tab` | Cycle permission mode (default · accept edits · plan) |
| `Ctrl+A` / `Home` · `Ctrl+E` / `End` | Start / end of line |
| `←` / `→` | Move cursor |
| `Ctrl+U` / `Ctrl+W` / `Ctrl+K` | Delete to start / word back / to end of line |
| `Ctrl+C` | Clear input / interrupt |
| `Ctrl+D` | Exit |

### Tools the agent can call

Read · Write · Edit · MultiEdit · Bash · Grep · Glob · Web search + fetch · TodoWrite · Memory (persistent across sessions) · Notebook edit · Skills · Git · human-in-the-loop prompts. Pre/post-tool **hooks** load from `.anvilwing/settings.json`.

---

## Authorization scope

Anvilwing Coder runs without the approval and refusal layers hosted assistants add — it executes the commands you give it, including destructive shell, sudo, and security-research tooling that mainstream agents decline. **Use it only on systems you own or are explicitly authorized to test.** Its security does not rest on hiding the source: the design is open to inspection, and what's protected is protected by small, rotatable secrets in the OS keychain / secret store — not obscurity.

---

## Architecture

```
src/
  core/          agent loop, tool runtime, permission modes, adversarial verifier,
                 context manager, secret store, hooks, preferences, sessions
  config.ts      profile + system prompt assembly (ultracode directive baked in)
  providers/     Anvilwing (OpenAI-compatible) provider, thinking forced to max budget
  tools/         Read / Write / Edit / MultiEdit / Bash / Grep / Glob / Web / Todo /
                 Memory / Notebook / Skill / HITL / Git  (+ diffUtils for colored diffs)
  shell/         toolPresentation — the ⏺ / ⎿ transcript formatters
  ui/ink/        Ink renderer — App, Prompt, ChatStatic, StatusLine, Menu, controller
  headless/      interactive shell + CLI bootstrap
CLAUDE.md        contributor conventions (test discipline, research-before-custom-code)
```

## Build & test

```bash
npm install
npx tsc                                          # build
npm test                                         # full jest suite (build + tests)
```

Verification runs in two places, on the "checkable by anyone" principle: a fast local **pre-push hook** and a **public GitHub Actions** workflow (`.github/workflows/ci.yml`) on every push and PR. Install the hook once per checkout:

```bash
git config core.hooksPath scripts/git-hooks
```

Every fix ships with a test that fails before and passes after — UI changes are end-to-end tested against the real binary under a PTY where one can fork, and the rendered output is asserted on real stdout.

## Contributing

Read `CLAUDE.md` first — it documents the testing discipline and the "research before custom code" rules this repo enforces.

## Contact

Bo Shang — building Anvilwing.

- Email: [bo@ero.solar](mailto:bo@ero.solar)
- GitHub: [@Aroxora](https://github.com/Aroxora)
- X: [@ghidradragon](https://x.com/ghidradragon)
- YouTube: [@anvilwingai](https://www.youtube.com/@anvilwingai)
- LinkedIn: [bo-shang](https://www.linkedin.com/in/bo-shang-04923b3a6/)
- Instagram: [@ghidra.dragon](https://www.instagram.com/ghidra.dragon/)

## License

Proprietary — see [`LICENSE`](LICENSE). © 2025 Anvilwing AI. All rights reserved.

---

Anvilwing is an independent project and is not affiliated with or endorsed by Anthropic. "Claude Code" is referenced for comparison only.
