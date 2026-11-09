// `computeLandingIndicator` decides what the drag landing indicator draws:
//   - new-column: the gutter rect between the two neighbouring columns.
//   - node targets: nothing. Over a column the dragged node's copy snaps
//     into place (see `computeDropPreview`) and marks the spot itself.
//   - new-section: nothing, since `handleDrop` ignores that target and a
//     "will land here" mark would promise a move that never happens.
//   - nothing at all until the drag has crossed the tap dead-zone.
import { describe, it, expect } from 'vitest';
import { computeLandingIndicator } from '../../src/utils/landingIndicator';
import type { DragState } from '../../src/hooks/usePointerDrag';
import type { LayoutSnapshot } from '../../src/hooks/useGraphLayout';

const snapshot: LayoutSnapshot = {
  sectionPadding: 32,
  columnPadding: 24,
  columnRects: [
    [
      { left: 50, right: 250, top: 100, bottom: 900 },
      { left: 274, right: 474, top: 100, bottom: 900 },
    ],
    [{ left: 522, right: 722, top: 100, bottom: 900 }],
  ],
  containerWidth: 800,
  containerHeight: 1000,
  nodeRects: { '0-0': [], '0-1': [], '1-0': [] },
};

const dragState = (over: Partial<DragState> = {}): DragState => ({
  nodeId: 'n-1',
  ghostPos: { x: 0, y: 0 },
  pointerOffset: { x: 40, y: 30 },
  nodeSize: { width: 192, height: 76 },
  dragOverLocation: { kind: 'node-slot', sectionIndex: 0, columnIndex: 0, yPosition: 300 },
  hasMoved: true,
  ...over,
});

const args = (state: DragState, zoomScale = 1) => ({
  dragState: state,
  snapshot,
  zoomScale,
  nodeHeight: 76,
});

describe('computeLandingIndicator — node targets', () => {
  it('draws nothing over a column: the snapped copy shows the landing spot', () => {
    expect(computeLandingIndicator(args(dragState()))).toBeNull();
    const over = dragState({
      dragOverLocation: { kind: 'over-node', sectionIndex: 0, columnIndex: 0, yPosition: 300 },
    });
    expect(computeLandingIndicator(args(over))).toBeNull();
  });
});

describe('computeLandingIndicator — gutter targets', () => {
  it('highlights the gutter between the two columns a new column would sit between', () => {
    const state = dragState({
      dragOverLocation: { kind: 'new-column', sectionIndex: 0, columnIndex: 1 },
    });
    expect(computeLandingIndicator(args(state))).toEqual({
      kind: 'gutter',
      left: 250,
      width: 24,
      top: 100,
      height: 800,
    });
  });

  it('returns null for a new-column index with no left or right neighbour', () => {
    const atStart = dragState({
      dragOverLocation: { kind: 'new-column', sectionIndex: 0, columnIndex: 0 },
    });
    const atEnd = dragState({
      dragOverLocation: { kind: 'new-column', sectionIndex: 0, columnIndex: 2 },
    });
    expect(computeLandingIndicator(args(atStart))).toBeNull();
    expect(computeLandingIndicator(args(atEnd))).toBeNull();
  });

  it('returns null for new-section: the drop is ignored, so nothing may promise a landing', () => {
    const state = dragState({ dragOverLocation: { kind: 'new-section', sectionIndex: 1 } });
    expect(computeLandingIndicator(args(state))).toBeNull();
  });
});

describe('computeLandingIndicator — visibility', () => {
  it('shows nothing before the pointer has left the tap dead-zone', () => {
    expect(computeLandingIndicator(args(dragState({ hasMoved: false })))).toBeNull();
  });

  it('shows nothing while the cursor is outside every drop region', () => {
    expect(computeLandingIndicator(args(dragState({ dragOverLocation: null })))).toBeNull();
  });
});
