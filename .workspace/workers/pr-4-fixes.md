# PR 4 Review-Fix Pass

Branch: `figma/pr-4-pointer`. Base for this pass: `6806ec4`. Tip after fixes: `54bd387` (4 new commits).

## Summary

Closed every Critical and Important finding from the Wave 1 reviewers
(`code-reviewer`, `code-simplifier`, `comment-analyzer`,
`silent-failure-hunter`, `spec-reviewer`, `test-analyzer`,
`type-analyzer`) and the three Wave 3 verifications
(`verify-memo-paragraph`, `verify-onDrop-throw`, `verify-test-gaps`) —
all marked Confirmed. Also applied the two cheap Suggestions called
out in the brief (`NODE_DOM_ATTR` constant hoist; tap-without-drag
movement threshold).

Test count: 467 → 483 (+16 across 2 new files + extensions to
`usePointerDrag.test.ts`).

## Commits (4 new)

```
f131c6f  fix(canvas): close usePointerDrag throw/state-leak + plumb pointerOffset
082ee48  test(canvas): cover _canvasGestureState module + polling-pause chain
b5986ca  fix(canvas): tap-threshold + comment rot + NODE_DOM_ATTR hoist
54bd387  fix(canvas): use border-dashed for drop-location ghost (ring-dashed is not a Tailwind class)
```

## Findings closed

### Critical

