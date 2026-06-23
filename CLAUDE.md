# Repo conventions

## Principles

Anvilwing's security and correctness come from transparency, not concealment.
Kerckhoffs's axiom — *don't hinge your security on the secrecy of your design*
— is the principle this repo adopts. Three pillars bind the work:

- **Transparency** — designs are open to scrutiny; a hidden mechanism is
  treated as unverified, not secure. Don't propose a control whose only
  strength is that the source stays private.
- **Verification** — trust is earned by inspection. This is why every fix
  ships with a fail-before/pass-after test, why tests run against the real
  artifact (never a mock standing in for the thing under test), and why the
  agent runs an always-on adversarial verifier (`src/core/adversarial.ts`).
- **Resilience** — keep secrets small, rotatable, and survivable (keys live in
  the OS keychain / secret store via `src/core/secretStore.ts`, never in the
  design). The system must hold when the blueprints are public.

When a design's safety depends on staying hidden, the fix is a better design,
not more secrecy.

## No AI slop / no UI bloat

Do not add text, copy, examples, tips, or "helpful" UI elements that are not strictly required for the application to function. Users can figure out a UI without hand-holding; padding the product with AI-generated guidance is bloat.

Hard rules:

- Do not generate example prompts, placeholder suggestions, "try asking…" hints, sample queries, or starter cards in any UI surface (web, CLI, desktop, popups, empty states). Empty states stay empty unless the user explicitly asks for content there.
- Do not add tooltips, info banners, onboarding steps, welcome blurbs, or explanatory captions that aren't load-bearing. If removing a string would not break a user task, don't add the string.
- Do not pad commit messages, PR descriptions, error messages, or logs with motivational framing, summaries of obvious behavior, or restatements of the diff.
- Do not add code comments that restate what the code does. Only comment when the *why* is non-obvious (hidden constraint, workaround, surprising invariant) — and keep it to one line.
- Do not invent features, settings, or copy that the user did not request. If a task is "fix bug X," fix bug X — don't also add a help link, a confirmation toast, or a settings toggle.
- Do not write README/docs/markdown files unless the user explicitly asks for them.

Before adding any user-visible string, ask: would a competent user fail at their task without this? If no, delete it.

## Tests run real, no compromises

Every test in this repo must exercise real behavior end-to-end. No
mock providers in place of a real LLM call when the test claims to
test the LLM, no fake filesystems when the test claims to test
file I/O, no stubbed network when the test claims to verify
network behavior. Skipping integration depth to make a test pass
is a regression dressed as green.

When a test genuinely cannot run for real in the current
environment (missing credentials, paid API, OS-specific binary,
required external service unavailable), the correct response is:

1. Reject the task with a clear AI-message explaining *exactly*
   what is missing and what the user needs to provide for the
   real test to run.
2. Do **not** ship a mocked / faked / no-op test as a
   substitute. A skipped + reasoned test is honest; a passing
   compromise is dishonest.

The same rule applies to loop iterations and audits: every "this
passes" claim has to come from a run against the real artifact
(real binary, real deployed lambda, real served HTML, real test
fixture on disk). If you cannot run the real thing, surface it.

## Test discipline for security and bug fixes

Every fix that closes a GitHub issue or addresses a security
finding must ship with a test that **fails before the fix and
passes after**. "It compiled" or "I read the code and it looks
right" is not evidence — write the test, run it, paste the
output before claiming the issue is fixed. This rule caught a
real `**` glob-clobbering bug in this repo *because* the test
was written first; without the test, that bug would have
shipped under a "fixed" label.

Concrete contract:

1. **One test file per hardening pass** at `test/v1.<X>-hardening.test.ts`,
   organised as `describe(<title> + <issue number>)` blocks so a reader
   can map every block back to a closed issue.
2. **Mirror small helpers inline** in the test when the source helper
   isn't exported (so the test runs without exposing internals), AND
   add a source-string assertion (`expect(src).toMatch(...)`) so a
   future refactor that drops the fix gets caught at CI time.
3. **Behavioural assertion + source assertion** for every fix.
   Behavioural alone misses cases where someone deletes the impl
   and re-stubs it; source-only misses semantic regressions.
4. **Edge-case table** for any helper that handles untrusted input.
   Use `test.each([...])` with at least one entry per failure mode
   the issue describes (CJK / emoji / combining marks / regional
   indicator pairs / control bytes / bracketed-paste markers).
5. **Run `npx jest --config jest.config.cjs --testPathPatterns "<your-file>"`**
   before commenting "fixed" on the issue, and paste the
   `Tests: N passed, N total` line in the close comment.
6. **No regressions in the full suite.** After hardening tests
   pass, run `npm test` and confirm the existing-suite count is
   unchanged or higher.

When a fix lands without a test, that fix is a draft, not a fix.

## Test gate (local pre-push hook + public CI)

