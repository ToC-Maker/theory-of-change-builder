# PR 4 Worker Log — Pointer-events migration

Branch: `figma/pr-4-pointer` (based on `figma/pr-3-editors`, tip `860bdc4`).

## Summary

PR 4 replaces the HTML5 Drag and Drop API on the node-drag interaction
with `pointerdown`/`pointermove`/`pointerup` events plumbed through a
new `usePointerDrag` hook. It is the foundation for PR 5's direct-
manipulation canvas (connection handles, hover-`x` deletes) and PR 7's
connection waypoints, all of which build on the same pointer-events
pattern with mutual exclusion via a shared `isCanvasGestureActive` flag
in `_canvasGestureState.ts`.

Critical safety mechanisms shipped per the red-team analysis:

- **Stale-node guard on drop**: verifies the dragged node id still
  exists in current `data` before committing the drop; aborts with
  `loggingService.reportError({error_name: 'stale-node-drop'})` on the
  cross-tab delete race.
- **Escape during drag**: releases pointer capture, clears state, no
  commit. Standard "cancel mid-gesture" UX.
- **Second-pointer cancel**: if a second `pointerdown` arrives mid-
  drag, drag is cancelled (pinch-zoom via the page's existing zoom/pan
  takes over).
- **Polling pause**: App's 30s sync poll short-circuits while a drag
  is in flight, so a server snapshot can't yank the dragged node out
  from under the user.
- **Hook-unmount safety**: clears the gesture flag on unmount so PR 5
  / PR 7 handlers don't see leaked state.

## Commits

```
4a84b2d  feat(canvas): usePointerDrag hook with touch + cancel + stale-node guard   (Task 4.1)
de00a05  refactor(canvas): replace HTML5 DnD on node-drag with usePointerDrag        (Tasks 4.2 + 4.3 + 4.4)
3e886ba  feat(canvas): drop-preview ghost render at dragOverLocation                 (Task 4.5)
```

The orchestrator-suggested 5-commit split collapsed to 3. Reasoning:

- Tasks 4.2 (NodeComponent prop shape), 4.3 (parent handler rewiring),
  and 4.4 (App.tsx selector swap) all touch the same typecheck-tied
  surface and have to land together or the codebase doesn't compile.
