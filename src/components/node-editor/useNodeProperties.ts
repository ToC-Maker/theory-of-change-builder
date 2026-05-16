// `useNodeProperties` — bridges the NodeEditor UI to `useGraphMutation`.
//
// Replaces three divergent commit paths from before PR 3:
//   1. The per-selection toolbar (width slider streamed via direct setData,
//      color picker stored only in TheoryOfChangeGraph local state).
//   2. The inline contentEditable in NodeComponent (title edits dispatched
//      via `updateNodeTitle` with no debouncing).
//   3. The NodePopup modal (a separate React state mirror of title/text,
//      committed on close — different cadence again).
//
// All three converge here on the `useGraphMutation` primitive:
//   - Live (streaming):
//       setWidth  → mutateDebounced(key='width-${selectionKey}')
//                   commitWidth() called from <input onPointerUp>.
//       setColor  → mutate(...)  (discrete single-value picker write)
//   - Buffered (typing):
//       setTitle  → keeps local state for instant preview AND streams via
//                   mutateDebounced(key='title-${selectionKey}') so other
//                   observers see partial typing. commitTitle() flushes
//                   on blur / on NodeEditor unmount.
//       setDetails → same shape as title, key 'details-${selectionKey}'.
//
// The `selectionKey` is a stable hash of the sorted selected ids, so
// re-selection of the same set re-uses the same buffer key. Switching
// selection changes the key and naturally segregates the per-key buffer.
//
// ---------------------------------------------------------------------------
// Multi-selection
// ---------------------------------------------------------------------------
//
// All writes apply to every node in `selectedNodeIds`. Title/details show
// "Multiple values" when the selected nodes disagree; the caller renders
// that empty-string + placeholder combo. width/color expose the value of
// the FIRST selected node (we don't surface "mixed" for those — the
// toolbar always showed one slider value historically, and write-to-all
// is the user-facing intent).
//
// ---------------------------------------------------------------------------
// Selection-change buffer reset
// ---------------------------------------------------------------------------
//
// When `selectedNodeIds` changes (different node clicked, multi-select
// added/removed), the local title/details buffer resets to read from the
// new selection. Any unflushed typing on the previous selection is
// LOST locally — but it has already been written to live state via
// mutateDebounced, so the parent retains it under the previous key. If
// the user wanted to keep typing they'd return to that selection.
//
// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
//
// `useNodeProperties` itself does NOT install an unmount commit; that's
// the caller's job (NodeEditor cleanup effect calls commitTitle() +
// commitDetails()). This keeps the hook pure data and avoids surprising
// double-commits when NodeEditor sub-components mount/unmount.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Node as GraphNode, ToCData } from '../../types';

type GraphUpdater = SetStateAction<ToCData>;

interface UseNodePropertiesArgs {
  selectedNodeIds: string[];
  data: ToCData;
  mutate: (updater: GraphUpdater) => void;
  mutateDebounced: (updater: GraphUpdater, key: string) => void;
  commit: (key?: string) => void;
}

export interface UseNodePropertiesResult {
  // Current values (read from `data`).
  title: string;
  details: string;
  width: number;
  color: string;
  // Mixed-value flags for the caller's placeholder rendering. width/color
  // intentionally have no mixed flag — the bar always wrote-to-all.
  isTitleMixed: boolean;
  isDetailsMixed: boolean;
  // Setters.
  setTitle: (next: string) => void;
  setDetails: (next: string) => void;
  setWidth: (next: number) => void;
  setColor: (next: string) => void;
  // Commit endpoints (called from <input onBlur> / onPointerUp / component
  // unmount).
  commitTitle: () => void;
  commitDetails: () => void;
  commitWidth: () => void;
  commitColor: () => void;
  // Discrete delete action.
  deleteSelectedNodes: () => void;
  // True iff any buffered key still has unflushed live state. Currently
  // a coarse proxy — true while any setX has been called since the last
  // selection change.
  isDirty: boolean;
}

const DEFAULT_WIDTH = 192;
const DEFAULT_COLOR = '#ffffff';

function findAllNodes(data: ToCData): GraphNode[] {
  return data.sections.flatMap((s) => s.columns.flatMap((c) => c.nodes));
}

function findNodeById(data: ToCData, id: string): GraphNode | undefined {
  return findAllNodes(data).find((n) => n.id === id);
}

/**
 * Stable, order-independent key for a selection. Switching from {a,b} to
 * {b,a} produces the same key, so the per-key idle buffer stays warm.
 */
function selectionKey(ids: string[]): string {
  if (ids.length === 0) return 'none';
  if (ids.length === 1) return ids[0];
  return [...ids].sort().join('|');
}

