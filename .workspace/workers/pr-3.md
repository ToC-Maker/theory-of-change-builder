# PR 3 Worker Log — NodeEditor + EdgeEditor + MDXEditor v4

Branch: `figma/pr-3-editors` (based on `figma/pr-2-share`).

## Summary

PR 3 unifies the three pre-existing node-edit paths (per-selection
toolbar, inline contentEditable, NodePopup modal) and the one
edge-edit path (EdgePopup modal) behind two new anchored editors:
`<NodeEditor>` (in `src/components/node-editor/`) and `<EdgeEditor>`
(in `src/components/edge-editor/`). Both use the new
`useAnchorPosition` hook to stay glued to their target across pan,
zoom, and DOM reflow. MDXEditor was upgraded from v3 → v4 as the
opening sub-commit so the upgrade lands as a clean bisect point.

Two sub-commits per plan §3 (3b first as a bisect target, then 3a).

## Commits

```
a6edda2  chore(deps): upgrade @mdxeditor/editor v3 → v4                            (sub-commit 3b)
2cc1cae  feat(node-editor): useNodeProperties + useEdgeProperties hooks             (Task 3.1)
fba0bde  feat(node-editor): NodeEditor + useAnchorPosition + DetailsEditor          (Task 3.2)
1da1134  feat(edge-editor): EdgeEditor anchored to connection midpoint              (Task 3.3)
0f3643c  refactor(node): delete NodePopup, EdgePopup, inline contentEditable, pencil (Task 3.4)
68b6521  refactor(top-bar): rename remnant to AlignmentSuggestionBanner             (Task 3.5)
```

Final preflight: 448 tests pass; build green; typecheck clean; 2 lint
warnings (both pre-existing).

## Test counts

| Stage                               | Frontend test files | Total tests |
| ----------------------------------- | ------------------- | ----------- |
| Before PR 3 (pre-3b)                | 21                  | 417         |
| After 3b (MDXEditor v4)             | 21                  | 417         |
| After 3.1 (hooks)                   | 23                  | 435         |
| After 3.2 (NodeEditor + anchor)     | 25                  | 444         |
| After 3.3 (EdgeEditor)              | 26                  | 448         |
| After 3.4 + 3.5 (refactor + rename) | 26                  | 448         |

New tests in PR 3 (31 total):

- `tests/frontend/useNodeProperties.test.ts` — 12 tests
- `tests/frontend/useEdgeProperties.test.ts` — 6 tests
- `tests/frontend/useAnchorPosition.test.ts` — 4 tests
- `tests/frontend/NodeEditor.test.tsx` — 5 tests
- `tests/frontend/EdgeEditor.test.tsx` — 4 tests

## Files changed

### Created

```
src/components/node-editor/useNodeProperties.ts
src/components/node-editor/useAnchorPosition.ts
src/components/node-editor/DetailsEditor.tsx
src/components/node-editor/NodeEditor.tsx
src/components/edge-editor/useEdgeProperties.ts
src/components/edge-editor/EdgeEditor.tsx
tests/frontend/useNodeProperties.test.ts
tests/frontend/useEdgeProperties.test.ts
tests/frontend/useAnchorPosition.test.ts
tests/frontend/NodeEditor.test.tsx
tests/frontend/EdgeEditor.test.tsx
```

### Renamed

```
src/components/EditToolbarRemnant.tsx → src/components/AlignmentSuggestionBanner.tsx
```

### Deleted

```
src/components/NodePopup.tsx
src/components/EdgePopup.tsx
```

### Modified

```
package.json + package-lock.json (MDXEditor v4)
src/App.tsx (NodeJS.Timeout → ReturnType<typeof setTimeout> ×4; viewportOffset prop drop; PR-history comment touch-up)
src/components/ConnectionsComponent.tsx (NodeJS.Timeout fix; setSelectedEdge replaces setEdgePopup; useGraphMutation triad threaded; EdgeAnchorMount wrapper added; dead helpers removed; viewportOffset / zoomScale / setData / onDeleteConnection / EdgePopup import removed)
src/components/GraphTutorial.tsx (NodeJS.Timeout fix; 3 steps → 2; isModalOpen + 100ms interval removed)
src/components/NodeComponent.tsx (inline contentEditable + pencil icon + setNodePopup/editingNodeId/setEditingNodeId/updateNodeTitle props removed; handleClick selection-mode dispatch preserved verbatim)
src/components/TheoryOfChangeGraph.tsx (editingNodeId / nodePopup / edgePopup state retired; updateNode / updateNodeTitle / deleteNode callbacks removed; NodeEditorMount wrapper added; viewportOffset prop removed; setNodePopup arg dropped from useKeyboardShortcuts call; AlignmentSuggestionBanner import + mount)
src/hooks/useKeyboardShortcuts.ts (setNodePopup prop removed)
src/hooks/useZoomPan.ts (NodeJS.Timeout fix)
tests/frontend/NodeComponent.memo.test.tsx (drops setNodePopup / isEditingTitle / setEditingNodeId / updateNodeTitle from baseProps shape)
```

## Deviations