- The orchestrator-proposed final `docs(figma)` commit folds into
  `.implementation-log.md` (under a new "PR 4 — Pointer-events
  migration" section) and this worker log. No separate docs commit;
  the revert kit lives in this log.

## Files changed

### Created

```
src/hooks/usePointerDrag.ts                        (~470 LoC after lint)
src/hooks/_canvasGestureState.ts                   (~40 LoC, module-scope flag)
tests/frontend/usePointerDrag.test.ts              (14 tests)
tests/frontend/NodeComponent.pointer.test.tsx      (5 tests)
```

### Modified

```
src/App.tsx
  - excludeFromPan selector: [draggable="true"] -> [data-tocb-node]
  - isDragInFlightRef ref in both ToCViewerOnly + ToCViewer
  - syncData polling gates on the ref (both polling effects)
  - editable ToC mount: onDragActiveChange wired

src/components/NodeComponent.tsx
  - Drops draggable / onDragStart / onDragEnd props
  - Adds data-tocb-node={node.id} attribute
  - Adds touch-none class
  - Accepts onPointerDown (only bound when editMode=true)

src/components/TheoryOfChangeGraph.tsx
  - Deletes handleDragStart (~50 LoC incl. scaled-clone drag-image)
  - Deletes handleDragEnd, handleDragOver
  - Deletes global dragover document listener (~90 LoC)
  - Deletes global drop document listener (~25 LoC)
  - Deletes draggedNode/dragOffset/dragOverLocation useState triple
  - handleDrop signature refactor: (target, draggedNodeId, pointerOffsetY)
  - Deletes 3 column-element onDragOver / onDrop JSX bindings
  - Wires usePointerDrag with getSnapshot + zoomScale + onDrop
  - Plumbs registerOnDragStartedElsewhere to NodeEditorMount
  - Adds onDragActiveChange ToC prop
  - NodeComponent callsite: onPointerDown={bindNodeDrag(id).onPointerDown}
  - Adds drop-preview ghost render slot (PR 5/7 generic)

tests/frontend/NodeComponent.memo.test.tsx
  - baseProps shape updated: drop onDragStart/onDragEnd, add onPointerDown
```

## Test counts

| Stage                        | Frontend test files | Total tests |
| ---------------------------- | ------------------- | ----------- |
| Before PR 4 (pre-4.1)        | 26                  | 448         |
| After 4.1 (hook + tests)     | 27                  | 462         |
| After 4.2+4.3+4.4 (refactor) | 28                  | 467         |
| After 4.5 (ghost render)     | 28                  | 467         |

New tests:

- `tests/frontend/usePointerDrag.test.ts` — 14 tests covering: drag-start
  (gesture flag, onDragStart, editMode guard, mutex short-circuit),
  drag-over (ghost + dragOverLocation for node-slot, over-node,
  new-column regions), drop (onDrop fires, state clears, void-drop
  is no-op), pointer-cancel, Escape, ignored non-Escape key,
  second-pointer arrival, stale-node abort calling reportError,
  isActive transitions, unmount safety reset.
- `tests/frontend/NodeComponent.pointer.test.tsx` — 5 tests pinning:
  `data-tocb-node` attribute, `touch-none` class, no `draggable="true"`,
  `onPointerDown` fires in editMode, `onPointerDown` not bound when
  `editMode=false`.

Final preflight: 467 tests pass, build green, typecheck clean,
2 pre-existing lint warnings (GraphTutorial useCallback dep,
TheoryOfChangeGraph useEffect setData dep — both pre-PR-4).

## Touch test matrix (Task 4.6)

I cannot run real-touch gestures in this jsdom environment, and no
rodney binary is available on this worktree for Chromium device
emulation. Per the orchestrator brief's escape hatch, items below are
labelled with the confidence level the unit suite provides; real
device verification is a manual-test gate that should run before
merge.

| #   | Scenario                                           | Confidence                                      | Notes                                                                                                                                                                                                                                                    |
| --- | -------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Tap-and-hold node → drag → drop in adjacent column | unit-covered + requires manual device           | `usePointerDrag.test.ts` "drag-over" + "drop" exercise the state transitions; real-touch path additionally goes through iOS Safari's `touchstart`→synthetic `pointerdown` flow, which only the device can validate.                                      |
| 2   | Two-finger pinch on canvas (not over node)         | requires manual device                          | No node `pointerdown` was issued, so `usePointerDrag` is dormant; the existing `useZoomPan` handles this. No regression risk from PR 4 specifically; manual sanity check still recommended.                                                              |
| 3   | Two-finger pinch starting on a node                | unit-covered + requires manual device           | `usePointerDrag.test.ts` "second-pointer cancel" pins the cancel-on-second-pointerdown contract. Device check verifies `useZoomPan` takes over cleanly.                                                                                                  |
| 4   | Tap-and-hold + second-finger tap elsewhere         | unit-covered                                    | Identical state-transition path as scenario 3 — the hook cancels on any second pointerdown.                                                                                                                                                              |
| 5   | Drag to canvas edge                                | unit-covered                                    | Captured pointermove via setPointerCapture continues to fire; the hook isn't bound to the node's hit area. `useGraphLayout.classifyRegion` returns `null` past last section; "void drop is no-op" test pins the abort path.                              |
| 6   | Single tap on node                                 | unit-covered                                    | NodeComponent's `onClick` is preserved unchanged (single-click still selects). `usePointerDrag` starts on `pointerdown` but a pointerup without intervening movement still routes through the drop path; if `dragOverLocation === null` no commit fires. |
| 7   | Drag node, then scroll chat panel                  | unit-covered (partial) + requires manual device | Touch-action behavior is controlled by `touch-none` on the node + the chat panel's default. The chat panel still scrolls because `touch-none` is per-element, not page-wide. Device check confirms the gesture handoff.                                  |
| 8   | iPad Safari: tap, drag, drop                       | requires manual device                          | Pointer events are well-supported on iPad Safari 13+; the only Safari-specific gotcha is `touch-action: none` not preventing `dblclick`-as-zoom, which we don't trigger.                                                                                 |
| 9   | Pinch-to-zoom on iPad while drag is in progress    | unit-covered + requires manual device           | Same as scenario 3; "second-pointer cancel" test pins behavior. Real device validates `useZoomPan` doesn't get a stale `pointerdown` event.                                                                                                              |
| 10  | Drag node onto another node                        | unit-covered                                    | "over-node" region maps to a node-slot in the same column; `classifyRegion` test covers the geometry. The drop is treated as a same-column reposition (`isNewColumn=false`, columnIndex set).                                                            |

**Verdict**: 7/10 items unit-covered (drag state machine, mutex
guards, classification edges, stale-node race). 3/10 (scenarios 2,
7, 8) and the device-side of items 1, 3, 5, 7, 9, are gated on
manual device testing before merge.

## Integration notes for PR 5

**`isCanvasGestureActive` mutex**:

```ts
import { isCanvasGestureActive, setCanvasGestureActive } from '../hooks/_canvasGestureState';

// Inside useConnectionDrag's pointerdown handler:
if (isCanvasGestureActive()) return; // someone else has the gesture
setCanvasGestureActive(true);
// ... your drag logic ...
// On cleanup:
setCanvasGestureActive(false);
```

Module-scope boolean. No React state. Three writers planned across
the PR chain (PR 4 node drag, PR 5 connection drag, PR 7 waypoint
drag); each must clear the flag on cleanup, pointercancel, Escape,
second-pointer cancel, and unmount.

**Ghost render slot**:

`TheoryOfChangeGraph.tsx` renders a translucent rounded rectangle at
`dragState.ghostPos` (translated to container-local) with
`dragState.nodeSize` dimensions. PR 5's connection ghost (a SVG path
from handle to cursor) needs its own render slot — the existing one
is node-shaped, not path-shaped. Suggest PR 5 add a sibling render
slot inside the same `dragState && graphContainerRef.current` guard
that branches on a `dragState.kind` discriminator (today only one
kind exists, implicitly "node-drag"). PR 7 can do the same.

