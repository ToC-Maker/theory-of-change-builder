// EditToolbarRemnant — the floating overlays that survived the
// EditToolbar deletion in PR 1.
//
// The original EditToolbar was a 2,500-LoC mixed bag: a fixed top bar
// (now replaced by `top-bar/TopBar`), a share dialog, a smart-alignment
// suggestion banner, and a per-selection floating toolbar above the
// active nodes. PR 1 carved off the TopBar. PR 2 deletes the share
// dialog block (replaced by `share/ShareDialog`). What remains:
//
//   - `<PerSelectionToolbar>` →  PR 3 folds it into the anchored
//                                 NodeEditor.
//   - `<AlignmentBanner>`  →  PR 3 renames the file to
//                              AlignmentSuggestionBanner.tsx once the
//                              other two are gone.
//
// =====================================================================
// State / ref map (per plan §1.6 acceptance — "explicit state map")
// =====================================================================
//
// Each sub-component owns its own state copy. The remnant lifts NOTHING.
//
// PerSelectionToolbar:
//   useState  toolbarPosition (x, y)
//
// AlignmentBanner:
//   useState  show
//   (plus a `useCallback` named `detect` for the misalignment heuristic,
//    kept inside the component so its deps stay local)
//
// EditToolbarRemnant itself: no state. It just wires the two children.

import { useCallback, useEffect, useState } from 'react';
import { TrashIcon } from '@heroicons/react/24/outline';
import type { Node as GraphNode, ToCData } from '../types';

// =====================================================================
// AlignmentBanner — floating "Clean up alignment?" popup
// =====================================================================

interface AlignmentBannerProps {
  editMode: boolean;
  data: ToCData;
  straightenEdges: () => void;
}

