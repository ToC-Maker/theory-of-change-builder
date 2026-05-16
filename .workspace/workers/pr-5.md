# PR 5 Worker Log — Direct-manipulation canvas

Branch: `figma/pr-5-direct-manip` (based on `figma/pr-4-pointer`, tip `6806ec4`).

## Summary

PR 5 brings direct-manipulation affordances to the canvas. Three user-
facing changes plus one cleanup:

1. **Always-on add affordances** on the gutter divs between columns and
   the section-padding divs between sections. Hover reveals a "+ Column"
   or "+ Section" label; click adds. Replaces the layout-mode-gated red
   panels with a CSS-only hover affordance.

2. **Drag-to-connect** via small handle dots on the left + right edges
   of hovered or selected nodes. Drag from a handle to a target node
   creates a connection in one undo entry. Ghost line follows the cursor
   during drag; the select-2-then-button gesture still works in parallel.

3. **Hover-x delete** on columns and sections. Click opens a React
   `<ConfirmModal>` (NOT `window.confirm()`) with node-count-aware copy
   describing what will be deleted. Replaces the layout-mode red empty-
   column-delete affordance.

4. **`layoutMode` deleted**. The dual-mode toggle is gone. Edit-mode now
   provides all the affordances unconditionally; view-mode renders none.

PR 5 also retrofits the FileMenu "Delete chart" path from
`window.confirm()` to the shared `<ConfirmModal>` (closes red-team L4
Important finding).

## Commits

```
9b47629  feat(canvas): always-on add affordances on gutters and section padding   (Task 5.1)
58599e5  feat(canvas): useConnectionDrag + ConnectionHandles for drag-to-connect    (Task 5.2)
f4562f8  feat(canvas): hover-x delete affordance + React confirm modal              (Task 5.3)
fb4af02  refactor(canvas): delete layoutMode state + UI toggle                       (Task 5.4)
```

Four commits matches the orchestrator brief. No collapse needed.

## Files changed (new + modified)

**New files:**

- `src/hooks/useConnectionDrag.ts` (357 LoC, includes lifecycle / coordinate-translation header comments)
- `src/components/canvas/ConnectionHandles.tsx` (60 LoC)
- `src/components/canvas/ColumnDeleteAffordance.tsx` (75 LoC; serves both column and section scopes)
- `src/components/canvas/connectionPath.ts` (60 LoC; factored from `ConnectionsComponent.tsx:670-714`)
- `src/components/ConfirmModal.tsx` (110 LoC; reusable, portaled, ESC/Enter handled)
- `tests/frontend/TheoryOfChangeGraph.gutter.test.tsx` (10 tests; Task 5.1 acceptance)
- `tests/frontend/useConnectionDrag.test.ts` (14 tests; Task 5.2 acceptance, mirrors `usePointerDrag.test.ts`)
- `tests/frontend/ConnectionHandles.test.tsx` (5 tests)
- `tests/frontend/connectionPath.test.ts` (5 tests; pins the SVG path shape)
- `tests/frontend/ColumnDeleteAffordance.test.tsx` (9 tests)
- `tests/frontend/ConfirmModal.test.tsx` (11 tests)

**Modified files:**

- `src/components/TheoryOfChangeGraph.tsx` (gutter ungate, hover-x affordances, connection-drag wiring + ghost render, layoutMode deletion)
- `src/components/ConnectionsComponent.tsx` (gutter sizing math, path utility refactor, layoutMode prop deletion)
- `src/components/NodeComponent.tsx` (ConnectionHandles render + `bindConnectionHandle` prop)
- `src/hooks/useGraphLayout.ts` (computeSectionWidths gutter math, layoutMode arg deletion)
- `src/components/top-bar/FileMenu.tsx` (retrofitted window.confirm → ConfirmModal)
- `tests/frontend/FileMenu.test.tsx` (test assertions updated for ConfirmModal interaction)

## Test counts

| Stage               | Test files | Tests                                                                    |
| ------------------- | ---------- | ------------------------------------------------------------------------ |
| Baseline (PR 4 tip) | 51         | 467                                                                      |
| After Task 5.1      | 52         | 477 (+10 gutter)                                                         |
| After Task 5.2      | 55         | 501 (+24: 14 useConnectionDrag + 5 ConnectionHandles + 5 connectionPath) |
| After Task 5.3      | 57         | 521 (+20: 11 ConfirmModal + 9 ColumnDeleteAffordance)                    |
| After Task 5.4      | 57         | 521 (no test change; layoutMode prop deletion is type-only)              |