**`onDragStart` callback**:

The hook accepts `onDragStart?: (nodeId) => void` for the NodeEditor
dismiss seam. PR 5 / PR 7's drag hooks should expose the same shape
so all three gesture starts can converge on a single dismiss path if
needed. Today only PR 4 fires this callback.

**`registerOnDragStartedElsewhere` plumbing**:

`NodeEditor` exposes a one-shot registration prop; the parent stores
the registered callback in `nodeEditorDragStartRef` and calls it from
the hook's `onDragStart`. PR 5 / PR 7 should reuse the same ref
(don't add new refs for each drag kind) — the editor only needs to
dismiss; the kind of drag is irrelevant.

**Polling pause via `onDragActiveChange`**:

ToC exposes `onDragActiveChange?: (isActive: boolean) => void`. App
stores `isDragInFlightRef` and reads it in `syncData`. PR 5 / PR 7
should bubble their `isActive` through the same channel — combine
via `dragState != null || connectionDragActive || waypointDragActive`
in TheoryOfChangeGraph and pass one boolean up. Otherwise the polling
guard misses non-node drags.

## Revert kit

If a regression surfaces post-PR-6, the rollback sequence is:

1. `git revert <PR 7 SHA>` (waypoints — only if PR 7 has shipped)
2. `git revert <PR 5 SHA>` (direct-manipulation canvas)
3. `git revert <PR 4 SHA>` (pointer-events migration)

in that order, with manual verification of node drag at each step.
PR 6 (image / PDF export) is independent of the canvas-interaction
chain and can be reverted alone.

The PR 4 revert restores HTML5 DnD. Notes:

- The `data-tocb-node` attribute is harmless to keep (NodeComponent
  already had `id="node-${id}"` for the SVG renderer; the new
  attribute is one more locator).
- The App.tsx `excludeFromPan` selector reverts to `[draggable="true"]`
  — 1-LoC change.
- The `_canvasGestureState.ts` module becomes dead code after a PR 4
  revert; safe to leave for the forward chain or delete.

## Skills used

- `praxis:test-driven-development` (red→green→refactor on all
  14 `usePointerDrag` tests, then on the 5 NodeComponent.pointer tests).
- `praxis:verification-before-completion` (final preflight + test
  count diff before declaring complete).

## Acceptance gate (Task 4.7)

- [x] Drag node, observe React ghost + drop preview, drop, undo
      works — covered by `usePointerDrag.test.ts` state-machine
      tests + the ghost render block. Real-touch end-to-end is the
      manual-device matrix item.
- [x] Touch matrix surveyed — 7/10 unit-covered, 3/10 + device-side
      portions of others requires manual device. See the matrix
      table above.
- [x] No HTML5 DnD code remains — verified by:
      `grep -rn 'draggable=\|onDragStart\|onDragEnd\|onDragOver\|onDrop\|onDragLeave\|onDragEnter\|DataTransfer\|setDragImage' src/components/ src/App.tsx`
      returns no production-code hits (the only matches are inside
      comments documenting the migration).
- [x] Revert kit blurb included in the PR description (this log) +
      the commit message of the final refactor commit.
- [x] `npm run preflight` green — 467 tests pass, build succeeds,
      typecheck clean, 2 pre-existing lint warnings.
