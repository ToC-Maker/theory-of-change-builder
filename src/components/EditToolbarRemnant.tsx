// EditToolbarRemnant — the floating overlays that survived the
// EditToolbar deletion.
//
// History:
//   - The original 2,500-LoC EditToolbar held a fixed top bar, a share
//     dialog, a smart-alignment suggestion banner, and a per-selection
//     floating toolbar above active nodes. PR 1 carved off the top bar.
//   - PR 2 deleted the share dialog block.
//   - PR 3 deleted the per-selection toolbar (its width/color/delete
//     controls moved into the anchored `<NodeEditor>`). Only the
//     alignment banner remains. The file is renamed to
//     `AlignmentSuggestionBanner.tsx` at the end of PR 3.
//
// State ownership (state map per plan §1.6 acceptance): the remnant
// component itself is now stateless; the only sub-component
// (AlignmentBanner) owns its own state.

import { useCallback, useEffect, useState } from 'react';
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
// EditToolbarRemnant — only the alignment banner remains.
// =====================================================================

export interface EditToolbarRemnantProps {
  editMode: boolean;
  showEditButton: boolean;
  data: ToCData;
  straightenEdges: () => void;
}

export function EditToolbarRemnant(props: EditToolbarRemnantProps) {
  if (!props.showEditButton) return null;
  return (
    <AlignmentBanner
      editMode={props.editMode}
      data={props.data}
      straightenEdges={props.straightenEdges}
    />
  );
}