| Finding                                           | Source                                                | Resolution                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onDrop` throw leaves all drag state stuck        | silent-failure-hunter C1 + Wave 3 verify-onDrop-throw | `handlePointerUp` now wraps `onDropRef.current(...)` in `try { ... } finally { cleanup(); }`. Thrown errors surface via `loggingService.reportError({error_name: 'drop-handler-threw', ...})`. New test asserts: with an `onDrop` that throws, `isCanvasGestureActive()` is false, `dragState` is null, `isActive` is false, and the error is logged. |
| NodeComponent memo paragraph stale                | comment-analyzer C1 + Wave 3 verify-memo-paragraph    | Rewrote the React.memo rationale block to enumerate the actually-required-stable callbacks (`toggleHighlight`, `updateNodeRef`, `setHoveredNode`, `onPointerDown` via the `bindNode` cache), dropping the `onDragStart`/`onDragEnd` references retired in PR 4.                                                                                       |
| Test gap: polling-pause propagation chain         | test-analyzer C1/C3 + Wave 3 verify-test-gaps         | New `tests/frontend/onDragActiveChange.polling-pause.test.tsx` with 5 tests that stitch the chain `usePointerDrag.isActive` → ToC's `useEffect` notifier → App's `isDragInFlightRef` → `syncData` short-circuit via a small harness. Covers drag-start, drag-end, Escape cancel, and ToC unmount mid-drag.                                            |
| Test gap: `_canvasGestureState` no dedicated test | test-analyzer C2 + Wave 3 verify-test-gaps            | New `tests/frontend/_canvasGestureState.test.ts` with 6 tests pinning the reader/writer/reset contract that PR 5/7 will lean on.                                                                                                                                                                                                                      |

### Important

| Finding                                                    | Source                                                      | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task 4.5 missing `dragOverLocation` ghost                  | spec-reviewer Important                                     | The drop-preview block now renders TWO ghosts inside `dragState !== null && hasMoved`: a dashed-border silhouette anchored at the predicted drop position (read from `dragOverLocation` + `columnRects[]`) and the existing cursor-following ghost. `new-section` returns `null` (no drag-driven new-section path today).                                                                                                                                                           |
| `pointerOffset` read from React state via ref bridge       | silent-failure-hunter I1 + simplifier I1 + spec-reviewer S1 | Plumbed `pointerOffset` through `onDrop` as the third arg. Removed `dragHookOnDropRef` indirection, `?? 0` fallback, and the closure that re-read React state at drop time. `handleDrop` signature now `(target, draggedNodeId, pointerOffset: {x, y})`.                                                                                                                                                                                                                            |
| `cleanup()` dead `else if` branch                          | simplifier I2 + code-reviewer S1                            | Collapsed to `el.releasePointerCapture?.(pointerId)` inside the existing try/catch — `releasePointerCapture` is a no-op when no capture is held per the W3C spec, so the `hasPointerCapture` precheck was redundant.                                                                                                                                                                                                                                                                |
| `DragOverLocation` flattened the inner discriminated union | type-analyzer I1                                            | `DragOverLocation` is now a discriminated union mirroring `Region` 1:1 (`kind: 'node-slot'                                                                                                                                                                                                                                                                                                                                                                                          | 'over-node' | 'new-column' | 'new-section'`). `handleDrop`and the ghost JSX`switch (target.kind)`instead of probing optional flags.`regionToDragOverLocation` produces the discriminated shape directly. |
| `onDragActiveChange` unmount contract                      | type-analyzer I2                                            | ToC's effect now returns a cleanup that fires `onDragActiveChange?.(false)` if `isDragActive` at unmount, so App's `isDragInFlightRef` doesn't stay `true` for the rest of the App's lifetime when ToC unmounts mid-drag. Pinned by the unmount test in the new polling-pause file.                                                                                                                                                                                                 |
| Cross-unit: asymmetric unmount-gate                        | brief                                                       | `usePointerDrag`'s unmount safety now gates on `dragStateRef.current !== null` — only clears `isCanvasGestureActive` if WE own it, not if a sibling PR 5/7 hook is holding the flag.                                                                                                                                                                                                                                                                                                |
| Stale-node abort has no user feedback                      | silent-failure-hunter I2                                    | Added optional `onStaleDrop?(nodeId)` arg to the hook; fires after `loggingService.reportError` so consumers can show a toast / banner. Stale-node test extended to assert `onStaleDrop` is called.                                                                                                                                                                                                                                                                                 |
| `usePointerDrag.ts` file header too long                   | comment-analyzer I1 + simplifier (implicit)                 | Trimmed from 79 lines to 29 — kept the "Why pointer events" rationale, the cross-PR coordination contract, and the coordinate-translation paragraph; dropped the lifecycle diagram (mirrored function bodies one-to-one) and the speculative non-uniform-scale warning.                                                                                                                                                                                                             |
| Drop-preview ghost comment over-promises                   | comment-analyzer I3                                         | Rewrote the comment to describe the actual two-ghost shape, dropped the "PR 5/7 will plug into this same slot" claim.                                                                                                                                                                                                                                                                                                                                                               |
| `straightenEdges` tolerance comment factually wrong        | comment-analyzer S3                                         | Deleted the misleading "60px tolerance — increased for better grouping" gloss on the next line that says `tolerance = 40`.                                                                                                                                                                                                                                                                                                                                                          |
| Tap engages drag state + ghost flicker on single click     | code-reviewer Important                                     | Added `hasMoved: boolean` to `DragState`, set false on pointerdown, flipped true when the cursor moves past `MOVE_THRESHOLD_PX = 4` from the initial pointerdown position (tracked in `startPosRef`). Ghost JSX and `isDragging` half-opacity now gate on `dragState.hasMoved`. State machine still engages on pointerdown for mutex + capture; only the visual affordances are deferred. 4 new tests cover sub-threshold movement, threshold-crossing, and slow-drag accumulation. |

### Suggestion (applied)

| Finding                    | Source                      | Resolution                                                                                                                                                                                                                           |
| -------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NODE_DOM_ATTR` constant   | type-analyzer S2            | Exported `NODE_DOM_ATTR = 'data-tocb-node'` from `NodeComponent.tsx`; App.tsx's `excludeFromPan` now reads `target.closest(\`[${NODE_DOM_ATTR}]\`)`. Refactor-rename divergence between writer and reader is caught at compile time. |
| Tap-without-drag threshold | (from same Important above) | See `hasMoved` above.                                                                                                                                                                                                                |

### Discovered during review