export function useNodeProperties(args: UseNodePropertiesArgs): UseNodePropertiesResult {
  const { selectedNodeIds, data, mutate, mutateDebounced, commit } = args;

  // Stable selection key + a cached sort so the per-call updater can
  // membership-test in O(1).
  const selKey = useMemo(() => selectionKey(selectedNodeIds), [selectedNodeIds]);
  const selSet = useMemo(() => new Set(selectedNodeIds), [selectedNodeIds]);

  const selectedNodes = useMemo(
    () => selectedNodeIds.map((id) => findNodeById(data, id)).filter((n): n is GraphNode => !!n),
    [data, selectedNodeIds],
  );

  // Mixed-value detection: equal across all selected nodes (treating
  // undefined-vs-empty as equal for the typing properties).
  const titleValues = selectedNodes.map((n) => n.title ?? '');
  const detailsValues = selectedNodes.map((n) => n.text ?? '');
  const isTitleMixed = selectedNodes.length > 1 && new Set(titleValues).size > 1;
  const isDetailsMixed = selectedNodes.length > 1 && new Set(detailsValues).size > 1;

  // Source-of-truth title / details for the UI. When mixed, expose '' so
  // the input renders the placeholder; otherwise expose the shared value.
  const sourceTitle = isTitleMixed ? '' : (titleValues[0] ?? '');
  const sourceDetails = isDetailsMixed ? '' : (detailsValues[0] ?? '');

  // Local buffers for title/details. Initialized from the source and
  // re-synced whenever the selection changes. Local typing reflects
  // instantly; the live state also receives it via mutateDebounced so
  // external observers (other open editors, hot AI edits) see consistent
  // partial values.
  const [titleBuffer, setTitleBuffer] = useState(sourceTitle);
  const [detailsBuffer, setDetailsBuffer] = useState(sourceDetails);

  // Re-sync the local buffer when the selection changes. We compare to
  // the *new* sourceTitle/sourceDetails so a re-render that doesn't
  // change selection doesn't clobber unflushed typing.
  const lastSelKeyRef = useRef(selKey);
  useEffect(() => {
    if (lastSelKeyRef.current !== selKey) {
      lastSelKeyRef.current = selKey;
      setTitleBuffer(sourceTitle);
      setDetailsBuffer(sourceDetails);
    }
  }, [selKey, sourceTitle, sourceDetails]);

  // Width/color: read the first selected node's value (or default if no
  // selection / property unset).
  const width = selectedNodes[0]?.width ?? DEFAULT_WIDTH;
  const color = selectedNodes[0]?.color ?? DEFAULT_COLOR;

  // Dirty bit: any setX since the last selection change. Cleared on
  // commit*.
  const [isDirty, setIsDirty] = useState(false);
  useEffect(() => {
    setIsDirty(false);
  }, [selKey]);

  // ---------------------------------------------------------------
  // Setters
  // ---------------------------------------------------------------

  // Build an updater that maps `mapper` over every selected node. This
  // is the workhorse of every multi-selection write.
  const mapSelected = useCallback(
    (mapper: (node: GraphNode) => GraphNode) => {
      return (prev: ToCData): ToCData => ({
        ...prev,
        sections: prev.sections.map((section) => ({
          ...section,
          columns: section.columns.map((column) => ({
            ...column,
            nodes: column.nodes.map((node) => (selSet.has(node.id) ? mapper(node) : node)),
          })),
        })),
      });
    },
    [selSet],
  );

  const setTitle = useCallback(
    (next: string) => {
      setTitleBuffer(next);
      setIsDirty(true);
      mutateDebounced(
        mapSelected((node) => ({ ...node, title: next })),
        `title-${selKey}`,
      );
    },
    [mutateDebounced, mapSelected, selKey],
  );

  const setDetails = useCallback(
    (next: string) => {
      setDetailsBuffer(next);
      setIsDirty(true);
      mutateDebounced(
        mapSelected((node) => ({ ...node, text: next })),
        `details-${selKey}`,
      );
    },
    [mutateDebounced, mapSelected, selKey],
  );

  const setWidth = useCallback(
    (next: number) => {
      setIsDirty(true);
      mutateDebounced(
        mapSelected((node) => ({ ...node, width: next })),
        `width-${selKey}`,
      );
    },
    [mutateDebounced, mapSelected, selKey],
  );

  const setColor = useCallback(
    (next: string) => {
      setIsDirty(true);
      // Color is a single-emit picker, not a stream — use the discrete
      // `mutate` so the undo entry lands immediately.
      mutate(mapSelected((node) => ({ ...node, color: next })));
    },
    [mutate, mapSelected],
  );

  // ---------------------------------------------------------------
  // Commits
  // ---------------------------------------------------------------

  const commitTitle = useCallback(() => {
    commit(`title-${selKey}`);
    setIsDirty(false);
  }, [commit, selKey]);

  const commitDetails = useCallback(() => {
    commit(`details-${selKey}`);
    setIsDirty(false);
  }, [commit, selKey]);

  const commitWidth = useCallback(() => {
    commit(`width-${selKey}`);
    setIsDirty(false);
  }, [commit, selKey]);

  // color uses `mutate` directly, so there's no buffered key to flush.
  // The commit is a no-op kept for symmetry / future use.
  const commitColor = useCallback(() => {
    setIsDirty(false);
  }, []);

  const deleteSelectedNodes = useCallback(() => {
    if (selectedNodeIds.length === 0) return;
    mutate((prev) => ({
      ...prev,
      sections: prev.sections.map((section) => ({
        ...section,
        columns: section.columns.map((column) => ({
          ...column,
          nodes: column.nodes
            .filter((node) => !selSet.has(node.id))
            .map((node) => ({
              ...node,
              connectionIds: node.connectionIds?.filter((id) => !selSet.has(id)) ?? [],
              connections: node.connections?.filter((conn) => !selSet.has(conn.targetId)),
            })),
        })),
      })),
    }));
  }, [mutate, selSet, selectedNodeIds]);

  return {
    title: titleBuffer,
    details: detailsBuffer,
    width,
    color,
    isTitleMixed,
    isDetailsMixed,
    setTitle,
    setDetails,
    setWidth,
    setColor,
    commitTitle,
    commitDetails,
    commitWidth,
    commitColor,
    deleteSelectedNodes,
    isDirty,
  };
}

export type { Dispatch, SetStateAction };