Per the Verification pillar above, "this passes" must be checkable by
anyone, not just on the author's machine. So verification runs in two
places: a fast local pre-push git hook, and a public GitHub Actions
workflow on every push and PR. (An earlier `hardening.yml` was deleted on
2026-05-04 when this was a private solo repo burning Actions-minutes; CI is
back because public, inspectable verification is the whole point — and a
public repo gets free Actions minutes, which removes the original cost
concern.) Three pieces:

- `.github/workflows/ci.yml` — runs `npm ci` + `npm test` (build + full
  suite, including hardening + adversarial tests) on push and PR. The
  green check is the public proof.
- `scripts/git-hooks/pre-push` — runs `npm test` before every push
  (build, full suite, including hardening tests). Install once per
  checkout: `git config core.hooksPath scripts/git-hooks`. Bypass
  in an emergency with `git push --no-verify`.
- `scripts/close-hardening-issue.sh <issue-number> <test-pattern>` —
  helper that runs the hardening tests, pastes the output into a
  GH comment, and closes the issue if green. Use it for every
  hardening-pass close so the comment-and-close pair stays
  consistent.

## Research at every incremental step — to lower the rate of corrections

Corrections after the fact are healthy when new evidence appears.
What's not healthy is the pattern that produced them in this repo's
history: recommending KMS for VAPID encryption without checking that
AWS Secrets Manager was already wired in; closing GitHub issues as
"fixed" without writing the test that would have caught the
pre-existing `globToRegex` `**` clobbering; defaulting to a custom
terminal renderer without checking what Claude Code uses. The fix
isn't to suppress corrections — it's to **make each step research
deeply enough that the obvious miss happens before the response, not
the next message.**

Concrete rule per non-trivial answer / decision / recommendation:

1. **Read the relevant code first.** "Does the codebase already do X?"
   answer it from the file, not from memory. AWS Secrets Manager
   already in the dep graph? `grep -r aws-sdk`. Ink in use somewhere
   else? Look. The answer to "what should I use" should always
   reference what's already there.
2. **Check what comparable tools do.** Claude Code, Cursor, Aider,
   Continue, Cody — their choices are public. For terminal UI / agent
   loops / tool-call protocols / model-pricing UX, default to copying
   their architecture unless the codebase has a specific reason not to.
3. **Run a probe before claiming a behaviour holds.** Five-line
   script + observe > intuition. Tests written *before* a fix
   regularly catch issues no amount of "looks right" inspection does.
4. **Surface uncertainty.** If a step is a guess, label it. "I'm not
   sure, here's the test that would prove it" is fine. "Should work"
   without a test, less so.

The bar isn't perfection — it's reducing the rate at which "actually,
on reflection…" needs to follow a recommendation. Catching a mistake
yourself before sending is the cheap path; the user catching it costs
both of you more.

## Research before custom code

Some problem categories have decisive winners. Writing them yourself
is almost always wrong, and the cost compounds: every later bug fix
pays interest on the original decision. This repo learned that the
hard way with terminal rendering — a custom 6800-line renderer where
Ink would have done the job from day one.

Before authoring more than ~200 LOC of new infrastructure in any of
these categories, search npm + GitHub for an existing library and
document why it doesn't fit before writing custom code:

| Category | Use this | Don't roll your own |
|---|---|---|
| Terminal UI | Ink (the same engine Claude Code uses), blessed, ratatui | Custom escape-sequence emitters |
| Argument parsing | commander, yargs | `process.argv` walking |
| Globbing | picomatch, fast-glob | `String.replace` glob-to-regex |
| Diff | diff (jsdiff) | Manual line comparison |
| Date/time | date-fns, luxon, Temporal | `Date` arithmetic |
| Markdown | marked, remark | Regex parsing |
| Spinners | ora, ink-spinner, listr2 | `setInterval` + cursor moves |
| Process management | execa | Raw `child_process.exec` |
| ANSI escapes | ansi-escapes, sisteransi | Hand-rolled `\x1b[?25l` |
| HTTP retries | got, ky, undici-with-retry | `fetch` + ad-hoc retry loop |
| YAML/TOML | yaml, @iarna/toml | Hand parsing |
| URL parsing | `URL` (built-in) | Regex |

For any decision that will be > 200 LOC of new infrastructure:

1. **Check what comparable tools use.** Claude Code, Cursor, Aider,
   Continue, Cody — their architectural choices are public and were
   iterated for years. Default to copying unless there's a specific
   reason not to.
2. **Read the README + 2–3 issues of the candidate library** to see
   real-world failure modes. If the failure modes match your
   non-functional needs, use it.
3. **Report the research before committing to an approach.**
   Twenty minutes of upfront research saves weeks of compounding cost.

## Renderer / UI changes: end-to-end test the actual user flow

Component tests against the surface I just edited reliably catch the
bug *I was thinking about*. They reliably miss the adjacent bug — the
event the legacy code emitted that I forgot to wire, the integration
between two components I tested in isolation, the visual regression
that only shows up when the real binary writes to a real terminal.

