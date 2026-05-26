// `NodeEditor` — the unified anchored editor that replaced three pre-PR-3
// node-editing affordances:
//
//   1. The per-selection floating toolbar (`PerSelectionToolbar`) that
//      held width / color / delete above the active selection.
//   2. The inline `contentEditable` <div> embedded in `NodeComponent`
//      that handled in-place title edits.
//   3. The `<NodePopup>` modal that opened from the pencil icon for
//      title + markdown details editing.
//
// All three converge here: a single floating editor anchored below the
// currently-selected node, with title (input), visual controls (width
// slider, color picker, delete button), and an inline MDXEditor for the
// details block. Multi-selection writes apply to all selected nodes;
// single-selection writes target the one. See `useNodeProperties.ts`
// for the commit-cadence semantics.
//
// ---------------------------------------------------------------------------
// Anchoring (PR 7 feedback: bottom-placement)
// ---------------------------------------------------------------------------
//
// The editor portals to `document.body` (so its z-index escapes whatever
// transform stack the canvas applies) and is `position: fixed`-positioned
// by `useAnchorPosition` with `placement: 'bottom'`. The hook subscribes
// to camera, anchor resize, overlay resize, and DOM mutations so the
// overlay stays glued to the node across pan, zoom, and graph reflow.
//
// Why bottom (not right)? When the editor sat to the side and the user
// dragged the width slider, the node grew wider, the editor re-anchored
// to the new right edge, and the slider track translated horizontally
// out from under the cursor — making the drag effectively unbounded
// upward. Anchoring below keeps the slider track stationary in screen
// space during a width drag (the only motion is the slider thumb under
// the cursor).
//
// `flip: true` lets the hook escalate to top-placement when the node
// sits near the viewport's bottom edge and the editor wouldn't fit
// below (e.g. a goal-column node on a short window).
//
// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
//
// Buffered title / details writes are flushed on unmount via a cleanup
// effect that calls `commitTitle()` and `commitDetails()`. The hook
// `useNodeProperties` itself does NOT install this — see the file-header
// comment there for the rationale (we want one explicit owner of the
// "close → flush" edge so accordion mount/unmount within the editor
// doesn't double-commit).
//
// ---------------------------------------------------------------------------
// onDragStartedElsewhere (PR 4 integration seam)
// ---------------------------------------------------------------------------
//
// PR 4's `usePointerDrag` will fire `onStart` when a drag begins on a
// node. The editor needs to dismiss itself when that happens (otherwise
// it'd hang in mid-air on a now-moved anchor). Today there's no
// CustomEvent and no actual drag in flight, so this is just the prop
// shape PR 4 will plumb. The plan section "Red-team Important —
// CustomEvent→callback prop" specifies a direct callback to avoid the
// event-ordering hazard CustomEvent would introduce; we expose
// `registerOnDragStartedElsewhere` so the parent can plug a single
// callback in (instead of NodeEditor itself wiring an event listener).
//
// ---------------------------------------------------------------------------
// Dismissal
// ---------------------------------------------------------------------------
//
// Outside-click + Escape dismissal live in the shared
// `useDismissOnOutsideEvent` hook (same one EdgeEditor uses). The anchor
// (the selected node's DOM element) is in the "safe" set so a click on
// the node itself doesn't dismiss the editor it just opened.
//
// `useKeyboardShortcuts.clearSelections` ALSO fires on Escape and clears
// `highlightedNodes`, which causes this editor to unmount. The two
// Escape paths are intentionally redundant: the global path bails when
// an input is focused (`isInputFocused()`), while the hook's path
// closes even from a focused input inside our container. Our hook's
// `onDismiss` is `setHighlightedNodes(new Set())` (idempotent), so the
// overlap is benign.
import { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { TrashIcon } from '@heroicons/react/24/outline';
import type { SetStateAction } from 'react';
import type { ToCData } from '../../types';
import { useNodeProperties } from './useNodeProperties';
import { useAnchorPosition } from './useAnchorPosition';
import { DetailsEditor } from './DetailsEditor';
import { useDismissOnOutsideEvent } from '../../hooks/useDismissOnOutsideEvent';

type GraphUpdater = SetStateAction<ToCData>;

interface NodeEditorProps {
  /** Currently-selected node ids (1+ for the editor to be visible). */
  selectedNodeIds: string[];
  /** Live graph data. Used to read current property values. */
  data: ToCData;
  /** Anchor element (the first selected node's wrapper). */
  anchorRef: React.RefObject<HTMLElement | null>;
  /** Camera state — passed through to `useAnchorPosition`. */
  camera: { x: number; y: number; z: number };
  /** From useGraphMutation. */
  mutate: (updater: GraphUpdater) => void;
  mutateDebounced: (updater: GraphUpdater, key: string) => void;
  commit: (key?: string) => void;
  /** Fired on outside click or registered drag-start. */
  onRequestClose: () => void;
  /**
   * PR 4 seam: the parent registers a single callback here that fires
   * when a drag starts elsewhere on the canvas. We call
   * `onRequestClose()` from inside.
   */
  registerOnDragStartedElsewhere?: (cb: () => void) => void;
  fontFamily?: string;
}

export function NodeEditor(props: NodeEditorProps) {
  const {
    selectedNodeIds,
    data,
    anchorRef,
    camera,
    mutate,
    mutateDebounced,
    commit,
    onRequestClose,
    registerOnDragStartedElsewhere,
    fontFamily,
  } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);

  const props_ = useNodeProperties({
    selectedNodeIds,
    data,
    mutate,
    mutateDebounced,
    commit,
  });

  const position = useAnchorPosition({
    anchorRef,
    overlayRef: containerRef,
    camera,
    placement: 'bottom',
    offset: 12,
    flip: true,
  });

  // Cleanup: flush buffered title + details writes on unmount. This is
  // the canonical "close → commit" edge for the editor. Calling commit
  // with the current selection key is safe even if nothing's buffered
  // (the underlying useGraphMutation no-ops on an unknown key).
  //
  // We track the LATEST commit closures via refs: `commitTitle` /
  // `commitDetails` are `useCallback`-wrapped with `[commit, selKey]`
  // deps, so their identity changes on every selection switch. The
  // older pattern (capturing locals once at the mount-effect's first
  // render) flushed the FIRST render's key on unmount, missing the
  // current selection's buffered typing.
  const commitTitleRef = useRef(props_.commitTitle);
  const commitDetailsRef = useRef(props_.commitDetails);
  commitTitleRef.current = props_.commitTitle;
  commitDetailsRef.current = props_.commitDetails;
  useEffect(() => {
    return () => {
      commitTitleRef.current();
      commitDetailsRef.current();
    };
  }, []);

  // Register the PR-4 drag-start callback. The parent owns the actual
  // gesture event; we just need to know when it fires.
  useEffect(() => {
    if (!registerOnDragStartedElsewhere) return;
    registerOnDragStartedElsewhere(() => onRequestClose());
  }, [registerOnDragStartedElsewhere, onRequestClose]);

  // Outside-click + Escape dismissal via the shared hook. The anchor
  // (the selected node's wrapper element) is in the "safe" set so a
  // click on the node itself — including its connection-source dots,
  // resize handles, and drag handle — doesn't dismiss the editor.
  //
  // `useMemo` keeps the safe-refs array reference-stable across renders
  // so the hook's effect deps don't churn.
  const safeRefs = useMemo(() => [anchorRef] as const, [anchorRef]);
  useDismissOnOutsideEvent({
    containerRef,
    onDismiss: onRequestClose,
    extraSafeRefs: safeRefs,
  });

  if (selectedNodeIds.length === 0) return null;

  const headerText =
    selectedNodeIds.length === 1 ? 'Edit node' : `Editing ${selectedNodeIds.length} nodes`;

  return createPortal(
    <div
      ref={containerRef}
      className="node-editor fixed z-[150] bg-white rounded-lg shadow-xl border border-gray-200 p-3 w-72 text-sm"
      style={
        position
          ? { left: position.x, top: position.y, fontFamily }
          : // Hide off-screen until the first measure lands, so we don't
            // flash at (0, 0).
            { left: -9999, top: -9999, fontFamily }
      }
      onMouseDown={(e) => {
        // Clicks inside should NOT bubble out and trigger the outside-
        // click dismissal. Stopping propagation here also keeps the
        // node-component selection handler from re-firing.
        e.stopPropagation();
      }}
    >
      <div className="node-editor__header flex items-center justify-between mb-2 pb-2 border-b border-gray-100">
        <span className="text-xs font-semibold text-gray-700">{headerText}</span>
        <button
          type="button"
          onClick={() => {
            // Match EdgeEditor.handleDelete: clear the selection alongside
            // the data delete so the editor doesn't re-render anchored to
            // the now-detached node ref. The keyboard-delete path in
            // `useKeyboardShortcuts` does the same.
            props_.deleteSelectedNodes();
            onRequestClose();
          }}
          className="p-1 text-gray-500 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
          title={selectedNodeIds.length === 1 ? 'Delete node' : 'Delete nodes'}
          aria-label={selectedNodeIds.length === 1 ? 'Delete node' : 'Delete nodes'}
        >
          <TrashIcon className="w-4 h-4" />
        </button>
      </div>

      {/* Title (buffered + streamed). Multi-select shows placeholder when
          values differ. */}
      <label className="block">
        <span className="text-xs text-gray-600 mb-1 block">Title</span>
        <input
          type="text"
          aria-label="Node title"
          value={props_.title}
          placeholder={props_.isTitleMixed ? 'Multiple values' : 'Untitled'}
          onChange={(e) => props_.setTitle(e.target.value)}
          onBlur={() => props_.commitTitle()}
          className="w-full px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
          style={{ fontFamily }}
        />
      </label>

      {/* Visual controls: width slider on its own row so the slider
          gets the full content width, plus color on its own row so the
          color swatch can't be pushed past the editor's right edge by
          the slider track. (PR 7 feedback: "color picker overflows".) */}
      <div className="node-editor__visuals mt-3 space-y-2">
        <label className="flex items-center gap-2">
          <span className="text-xs text-gray-600 whitespace-nowrap">Width</span>
          <input
            type="range"
            min={128}
            max={320}
            step={8}
            value={props_.width}
            onChange={(e) => props_.setWidth(parseInt(e.target.value, 10))}
            onPointerUp={() => props_.commitWidth()}
            onBlur={() => props_.commitWidth()}
            className="flex-1 min-w-0 h-1 bg-gray-200 rounded appearance-none cursor-pointer"
            aria-label="Node width"
          />
          <span className="text-xs text-gray-500 w-10 text-right tabular-nums">{props_.width}</span>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-xs text-gray-600 whitespace-nowrap">Color</span>
          <input
            type="color"
            value={props_.color}
            onChange={(e) => props_.setColor(e.target.value)}
            className="w-6 h-6 rounded border border-gray-300 cursor-pointer shrink-0"
            aria-label="Node color"
          />
        </label>
      </div>

      {/* Details — always-on inline MDXEditor (lazy chunk loads on
          mount; skeleton covers the download). The old "Edit details"
          toggle is gone (PR 7 feedback: "the node editor shouldn't be
          in two parts"). */}
      <div className="node-editor__details mt-3 pt-2 border-t border-gray-100">
        <DetailsEditor
          markdown={props_.details}
          onChange={(md) => props_.setDetails(md)}
          placeholder={
            props_.isDetailsMixed ? 'Multiple values' : 'Add details (markdown supported)…'
          }
          fontFamily={fontFamily}
        />
      </div>
    </div>,
    document.body,
  );
}