| Issue                                                                                | Resolution                                                                                                                                               |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ring-dashed` is not a Tailwind class — drop-location ghost rendered as a solid ring | Switched to `border-2 border-dashed border-indigo-300` so the visual distinction (dashed silhouette vs solid cursor-following ring) is actually visible. |

## Deviations from brief

None. Every Critical and Important from the brief was applied. The
ring-dashed visual fix was a self-discovered issue when reviewing the
new ghost code; included it for visual correctness rather than waiting
for a follow-up review pass.

## Skills invoked

- `praxis:test-driven-development`: **invoked yes**, at the start.
  Red-green-refactor for the C1 onDrop-throw test (RED confirmed with
  `npx vitest run tests/frontend/usePointerDrag.test.ts` showing
  `expect(isCanvasGestureActive()).toBe(false)` failing on `boom`
  unhandled exception; then GREEN after adding `try { } finally { }`).
  Also red-green for the new `hasMoved` tests, the polling-pause
  harness, and the `_canvasGestureState` module tests (RED via "not
  yet implemented" assertion failures, then GREEN once the changes
  landed).
- `praxis:systematic-debugging`: **not invoked**, didn't get stuck.
  All fixes were guided by the review files; debugging surface limited
  to the `ring-dashed` discovery (a single grep + visual mental
  simulation).
- `praxis:verification-before-completion`: **invoked yes**, before
  this log was written. Ran `npm run preflight` with exit 0 and read
  the test summary (53 files / 483 tests passed) as evidence.
- `praxis:review`: **invoked yes**, after the test+code commits.
  Performed inline since no Agent tool. Caught the `ring-dashed`
  Tailwind bug and verified no leftover `isNewColumn` / `isNewSection`
  references on `DragOverLocation` (only the local `isNewColumn`
  derived from `target.kind === 'new-column'` in handleDrop survives,
  which is correct).
- `praxis:receiving-code-review`: **not invoked**, all reviewer
  findings were clearly actionable; no ambiguity required pushing
  back.
- `praxis:simplify`: **invoked yes**, after the second commit. Inline
  pass found that the IIFE pattern in the ghost JSX matches existing
  style (justified, not refactor candidate), the harness fixture
  duplication in the polling-pause test is intentional (called out in
  comments), and the `hasMoved` machinery is minimal. No code changes
  from this pass.

## Test results

```
$ npm run preflight
typecheck: clean
lint: clean (2 pre-existing warnings, unchanged)
format:check: clean
build: succeeded
build+test: 483 tests / 53 files passed, exit 0
```

Specific tests added:

- `tests/frontend/_canvasGestureState.test.ts`: 6 tests.
- `tests/frontend/onDragActiveChange.polling-pause.test.tsx`: 5 tests.
- `tests/frontend/usePointerDrag.test.ts`: +4 hasMoved tests + 1 onDrop-throw test + extended stale-node test to assert `onStaleDrop`. Total 19 (was 14).

## Files changed

```
src/App.tsx                                                       (NODE_DOM_ATTR import + use)
src/components/NodeComponent.tsx                                  (NODE_DOM_ATTR export + spread; memo paragraph rewrite)
src/components/TheoryOfChangeGraph.tsx                            (handleDrop discriminated-union switch + pointerOffset 3rd arg; onDragActiveChange unmount cleanup; two-ghost render with hasMoved gate; border-dashed; tolerance comment fix)
src/hooks/_canvasGestureState.ts                                  (header trim)
src/hooks/usePointerDrag.ts                                       (DragOverLocation union; pointerOffset in onDrop signature; onStaleDrop; try/finally cleanup; cleanup simplification; hasMoved; startPosRef; unmount-gate gating; trimmed header)
tests/frontend/_canvasGestureState.test.ts                        (new)
tests/frontend/onDragActiveChange.polling-pause.test.tsx          (new)
tests/frontend/usePointerDrag.test.ts                             (+hasMoved + onStaleDrop + onDrop-throw tests; existing tests updated for new shapes)
```

No CLAUDE.md or README.md changes needed — all changes are PR-internal
(hook API contracts that PR 5/7 will read against, not user-facing
documentation).

## Integration notes for PR 5/7

- `DragOverLocation` is now a discriminated union. Switch on `kind`.
- The mutex unmount-gate now requires `dragStateRef.current !== null`
  before clearing. PR 5/7 hooks should do the same (or use a
  per-hook-owned ref) — clearing unconditionally would wipe a sibling
  hook's claim.
- `onStaleDrop?(nodeId)` is a new optional hook arg. Pattern is
  available to PR 5/7 if their drag targets can disappear cross-tab.
- `hasMoved` is on `DragState`. PR 5/7 ghost overlays should also
  gate on it to avoid tap-flicker.
- `NODE_DOM_ATTR` constant is exported from `NodeComponent.tsx`;
  reuse the constant rather than hard-coding `'data-tocb-node'` in
  any new selector.

## Acceptance gate

- [x] Every Confirmed finding from `reviews/2026-05-16/` addressed.
- [x] Brief's "two cheap Suggestions" applied.
- [x] `npm run preflight` clean.
- [x] New tests cover the test gaps (Critical from test-analyzer +
      Wave 3 verify-test-gaps).
- [x] Small semantic commits (4: critical-state, test gaps, code +
      comment fixes, visual-fix).
- [x] Branch pushed for the orchestrator to merge.
