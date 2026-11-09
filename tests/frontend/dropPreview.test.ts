// `computeDropPreview` says where the dragged node's copy sits while the
// pointer is over a column: snapped into the column, horizontally where
// the node will sit, at the height the drop will place it (the same
// `computeDropCenterY` formula `handleDrop` uses, so clamp included).
// Columns are left-anchored and take the width of their widest node, so a
// node narrower than its column is centred in it and a wider one pushes
// the column's right edge out, leaving its left edge where it was.
// Anywhere else (a gap between columns, outside every drop region, before
// the tap dead-zone is crossed) it returns null and the copy follows the
// cursor.
//
// Over a column it also reports how the column's other nodes shift to make
// room (`computeMakeRoom`), and when they cannot all shift far enough the
// landing spot, and with it the copy, moves down.
import { describe, it, expect } from 'vitest';
import { computeDropPreview, type DropPreview } from '../../src/utils/dropPreview';
import type { DragState } from '../../src/hooks/usePointerDrag';
import type { LayoutSnapshot } from '../../src/hooks/useGraphLayout';
import type { Node, ToCData } from '../../src/types';

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

const node = (id: string, yPosition: number, width?: number): Node => ({
  id,
  title: id,
  text: '',
  connectionIds: [],
  connections: [],
  yPosition,
  width,
});

// The columns the snapshot describes, with the dragged node n-1 in 0-0.
const emptySections = (over: { '0-0'?: Node[]; '0-1'?: Node[] } = {}): ToCData['sections'] => [
  {
    title: 'S1',
    columns: [{ nodes: over['0-0'] ?? [node('n-1', 200)] }, { nodes: over['0-1'] ?? [] }],
  },
  { title: 'S2', columns: [{ nodes: [] }] },
];

// `shifted` is a Map keyed by node id; the assertions read it as a plain object.
const shiftedOf = (preview: DropPreview | null) => Object.fromEntries(preview!.shifted);

const args = (state: DragState, zoomScale = 1, sections = emptySections()) => ({
  dragState: state,
  snapshot,
  zoomScale,
  sections,
  nodeHeights: {} as Record<string, number>,
});

