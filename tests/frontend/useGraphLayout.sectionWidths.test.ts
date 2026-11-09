// `computeSectionWidths`: how wide each section's columns make it.
//
// An empty column is as wide as a node added to it, so a new section does
// not widen when its first node lands. A column of nodes is as wide as its
// widest node and never narrower than the floor.
import { describe, it, expect } from 'vitest';
import { computeSectionWidths } from '../../src/hooks/useGraphLayout';
import type { ToCData } from '../../src/types';

const node = (id: string, width?: number) => ({
  id,
  title: id,
  text: '',
  connectionIds: [],
  connections: [],
  yPosition: 100,
  ...(width === undefined ? {} : { width }),
});

const widthsOf = (columns: ToCData['sections'][number]['columns'][]) =>
  computeSectionWidths(
    { title: 'T', sections: columns.map((cols) => ({ title: 'S', columns: cols })) },
    { columnPadding: 24 },
  );

describe('computeSectionWidths', () => {
  it('lays an empty column out as wide as a new node (192px)', () => {
    expect(widthsOf([[{ nodes: [] }]])).toEqual([192]);
  });

  it('adds the column gap between empty columns', () => {
    expect(widthsOf([[{ nodes: [] }, { nodes: [] }]])).toEqual([192 + 24 + 192]);
  });

  it('does not change when the first node is added to an empty column', () => {
    const [empty] = widthsOf([[{ nodes: [] }]]);
    const [withNode] = widthsOf([[{ nodes: [node('a', 192)] }]]);
    const [withDefaultNode] = widthsOf([[{ nodes: [node('a')] }]]);
    expect(withNode).toBe(empty);
    expect(withDefaultNode).toBe(empty);
  });

  it('makes a column as wide as its widest node', () => {
    expect(widthsOf([[{ nodes: [node('a', 160), node('b', 240)] }]])).toEqual([240]);
  });

  it('keeps nodes narrower than the 128px floor from shrinking their column', () => {
    expect(widthsOf([[{ nodes: [node('a', 100)] }]])).toEqual([128]);
  });

  it('gives a section without columns the width of one new node', () => {
    expect(widthsOf([[]])).toEqual([192]);
  });
});
