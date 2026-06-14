# anvilwing

**A terminal coding CLI by Trenchwork.** Claude-Code-class UX, [DeepSeek v4 Pro](https://www.deepseek.com/) on your own keys, with capabilities most competitors don't have: `/loop` and scheduled cloud runs, always-on ultracode, background threaded agents, and connected web/iOS control of a real session running on your own machine.

> This repository is the public home for **install, usage, and issues**. The CLI itself is proprietary — file bugs and feature requests here.

[![npm](https://img.shields.io/npm/v/anvilwing)](https://www.npmjs.com/package/anvilwing) · [anvilwing.com](https://anvilwing.com)

## Install

```sh
npm i -g anvilwing
```

Node 18+. Bring your own DeepSeek API key (and, optionally, a Tavily key for web search).

## Quickstart

```sh
anvilwing
```

Then, inside the CLI:

- **`/connect`** — set your DeepSeek (and optional Tavily) API key. Keys are stored in your OS keychain, never in plaintext on disk.
- **`/model`** — switch between `deepseek-v4-pro` and `deepseek-v4-flash` (both run on max thinking).
- **`/loop [interval] <task>`** — run a task on a cadence, or self-paced, for long-horizon work.

`Shift+Tab` cycles permission modes (plan mode is read-only). Type follow-ups while it works — they queue and run on the next turn.

## What it does

- **Ultracode, always on.** Every substantial turn runs on max thinking budget with a phased discipline baked in: research → verify load-bearing facts → design → build the real thing → adversarially verify. Trivial turns stay direct.
- **Background threaded agents.** Long jobs run detached and in parallel, each with its own isolated output — concurrent threads never cross-talk. Pending and completed threads are tracked separately.
- **`/loop` + scheduled cloud runs.** Run a task on an interval or self-paced, and scale it to unattended cloud agents that pick work, implement it with a fail-before/pass-after test, verify, and push.
- **Connected web + iOS.** The agent loop is headless, so a web dashboard or iOS/Watch app can drive a real session on *your own connected computer* — not an isolated cloud sandbox.
- **Live research past the cutoff.** Knows the current date and verifies time-sensitive facts (latest versions, current events, prices) live via web search instead of answering from stale training data.
- **10 runtime themes.** `Ctrl+T` switches between Space Black, Twitch Purple, Dracula, Nord, Tokyo Night, Catppuccin Mocha, Gruvbox, Solarized, One Dark, and Rosé Pine — live and persisted.
- **Your-own-keys DeepSeek v4 Pro** at a 1M-token context, with an always-on adversarial verifier and full shell / file / search / web-search tooling.
- **Authorized security testing** is supported — for use on systems you own or are authorized to test.

## Reporting issues

Open an [issue](https://github.com/Aroxora/anvilwing/issues) with your OS, Node version, `anvilwing --version`, and the exact steps to reproduce.

## License

Proprietary — see [LICENSE](LICENSE). © Trenchwork AI. Not affiliated with or endorsed by Anthropic; "Claude Code" is referenced for comparison only.