describe('computeDropPreview — over a column', () => {
  it('puts the copy where the dropped node will sit, at the height the drop uses', () => {
    // Cursor at column-local 300, grabbed 30px below the node top → top at
    // local 270, centre 308 → container y 100 + 270. A 192px node is as
    // wide as its column, so it starts at the column's left, 50.
    expect(computeDropPreview(args(dragState()))).toEqual({
      sectionIndex: 0,
      columnIndex: 0,
      centerY: 308,
      copy: { left: 50, top: 370 },
      shifted: new Map(),
    });
  });

  it('follows the cursor into another column', () => {
    const state = dragState({
      dragOverLocation: { kind: 'node-slot', sectionIndex: 0, columnIndex: 1, yPosition: 400 },
    });
    // Column 0-1 starts at 274; local top 370 → 100 + 370.
    expect(computeDropPreview(args(state))).toMatchObject({
      columnIndex: 1,
      copy: { left: 274, top: 470 },
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

  it('keeps a wider node at the column left: the column grows rightwards', () => {
    // The column's 128px node is narrower than the 192px one dropped in, so
    // the column becomes 192 wide with its left edge where it was.
    const state = dragState({
      dragOverLocation: { kind: 'node-slot', sectionIndex: 0, columnIndex: 1, yPosition: 300 },
    });
    const sections = emptySections({ '0-1': [node('narrow', 600, 128)] });
    expect(computeDropPreview(args(state, 1, sections))).toMatchObject({
      copy: { left: 274 },
    });
  });

  it('centres a node narrower than the column in it', () => {
    // The column is 320 wide (its widest node), the dropped node 192.
    const state = dragState({
      dragOverLocation: { kind: 'node-slot', sectionIndex: 0, columnIndex: 1, yPosition: 300 },
    });
    const sections = emptySections({ '0-1': [node('wide', 600, 320)] });
    expect(computeDropPreview(args(state, 1, sections))).toMatchObject({
      copy: { left: 274 + (320 - 192) / 2 },
    });
  });

  it('counts the dragged node in the width of the column it lands in', () => {
    // n-1 is the 320px node that sets 0-0's width; dropped back into its own
    // column it still does, so it sits at the column's left.
    const state = dragState({ nodeSize: { width: 320, height: 76 } });
    const sections = emptySections({ '0-0': [node('n-1', 200, 320), node('small', 600, 128)] });
    expect(computeDropPreview(args(state, 1, sections))).toMatchObject({ copy: { left: 50 } });
  });

  it('centres a node narrower than the 128px column minimum in it', () => {
    const state = dragState({ nodeSize: { width: 100, height: 76 } });
    expect(computeDropPreview(args(state))).toMatchObject({ copy: { left: 50 + 14 } });
  });

  it('uses the rect of the section the cursor is over', () => {
    const state = dragState({
      dragOverLocation: { kind: 'node-slot', sectionIndex: 1, columnIndex: 0, yPosition: 500 },
    });
    expect(computeDropPreview(args(state))).toMatchObject({
      sectionIndex: 1,
      copy: { left: 522, top: 100 + 500 - 30 },
    });
  });

  it('returns null when the target column has no rect', () => {
    const state = dragState({
      dragOverLocation: { kind: 'node-slot', sectionIndex: 5, columnIndex: 0, yPosition: 300 },
    });
    expect(computeDropPreview(args(state))).toBeNull();
  });
});

describe('computeDropPreview — making room', () => {
  // Cursor at column-local 320 grabbed 30px down → landing centre 328, box 290..366.
  const over = (columnIndex: number, sectionIndex = 0) =>
    dragState({
      dragOverLocation: { kind: 'node-slot', sectionIndex, columnIndex, yPosition: 320 },
    });

  it('reports the shifts of the nodes in the target column that the landing box crowds', () => {
    const sections = emptySections({ '0-1': [node('a', 300), node('b', 400), node('far', 700)] });
    const preview = computeDropPreview(args(over(1), 1, sections));
    // a (262..338) is above the landing centre → bottom 274 → centre 236;
    // b (362..438) is below → top 382 → centre 420; far is clear.
    expect(preview).toMatchObject({ centerY: 328 });
    expect(shiftedOf(preview)).toEqual({ a: 236, b: 420 });
  });

  it('leaves nodes of other columns alone', () => {
    const sections = emptySections({ '0-0': [node('n-1', 200), node('x', 330)] });
    expect(shiftedOf(computeDropPreview(args(over(1), 1, sections)))).toEqual({});
  });

  it("leaves the dragged node's own slot out when dragging within its column", () => {
    const sections = emptySections({ '0-0': [node('n-1', 330), node('e', 500)] });
    // n-1's old slot overlaps the landing box but is not an obstacle; e is clear.
    expect(shiftedOf(computeDropPreview(args(over(0), 1, sections)))).toEqual({});
  });

  it('moves the copy down with the landing spot when the nodes above cannot make room', () => {
    // Landing centre 128 (box 90..166); 'a' (12..88) would have to end at
    // bottom 74, top -2: past the column top. The landing drops by 2 to
    // centre 130, and 'a' settles at 0..76.
    const state = dragState({
      pointerOffset: { x: 40, y: 38 },
      dragOverLocation: { kind: 'node-slot', sectionIndex: 0, columnIndex: 1, yPosition: 128 },
    });
    const sections = emptySections({ '0-1': [node('a', 50)] });
    const preview = computeDropPreview(args(state, 1, sections));
    expect(preview).toMatchObject({ centerY: 130, copy: { top: 100 + 130 - 38 } });
    expect(shiftedOf(preview)).toEqual({ a: 38 });
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
