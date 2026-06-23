# UI

The CLI's terminal UI is rendered exclusively through [Ink](https://github.com/vadimdemedes/ink) — React for the terminal, the same engine Claude Code uses. There is no legacy / custom-renderer fallback.

## Layout

```
src/ui/
├── theme.ts                  shared colours, icons, glyphs
└── ink/
    ├── InkPromptController.ts  the IPromptController the shell holds
    ├── App.tsx                 root component
    ├── ChatStatic.tsx          committed-history surface (Ink <Static>)
    ├── Prompt.tsx              input row + paste sanitiser
    └── StatusLine.tsx          spinner / activity / mode chips
```

That is the entire surface. Nothing else under `src/ui/` ships. The previous custom-renderer family (`UnifiedUIRenderer.ts`, `PromptController.ts`) and its helpers (`RenderGate`, `OverlayManager`, `InterruptManager`, `AnimationScheduler`, `richText`, `toolDisplay`, `errorFormatter`, `layout`, `outputMode`, `globalWriteLock`, `premiumComponents`, `textHighlighter`, `codeHighlighter`, `designSystem`, `uiConstants`, `animatedStatus`, `telemetry/*`) were removed once the Ink port reached parity.

## Wiring

`src/headless/interactiveShell.ts` calls `createPromptController()` from `ink/InkPromptController.ts`. The factory unconditionally returns an `InkPromptController` — there is no `ANVILWING_INK` flag, no plain-mode fallback, no legacy branch. The shell exits early on non-TTY stdin/stdout, so Ink's raw-mode requirement is always satisfied.

## Guard

`test/ink-only.test.ts` walks imports from `src/bin/anvilwing.ts` and fails if any reachable file under `src/ui/` falls outside `theme.ts + ink/*`. It also asserts that `interactiveShell.ts` carries no `ANVILWING_INK` or "legacy renderer" wiring and that `createPromptController` still hands back `InkPromptController` unconditionally. If a regression reintroduces a renderer fork the test catches it before the change lands.
