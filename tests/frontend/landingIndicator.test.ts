// `computeLandingIndicator` decides what the drag landing indicator
// draws, from the same inputs `handleDrop` uses to place the node:
//   - node-slot / over-node: a thin line across the target column at the
//     dropped node's TOP edge. `dragOverLocation.yPosition` is the
//     cursor's column-local Y, not a node centre, so the line goes
//     through `computeDropCenterY` (the single placement formula) and
//     then drops by half the node height — it must agree with where the
//     node renders after the drop (`top = centerY - height/2`).
//   - new-column: the gutter rect between the two neighbouring columns.
//   - new-section: nothing — `handleDrop` ignores that target, so a
//     "will land here" mark would promise a move that never happens.
//   - nothing at all until the drag has crossed the tap dead-zone.
import { describe, it, expect } from 'vitest';
import { computeLandingIndicator } from '../../src/utils/landingIndicator';
import { computeDropCenterY } from '../../src/utils/nodePosition';
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
  it('draws a line across the target column at the dropped node top edge', () => {
    // Cursor at column-local 300, grabbed 30px below the node top → the
    // node's top lands at local 270, i.e. 100 + 270 in container space.
    const ind = computeLandingIndicator(args(dragState()));
    expect(ind).toEqual({ kind: 'line', left: 50, width: 200, top: 370 });
  });

  it('is the node top edge, not its centre (yPosition is the centre)', () => {
    const state = dragState();
    const ind = computeLandingIndicator(args(state));
    const centerY = computeDropCenterY({
      cursorColumnLocalY: 300,
      pointerOffsetY: 30,
      zoomScale: 1,
      nodeHeight: 76,
    });
    expect(ind).toMatchObject({ kind: 'line', top: 100 + centerY - 76 / 2 });
  });

  it('divides the viewport-space grab offset by the zoom scale', () => {
    // At zoom 2 the 30px viewport offset spans 15 content px.
    const ind = computeLandingIndicator(args(dragState(), 2));
    expect(ind).toMatchObject({ kind: 'line', top: 100 + (300 - 15) });
  });

  it('clamps below the section title exactly as the drop does', () => {
    // Cursor near the column top, grabbed mid-node: the node would poke
    // above the column body, so the drop (and the line) pin to its top.
    const state = dragState({
      pointerOffset: { x: 40, y: 50 },
      dragOverLocation: { kind: 'node-slot', sectionIndex: 0, columnIndex: 1, yPosition: 10 },
    });
    expect(computeLandingIndicator(args(state))).toEqual({
      kind: 'line',
      left: 274,
      width: 200,
      top: 100,
    });
  });

  it('treats over-node like node-slot (the node lands where released, overlapping)', () => {
    const over = dragState({
      dragOverLocation: { kind: 'over-node', sectionIndex: 0, columnIndex: 0, yPosition: 300 },
    });
    expect(computeLandingIndicator(args(over))).toEqual(computeLandingIndicator(args(dragState())));
  });

  it('uses the rect of the section the cursor is over', () => {
    const state = dragState({
      dragOverLocation: { kind: 'node-slot', sectionIndex: 1, columnIndex: 0, yPosition: 500 },
    });
    expect(computeLandingIndicator(args(state))).toEqual({
      kind: 'line',
      left: 522,
      width: 200,
      top: 100 + 500 - 30 + 0,
    });
  });

  it('spans the width the column will have once a wider node lands in it', () => {
    // A 128px-wide column (empty columns are that wide) takes a 192px node
    // and widens around its centre.
    const narrow: LayoutSnapshot = {
      ...snapshot,
      columnRects: [[{ left: 100, right: 228, top: 100, bottom: 900 }]],
    };
    const ind = computeLandingIndicator({ ...args(dragState()), snapshot: narrow });
    expect(ind).toEqual({ kind: 'line', left: 68, width: 192, top: 370 });
  });

  it('returns null when the target column has no rect', () => {
    const state = dragState({
      dragOverLocation: { kind: 'node-slot', sectionIndex: 5, columnIndex: 0, yPosition: 300 },
    });
    expect(computeLandingIndicator(args(state))).toBeNull();
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