See `.implementation-log.md` PR 3 section. Key autonomous calls:

- **MDXEditor v4 transitive `@types/node` drop** — fixed by migrating
  7 `NodeJS.Timeout` sites to `ReturnType<typeof setTimeout>` (no
  `@types/node` dep added).
- **No `node-drag-start` CustomEvent in current code** — the plan
  anticipated removing one, but it never existed. PR 3 proactively
  declares the `NodeEditor.registerOnDragStartedElsewhere` prop shape
  for PR 4's `usePointerDrag` to plug into.
- **Selection-key shape**: single stable `selectionKey` (sorted ids
  joined with `|`) for `useNodeProperties`, not per-node keys. Avoids
  N-key proliferation on multi-select; trade-off documented inline.
- **DetailsEditor collapsed-with-content preview** renders raw
  markdown (text only, line-clamp-3), not a markdown viewer — a
  viewer would require loading MDXEditor's lexical machinery, exactly
  what the lazy load is avoiding. A future PR can swap in a tiny
  offline markdown renderer.
- **NodeEditor anchor is the FIRST sorted selected id**, not a
  centroid. Stable across selection additions; visually clearer than
  a floating centroid for the typical "edit this one node" case.
- **GraphTutorial collapsed to 2 steps**: the middle "click info
  button" step disappeared along with the pencil icon. Single-click
  on a node now both selects AND opens the editor.

## Integration notes for PR 4

**`NodeEditor.registerOnDragStartedElsewhere` callback prop**:

The prop signature is:

```ts
registerOnDragStartedElsewhere?: (cb: () => void) => void;
```

The parent (currently `TheoryOfChangeGraph`, but PR 4 may move this)
calls `register(cb)` exactly once after mount with a `cb` it will
invoke when a drag begins anywhere on the canvas (i.e. NOT on the
current selection's anchor). NodeEditor stores the registered cb and
fires `onRequestClose()` from inside it.

The contract is intentionally one-way: NodeEditor doesn't expose a
deregistration hook. PR 4's `usePointerDrag` should call `register()`
once on `onStart` with a callback that's a direct dismiss; if the
caller needs to re-register (e.g. when selection changes), today's
implementation re-registers every render of the editor (the
`useEffect` deps are `[registerOnDragStartedElsewhere, onRequestClose]`).
If PR 4 finds that re-register-per-render is too noisy, a stable
registration via ref forwarding would be a clean follow-up.

**`NodeEditor` mount strategy**:

NodeEditor is rendered via the internal `NodeEditorMount` wrapper in
TheoryOfChangeGraph. The wrapper:

1. Reads `highlightedNodes` and sorts the ids.
2. Picks the first sorted id as the anchor source.
3. Looks up `nodeRefs[anchorId]` for the anchor DOM element.
4. Mounts `<NodeEditor>` with a `RefObject<HTMLElement>` pointing at
   the anchor.

If PR 4 changes how nodes get their refs (e.g. moves to a different
state container), the `nodeRefs` map is the only thing
`NodeEditorMount` reads from the graph state. As long as that map
stays {id → HTMLDivElement} it'll continue to work.

**`EdgeEditor` mount strategy**:

EdgeEditor is rendered via `EdgeAnchorMount` inside ConnectionsComponent.
The wrapper:

1. Receives `selectedEdge: {sourceId, targetId, midX, midY}`.
2. Renders a 1x1 invisible div at (midX, midY) inside the connections
   container (so it inherits the same CSS transform as the SVG).
3. Mounts `<EdgeEditor>` with a ref to that div.

If PR 4 introduces connection waypoints (PR 7's territory, but
overlap is possible), the midpoint calc would need to follow the
new path geometry — currently it's the linear midpoint of the
two endpoints.

**Camera prop threading**:

Both editors take `camera: {x, y, z}` so `useAnchorPosition` can
recompute on pan/zoom. TheoryOfChangeGraph passes the camera through
to ConnectionsComponent; ConnectionsComponent passes it through to
the EdgeAnchorMount → EdgeEditor. PR 4 will likely centralize camera
state somewhere new (likely via `usePointerDrag` or the existing
`useZoomPan`); the editor consumers just need a `{x, y, z}` object
that changes when the camera does. No subscription pattern; just a
prop.

## Acceptance gate (Task 3.6)

- [x] No `EditToolbarRemnant` symbol remains; only
      `AlignmentSuggestionBanner` (`grep -rn EditToolbarRemnant src/
tests/` returns one hit — a historical reference inside the
      renamed file).
- [x] Single-click + Cmd/Ctrl+click + Shift+click semantics in
      `NodeComponent.handleClick` (`:66-76`) preserved verbatim from
      before PR 3.
- [x] NodeEditor + EdgeEditor work; multi-select header renders
      "Editing N nodes" (covered by `NodeEditor.test.tsx`).
- [x] MDXEditor v4 plugin imports all resolve (verified by build +
      the existing MDXEditorComponent in `src/components/MDXEditor.tsx`).
- [x] `npm run preflight` green — 448 tests pass, build succeeds,
      typecheck clean, two pre-existing lint warnings only.