Preflight at PR 5 tip: typecheck clean, lint 2 pre-existing warnings
(none from PR 5), format clean, build successful, 521 tests pass.

## Deviations from the orchestrator brief

All tracked deviations are itemized in `.implementation-log.md` under
"PR 5 — Direct-manipulation canvas". Summary of consequential choices:

1. **Built `<ConfirmModal>` from scratch** (FileMenu was using
   `window.confirm()`). Retrofitted FileMenu in the same commit as the
   column / section hover-x delete (Task 5.3) since both depend on the
   same primitive.

2. **Did not extract a shared `useGesture` base** between `usePointerDrag`
   and `useConnectionDrag`. Their hit-test logic and drop-payload shapes
   differ; the cost of ~30 LoC duplication is low, the risk of premature
   abstraction is real. Re-revisit at PR 7 when `useWaypointDrag` is the
   third user.

3. **Did not block section delete on non-empty sections**. Plan called
   out "OR show confirm with node count" as one option; I went with that
   approach. The confirm body adapts to total node count across the
   section's columns.

4. **Connection-drag ghost is dashed indigo** (distinct from select-2's
   solid ghost). Visually communicates "preview pending drop" vs
   "rendered final connection". Plan didn't pin this; design choice.

5. **Used Tailwind `:group-hover` for hover-x reveal**, not React hover
   state. Pure CSS; consistent with the "no global pointermove" plan
   constraint. Tests assert presence and click behavior; visual hover is
   a CSS concern not unit-tested.

6. **Test isolation fix**: `setDataAndNotify` updaters in TheoryOfChange
   mutate `prevData.sections` via `.splice()`, which leaks across tests
   sharing a module-level fixture. The gutter test file uses a
   `makeBaseData()` factory to deep-clone per-test. The underlying
   mutation is a pre-existing bug not in PR 5 scope; logged as a
   follow-up.

## Acceptance gate (Task 5.5) — verified

- [x] In edit mode, hovering an empty column changes cursor; double-click adds node at Y.
  - Test: `TheoryOfChangeGraph.gutter.test.tsx > empty column body in edit mode shows the cursor-cell affordance class`.
  - `onDoubleClick` handler preserved verbatim from before Task 5.1, only the `layoutMode` gate dropped.
- [x] Hovering a 24px column gutter reveals translucent blue + "+ Column"; click adds column.
  - Tests: `TheoryOfChangeGraph.gutter.test.tsx > renders the before/after-column gutter ... in edit mode` + `clicking the ... gutter splices a new column`.
  - Hover styling: `hover:bg-blue-500/20` + `group-hover:opacity-100` on label span. CSS-only.
- [x] Hovering a 32px section padding reveals translucent green + "+ Section"; click adds section.
  - Tests: `renders the before/after-section gutter` + `clicking the before-section gutter splices a new section`.
- [x] Connection handles appear on node hover/select; drag handle → target creates a connection (with ghost line during drag).
  - Tests: `ConnectionHandles.test.tsx` (visibility, pointerdown binding); `useConnectionDrag.test.ts` (drag lifecycle, target hit-test, onConnect firing).
  - Ghost render: `data-testid="connection-drag-ghost"` SVG block in TheoryOfChangeGraph; gated by `connectionDragState != null`. Not unit-tested directly (jsdom + container rect math is brittle) but the conditional and shape are inspected.
- [x] Hover-x reveals on column/section hover; React confirm modal fires on click.
  - Tests: `ColumnDeleteAffordance.test.tsx` (click → modal, confirm → onDelete, cancel → no delete); `ConfirmModal.test.tsx` (portaled, backdrop click, Escape, Enter, danger variant).
- [x] No global pointermove subscription on the canvas.
  - Verified by code inspection: both `usePointerDrag` and `useConnectionDrag` subscribe document-level `pointermove` ONLY when `dragState != null` (via `useEffect` early-return). Listeners are torn down via the effect cleanup after drop/cancel.
  - The `classifyRegion` function is called from inside `usePointerDrag.handlePointerMove` — only while a drag is in flight.
