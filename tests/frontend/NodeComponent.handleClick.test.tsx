// Regression tests for `NodeComponent.handleClick` modifier-key dispatch.
//
// Plan §3.4 / `plans/figma-redesign.md:219` calls out the three branches
// as load-bearing, preserved verbatim across the PR 3 refactor:
//
//   - Cmd/Ctrl+click  → toggleHighlight(id, 'multi')
//   - Shift+click in editMode → toggleHighlight(id, 'column')
//   - Plain click (or any other combo) → toggleHighlight(id, 'single')
//
// PR 4's pointer-drag refactor will edit this file next; without
// regression coverage a trivial inversion (`||` ↔ `&&`, swapped tags)
// would ship green. These tests pin the dispatch so that doesn't happen.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { NodeComponent } from '../../src/components/NodeComponent';
import type { Node } from '../../src/types';

afterEach(() => {
  cleanup();
});

const baseNode: Node = {
  id: 'n-1',
  title: 'Title',
  text: '',
  connectionIds: [],
  connections: [],
};

function renderNode(overrides: Partial<{ editMode: boolean }> = {}) {
  const toggleHighlight = vi.fn();
  render(
    <NodeComponent
      node={baseNode}
      updateNodeRef={() => {}}
      isHighlighted={false}
      isConnected={false}
      isHovered={false}
      isDragging={false}
      toggleHighlight={toggleHighlight}
      setHoveredNode={() => {}}
      hasHighlightedNodes={false}
      onDragStart={() => {}}
      onDragEnd={() => {}}
      editMode={overrides.editMode ?? true}
      textSize={1}
      fontFamily="'Ubuntu', sans-serif"
    />,
  );
  const el = document.getElementById('node-n-1');
  if (!el) throw new Error('node not rendered');
  return { el, toggleHighlight };
}

describe('NodeComponent.handleClick — modifier-key selection mode', () => {
  it("Cmd+click dispatches 'multi'", () => {
    const { el, toggleHighlight } = renderNode();
    fireEvent.click(el, { metaKey: true });
    expect(toggleHighlight).toHaveBeenCalledTimes(1);
    expect(toggleHighlight).toHaveBeenCalledWith('n-1', 'multi');
  });

  it("Ctrl+click dispatches 'multi'", () => {
    const { el, toggleHighlight } = renderNode();
    fireEvent.click(el, { ctrlKey: true });
    expect(toggleHighlight).toHaveBeenCalledTimes(1);
    expect(toggleHighlight).toHaveBeenCalledWith('n-1', 'multi');
  });

  it("Shift+click in editMode dispatches 'column'", () => {
    const { el, toggleHighlight } = renderNode({ editMode: true });
    fireEvent.click(el, { shiftKey: true });
    expect(toggleHighlight).toHaveBeenCalledTimes(1);
    expect(toggleHighlight).toHaveBeenCalledWith('n-1', 'column');
  });

  it("Shift+click outside editMode dispatches 'single' (editMode guard is load-bearing)", () => {
    const { el, toggleHighlight } = renderNode({ editMode: false });
    fireEvent.click(el, { shiftKey: true });
    expect(toggleHighlight).toHaveBeenCalledTimes(1);
    expect(toggleHighlight).toHaveBeenCalledWith('n-1', 'single');
  });

  it("plain click dispatches 'single'", () => {
    const { el, toggleHighlight } = renderNode();
    fireEvent.click(el);
    expect(toggleHighlight).toHaveBeenCalledTimes(1);
    expect(toggleHighlight).toHaveBeenCalledWith('n-1', 'single');
  });

  it("Cmd+Shift+click — meta wins over shift (dispatches 'multi')", () => {
    // Order in handleClick: meta/ctrl check comes first, so meta wins.
    const { el, toggleHighlight } = renderNode({ editMode: true });
    fireEvent.click(el, { metaKey: true, shiftKey: true });
    expect(toggleHighlight).toHaveBeenCalledWith('n-1', 'multi');
  });
});