function AlignmentBanner({ editMode, data, straightenEdges }: AlignmentBannerProps) {
  const [show, setShow] = useState(false);

  const detect = useCallback((): boolean => {
    if (!editMode) return false;
    const allNodes: { node: GraphNode; centerY: number }[] = [];
    data.sections.forEach((section) => {
      section.columns.forEach((column) => {
        column.nodes.forEach((node) => {
          allNodes.push({ node, centerY: node.yPosition ?? 0 });
        });
      });
    });
    if (allNodes.length < 2) return false;

    const tolerance = 40;
    const groups: (typeof allNodes)[] = [];
    allNodes.forEach((nd) => {
      let added = false;
      for (const group of groups) {
        const avgY = group.reduce((s, n) => s + n.centerY, 0) / group.length;
        if (Math.abs(nd.centerY - avgY) <= tolerance) {
          group.push(nd);
          added = true;
          break;
        }
      }
      if (!added) groups.push([nd]);
    });
    return groups.some((g) => {
      if (g.length < 2) return false;
      const ys = g.map((n) => n.centerY);
      return Math.max(...ys) - Math.min(...ys) > 0;
    });
  }, [editMode, data]);

  useEffect(() => {
    setShow(editMode && detect());
  }, [editMode, detect]);

  if (!show) return null;

  return (
    <div
      className="absolute z-50 bg-white rounded-lg shadow-lg border border-gray-200 px-2 py-2 max-w-xs transition-all duration-300 ease-out"
      style={{ right: '20px', bottom: '20px' }}
    >
      <div className="flex flex-col items-center text-center gap-3">
        <div className="flex items-center justify-center gap-3 w-full">
          {/* Misaligned nodes */}
          <svg
            className="w-12 h-12 text-blue-600"
            fill="currentColor"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <rect x="2" y="8" width="3" height="8" rx="1.5" opacity="0.7" />
            <rect x="8" y="10" width="3" height="8" rx="1.5" opacity="0.7" />
            <rect x="14" y="7" width="3" height="8" rx="1.5" opacity="0.7" />
          </svg>
          {/* Arrow */}
          <svg
            className="w-8 h-8 text-blue-600"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M8 12h8m0 0l-3-3m3 3l-3 3"
            />
          </svg>
          {/* Aligned nodes */}
          <svg
            className="w-12 h-12 text-blue-600"
            fill="currentColor"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <rect x="2" y="8" width="3" height="8" rx="1.5" opacity="0.7" />
            <rect x="8" y="8" width="3" height="8" rx="1.5" opacity="0.7" />
            <rect x="14" y="8" width="3" height="8" rx="1.5" opacity="0.7" />
          </svg>
        </div>
        <div>
          <div className="text-sm font-medium text-gray-900 mb-1">Clean up alignment?</div>
          <div className="text-xs text-gray-600 mb-3">
            Some nodes are close but not perfectly aligned
          </div>
          <div className="flex gap-2 justify-center">
            <button
              onClick={() => {
                straightenEdges();
                setShow(false);
              }}
              className="px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded hover:bg-blue-700 transition-colors"
            >
              Align nodes
            </button>
            <button
              onClick={() => setShow(false)}
              className="px-3 py-1.5 text-gray-600 text-xs rounded hover:bg-gray-100 transition-colors"
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// PerSelectionToolbar — Miro-style horizontal bar above active nodes
// =====================================================================

interface PerSelectionToolbarProps {
  editMode: boolean;
  highlightedNodes: Set<string>;
  setHighlightedNodes: React.Dispatch<React.SetStateAction<Set<string>>>;
  nodeWidth: number;
  setNodeWidth: React.Dispatch<React.SetStateAction<number>>;
  nodeColor: string;
  setNodeColor: React.Dispatch<React.SetStateAction<string>>;
  setData: React.Dispatch<React.SetStateAction<ToCData>>;
  mutateDebounced?: (updater: React.SetStateAction<ToCData>, key: string) => void;
  commitMutation?: (key?: string) => void;
  onDeleteNode?: (nodeId: string) => void;
  nodePopup?: unknown;
  edgePopup?: unknown;
  camera?: { x: number; y: number; z: number };
}

function PerSelectionToolbar({
  editMode,
  highlightedNodes,
  setHighlightedNodes,
  nodeWidth,
  setNodeWidth,
  nodeColor,
  setNodeColor,
  setData,
  mutateDebounced,
  commitMutation,
  onDeleteNode,
  nodePopup,
  edgePopup,
  camera,
}: PerSelectionToolbarProps) {
  const [toolbarPosition, setToolbarPosition] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (highlightedNodes.size === 0) return;
    const nodeElements = Array.from(highlightedNodes)
      .map((nodeId) => document.getElementById(`node-${nodeId}`))
      .filter((el): el is HTMLElement => el !== null);

    if (nodeElements.length > 0) {
      const rects = nodeElements.map((el) => el.getBoundingClientRect());
      const avgX = rects.reduce((sum, rect) => sum + rect.left + rect.width / 2, 0) / rects.length;
      const topY = Math.min(...rects.map((rect) => rect.top));
      setToolbarPosition({ x: avgX, y: topY - 80 });
    }
  }, [highlightedNodes, camera?.x, camera?.y, camera?.z]);

  if (!editMode || highlightedNodes.size === 0 || nodePopup || edgePopup) return null;

  return (
    <div
      className="fixed z-[60] bg-white rounded-lg shadow-lg border border-gray-200 px-2 sm:px-4 py-2 sm:py-3"
      style={{
        left: Math.min(Math.max(toolbarPosition.x, 150), window.innerWidth - 150),
        top: Math.max(toolbarPosition.y, 60),
        transform: 'translateX(-50%)',
        minWidth: 'auto',
        maxWidth: 'calc(100vw - 1rem)',
      }}
    >
      <div className="flex items-center gap-2 sm:gap-6 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-xs sm:text-sm font-medium text-gray-700">
            {highlightedNodes.size === 1 ? '' : `${highlightedNodes.size} nodes`}
          </span>
        </div>

        {highlightedNodes.size > 1 && <div className="h-4 w-px bg-gray-300 hidden sm:block"></div>}

        {/* Width slider — streaming input via mutateDebounced/commit */}
        <div className="flex items-center gap-1 sm:gap-2">
          <span className="text-xs sm:text-sm text-gray-600 hidden sm:inline">Width</span>
          <input
            type="range"
            min="128"
            max="320"
            step="16"
            value={nodeWidth}
            onChange={(e) => {
              const newWidth = parseInt(e.target.value);
              setNodeWidth(newWidth);
              if (highlightedNodes.size === 0) return;
              const updater = (prevData: ToCData) => ({
                ...prevData,
                sections: prevData.sections.map((section) => ({
                  ...section,
                  columns: section.columns.map((column) => ({
                    ...column,
                    nodes: column.nodes.map((node) =>
                      highlightedNodes.has(node.id) ? { ...node, width: newWidth } : node,
                    ),
                  })),
                })),
              });
              if (mutateDebounced) {
                mutateDebounced(updater, 'width-multi');
              } else {
                setData(updater);
              }
            }}
            onPointerUp={() => commitMutation?.('width-multi')}
            onBlur={() => commitMutation?.('width-multi')}
            className="w-16 sm:w-20 h-1 rounded-lg appearance-none cursor-pointer bg-gray-200"
          />
          <span className="text-xs text-gray-500 w-8 sm:w-10 text-right">{nodeWidth}</span>
        </div>

        <div className="h-4 w-px bg-gray-300 hidden sm:block"></div>

        <div className="flex items-center gap-1 sm:gap-2">
          <span className="text-xs sm:text-sm text-gray-600 hidden sm:inline">Color</span>
          <input
            type="color"
            value={nodeColor}
            onChange={(e) => {
              const newColor = e.target.value;
              setNodeColor(newColor);
              if (highlightedNodes.size > 0) {
                setData((prevData) => ({
                  ...prevData,
                  sections: prevData.sections.map((section) => ({
                    ...section,
                    columns: section.columns.map((column) => ({
                      ...column,
                      nodes: column.nodes.map((node) =>
                        highlightedNodes.has(node.id) ? { ...node, color: newColor } : node,
                      ),
                    })),
                  })),
                }));
              }
            }}
            className="w-6 h-6 sm:w-8 sm:h-8 rounded border border-gray-300 cursor-pointer"
          />
        </div>

        {onDeleteNode && (
          <>
            <div className="h-4 w-px bg-gray-300 hidden sm:block"></div>
            <button
              onClick={() => {
                highlightedNodes.forEach((nodeId) => onDeleteNode(nodeId));
                setHighlightedNodes(new Set());
              }}
              className="p-1.5 sm:p-2 text-gray-600 hover:text-red-600 hover:bg-red-50 rounded transition-all duration-200"
              title={`Delete ${highlightedNodes.size === 1 ? 'node' : 'nodes'}`}
            >
              <TrashIcon className="w-4 h-4 sm:w-5 sm:h-5" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// =====================================================================
// EditToolbarRemnant — composes the two remaining overlays
// =====================================================================

export interface EditToolbarRemnantProps {
  // Shared.
  editMode: boolean;
  showEditButton: boolean;
  data: ToCData;
  setData: React.Dispatch<React.SetStateAction<ToCData>>;
  // Alignment banner.
  straightenEdges: () => void;
  // Per-selection.
  highlightedNodes: Set<string>;
  setHighlightedNodes: React.Dispatch<React.SetStateAction<Set<string>>>;
  nodeWidth: number;
  setNodeWidth: React.Dispatch<React.SetStateAction<number>>;
  nodeColor: string;
  setNodeColor: React.Dispatch<React.SetStateAction<string>>;
  mutateDebounced?: (updater: React.SetStateAction<ToCData>, key: string) => void;
  commitMutation?: (key?: string) => void;
  onDeleteNode?: (nodeId: string) => void;
  nodePopup?: unknown;
  edgePopup?: unknown;
  camera?: { x: number; y: number; z: number };
}

export function EditToolbarRemnant(props: EditToolbarRemnantProps) {
  if (!props.showEditButton) return null;
  return (
    <>
      <AlignmentBanner
        editMode={props.editMode}
        data={props.data}
        straightenEdges={props.straightenEdges}
      />
      <PerSelectionToolbar
        editMode={props.editMode}
        highlightedNodes={props.highlightedNodes}
        setHighlightedNodes={props.setHighlightedNodes}
        nodeWidth={props.nodeWidth}
        setNodeWidth={props.setNodeWidth}
        nodeColor={props.nodeColor}
        setNodeColor={props.setNodeColor}
        setData={props.setData}
        mutateDebounced={props.mutateDebounced}
        commitMutation={props.commitMutation}
        onDeleteNode={props.onDeleteNode}
        nodePopup={props.nodePopup}
        edgePopup={props.edgePopup}
        camera={props.camera}
      />
    </>
  );
}