- [x] Touch: pinch + drag coexist.
  - Tests: `useConnectionDrag.test.ts > second-pointer cancel`; `usePointerDrag.test.ts > second-pointer cancel` (PR 4).
- [x] `npm run preflight` green.
  - Verified at PR 5 tip. 521 tests pass. Exit 0.

## Integration notes for downstream PRs

### PR 6 (Image / PDF export) — independent

PR 6 is independent of PR 5's canvas-interaction work. One narrow
integration concern: when capturing the canvas to PNG/PDF, the
connection-drag ghost SVG (gated by `connectionDragState != null`) and
the drop-preview ghost (gated by `dragState != null`) MUST NOT render
in the captured image. Both are naturally absent during a static
capture (a user can't drag and click "Export" simultaneously), so no
explicit suppression is needed.

### PR 7 (Connection waypoints) — uses isCanvasGestureActive

PR 7's `useWaypointDrag` hook is the third reader of the shared
`isCanvasGestureActive` flag in `src/hooks/_canvasGestureState.ts`.
The skeleton of `useConnectionDrag` should be the closest reference
for how to wire pointer capture, document-level subscription, second-
pointer cancellation, escape-cancel, stale-target guard, and the
hook-unmount safety net. PR 7 can copy the skeleton and swap in the
waypoint-specific hit-test + payload shape.

If PR 7 finds that the two hooks (`useConnectionDrag` + `useWaypointDrag`)
share 80%+ of their pointer-capture boilerplate, that's the right
moment to extract a `useGesture` base (the abstraction-deferred-until-
third-user pattern). The three-user threshold is the cost-benefit
crossover.

## Touch test matrix

Plan §4.6 (manual touch matrix from PR 4) does not have a PR-5
equivalent — the PR 4 matrix items still apply (node drag with touch,
pinch-zoom takeover, etc.). For PR 5 specifically, the manual gestures
to verify are:

| Gesture                                                                             | Status                                                                      |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Tap empty column → cursor changes (`cursor-cell`)                                   | unit-test-covered (cursor class presence)                                   |
| Double-tap empty column → adds node                                                 | requires manual device (touch double-tap timing)                            |
| Tap-hold on column gutter → no spurious add                                         | unit-test-covered (click fires only on `click`, not pointerdown)            |
| Drag from left handle → cursor follows → drop on target node → connection created   | unit-test-covered (hook lifecycle)                                          |
| Two-finger pinch during connection-drag → connection-drag cancels, pinch takes over | unit-test-covered (`second-pointer cancel`)                                 |
| Tap × on column → confirm modal appears → tap Confirm → column deleted              | unit-test-covered (ColumnDeleteAffordance click + modal interaction)        |
| Backdrop tap on confirm modal → cancels                                             | unit-test-covered (`ConfirmModal.test.tsx > backdrop click fires onCancel`) |

Per the orchestrator escape hatch ("unit-test-covered" / "requires
manual device" annotation is acceptable in this jsdom environment), the
PR is not gated on real-device execution. Items marked
"requires manual device" need verification on a real iPad/Android tablet
before this PR ships to production.

## Sub-pieces deferred / out of scope

- **`baseData` mutation in TheoryOfChange's setDataAndNotify updaters**.
  The shallow `{ ...prevData }` clone leaks subarrays across React state
  updates. The mutation is pre-existing (not introduced by PR 5) and
  fixing it would be a broader refactor. Worked around in tests via
  per-test fixture factories. Logged as a follow-up.

- **Live cross-tab edit-mode toggle**. If two tabs are open and one
  switches to view-mode via some future toggle, the other tab's gutters
  / handles / × buttons would not update reactively (the state is
  per-component). The polling-pause channel from PR 4 handles
  pointer-capture-vs-cross-tab-delete, but the edit-mode binding itself
  is initialized once via `showEditButton` and not re-read on prop
  changes. Out of PR 5 scope; would be addressed in a future "live
  collaboration" PR.

- **Edit-mode tutorial overlay** (figma item #7f deferred to follow-up
  per plan §282). Connection handles + hover-x + drag affordances are
  novel UI that benefits from a first-run tour. Plan calls this out as
  a deferred follow-up; not in PR 5 scope.
