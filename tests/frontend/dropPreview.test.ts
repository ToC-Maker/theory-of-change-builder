// `computeDropPreview` says where the dragged node's copy sits while the
// pointer is over a column: snapped into the column, horizontally centred
// as the node will sit, at the height the drop will place it (the same
// `computeDropCenterY` formula `handleDrop` uses, so clamp included).
// Anywhere else (a gap between columns, outside every drop region, before
// the tap dead-zone is crossed) it returns null and the copy follows the
// cursor.
import { describe, it, expect } from 'vitest';
import { computeDropPreview } from '../../src/utils/dropPreview';
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

describe('computeDropPreview — over a column', () => {
  it('centres the copy on the column, at the height the drop will place the node', () => {
    // Cursor at column-local 300, grabbed 30px below the node top → top at
    // local 270, centre 308 → container y 100 + 270. Column centre is 150,
    // so a 192px copy starts at 54.
    expect(computeDropPreview(args(dragState()))).toEqual({
      sectionIndex: 0,
      columnIndex: 0,
      centerY: 308,
      copy: { left: 54, top: 370 },
    });
  });

  it('follows the cursor into another column', () => {
    const state = dragState({
      dragOverLocation: { kind: 'node-slot', sectionIndex: 0, columnIndex: 1, yPosition: 400 },
    });
    // Column 0-1 centre is 374 → 374 - 96; local top 370 → 100 + 370.
    expect(computeDropPreview(args(state))).toMatchObject({
      columnIndex: 1,
      copy: { left: 278, top: 470 },
    });
  });

  it('treats over-node like node-slot', () => {
    const over = dragState({
      dragOverLocation: { kind: 'over-node', sectionIndex: 0, columnIndex: 0, yPosition: 300 },
    });
    expect(computeDropPreview(args(over))).toEqual(computeDropPreview(args(dragState())));
  });

  it('divides the viewport-space grab offset by the zoom scale', () => {
    // At zoom 2 the 30px viewport offset spans 15 content px: top 285.
    expect(computeDropPreview(args(dragState(), 2))).toMatchObject({
      copy: { top: 100 + 285 },
    });
  });

  it('clamps below the section title exactly as the drop does', () => {
    const state = dragState({
      pointerOffset: { x: 40, y: 50 },
      dragOverLocation: { kind: 'node-slot', sectionIndex: 0, columnIndex: 1, yPosition: 10 },
    });
    // The node would poke above the column body, so its top pins to 0.
    expect(computeDropPreview(args(state))).toMatchObject({ centerY: 38, copy: { top: 100 } });
  });

  it('keeps a node wider than its column centred on the column', () => {
    // A 128px empty column takes a 192px node and widens around its centre.
    const narrow: LayoutSnapshot = {
      ...snapshot,
      columnRects: [[{ left: 100, right: 228, top: 100, bottom: 900 }]],
    };
    expect(computeDropPreview({ ...args(dragState()), snapshot: narrow })).toMatchObject({
      copy: { left: 164 - 96 },
    });
  });

  it('uses the rect of the section the cursor is over', () => {
    const state = dragState({
      dragOverLocation: { kind: 'node-slot', sectionIndex: 1, columnIndex: 0, yPosition: 500 },
    });
    expect(computeDropPreview(args(state))).toMatchObject({
      sectionIndex: 1,
      copy: { left: 622 - 96, top: 100 + 500 - 30 },
    });
  });

  it('returns null when the target column has no rect', () => {
    const state = dragState({
      dragOverLocation: { kind: 'node-slot', sectionIndex: 5, columnIndex: 0, yPosition: 300 },
    });
    expect(computeDropPreview(args(state))).toBeNull();
  });
});

describe('computeDropPreview — elsewhere the copy follows the cursor', () => {
  it('is null over the gap a new column would go into', () => {
    const state = dragState({
      dragOverLocation: { kind: 'new-column', sectionIndex: 0, columnIndex: 1 },
    });
    expect(computeDropPreview(args(state))).toBeNull();
  });

  it('is null for new-section, whose drop is ignored', () => {
    const state = dragState({ dragOverLocation: { kind: 'new-section', sectionIndex: 1 } });
    expect(computeDropPreview(args(state))).toBeNull();
  });

  it('is null while the cursor is outside every drop region', () => {
    expect(computeDropPreview(args(dragState({ dragOverLocation: null })))).toBeNull();
  });

  it('is null before the pointer has left the tap dead-zone', () => {
    expect(computeDropPreview(args(dragState({ hasMoved: false })))).toBeNull();
  });
});