This repo has shipped three bad UI versions in a row that hand-rolled
component tests passed (1.1.0 / 1.1.1 / 1.1.2). Every one would have
been caught by **one** test that did:

1. Spawn the real `anvilwing` binary in a child process.
2. Drive a real keystroke sequence through stdin (e.g. "hi\r").
3. Assert that the captured stdout contains the user's input as a
   chat bubble, the agent's response, and no duplicate text.

Hard rule for renderer / `src/ui/**` / `src/headless/interactiveShell.ts`
changes: a fix is **not shipped** until a test of that shape exists
and passes. The test file naming convention is
`test/e2e-<feature>.test.ts`. If the test can't run in the CI
environment (e.g. needs an LLM key), it must run locally before
publish — and that local run's output is pasted into the PR / commit
message as evidence.

What to do when an end-to-end test isn't feasible: label the change
"patched the code path I changed; needs E2E verification" rather than
"fixed and shipped." The user can decide whether to take the risk.
This is the rule that distinguishes "I tested what I changed" from
"I verified the user-visible flow."

## Catching real failures (not hallucinated ones) in CLAUDE.md rules

The rules above are useful only if they're *applied to the real
artifact*, not to a mental model of it. Failure mode to avoid: write
a passing test against my own assumed implementation, then claim the
behaviour is correct when the test never exercised the actual binary.

Three concrete defenses:

1. **Run the real artifact whenever possible.** "I built the dist and
   reproduced the bug under `node /opt/homebrew/lib/node_modules/...`"
   beats "I traced the code and it looks right." If you didn't run
   the real thing, say so.
2. **Diff your test against the user's report verbatim.** If the user
   says "I typed hi and it didn't show up", the test must include
   `expect(output).toContain('hi')`. Not "I tested the addEvent path
   and it pushed to history." Match the user-visible symptom.
3. **Ask "what's the assumption here?" before each step.** When a
   change works in isolation but not integrated, the missing
   assumption is usually a sibling code path that needs the same
   change. The cure is grepping for who calls the same surface and
   verifying each caller is consistent.

The CLAUDE.md rules can't catch *every* hallucinated implementation,
but they tighten the loop: the next time the user reports a bug, the
required pattern is already "spawn the real binary, reproduce, assert
on real stdout." That structure forces the failure to be real before
the fix is real.

## Auto-prevention heuristics — "have I picked up the wrong tool?"

Before authoring code, run these checks. Any "yes" forces a 60-second
research pause to confirm we're not reinventing something mature:

1. **Surface-area check** — am I about to add > 200 LOC of new code that
   does *one* of: render to a terminal, parse markdown, manage processes,
   schedule cron jobs, hash/encrypt, deal with timezones, normalize
   paths, build a REST client with retries, manage a state machine,
   write a regex parser? If yes → look for a library that does it.
2. **"Have I seen this before?" check** — does the symptom feel like
   the same class of problem solved already in this repo's history
   (resize tearing, listener leaks, escape-sequence pollution, race on
   concurrent writes)? If yes → propose the architectural fix BEFORE
   the patch. Look at what comparable open-source tools do (Claude
   Code, Cursor, Aider, ratatui-based, bubbletea-based). One link in
   the response is worth ten patches that don't address the root.
3. **Reinvention smell** — am I writing `Math.random` for a token,
   `setTimeout` for a debouncer, `String.replace` for a glob,
   `setInterval` + cursor moves for a spinner? Reach for `crypto`,
   `lodash.debounce` (or a 3-line debouncer with an explicit
   `clearTimeout`), `picomatch`, `ora`. The solved-problem allowlist
   above is the canonical list; this heuristic is its enforcement.
4. **Imitation check** — what do Claude Code / Cursor / Aider /
   Continue / Cody do for this surface? Their architectural choices
   are public artefacts; copying them is almost always the right call
   unless this codebase has a stated reason not to.

If a "yes" to any check goes uninvestigated and it later turns into a
multi-day rewrite (terminal renderer → Ink, sustained UI debugging
that the right initial choice would have prevented), the cost is
borne by both of us. Twenty minutes of research at minute zero is
the cheapest fix this repo has.

## Architecture-smell triggers

When two or more of these fire on the same subsystem, stop patching
and ask "is this the right abstraction?":

- A single file > 2,000 lines doing one job.
- Multiple mutex-like flags, render gates, or coalescing layers
  accumulating to paper over races.
- Bug fixes that move the bug rather than eliminate it.
- Tests that need detailed knowledge of internal escape-sequence
  emission, cursor coordinates, or other implementation noise.
- Reports that "rapid X causes glitches" where X is something the
  user does normally (typing, resize, scroll, paste).

The right move under these conditions is a focused research pass on
whether the underlying abstraction is correct — not another patch.
Patching the wrong abstraction is what produced the original
6800-line renderer; the second-order cost was the v1.3 hardening
pass that this CLAUDE.md exists for.
