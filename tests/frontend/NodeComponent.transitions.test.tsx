// PR #34 feedback (47): "width and color changes to nodes should not be
// animated."
//
// The node root carried `transition-all duration-500`, so the inline
// `width` (NodeEditor width slider) and `backgroundColor` (color
// picker) styles animated: live-dragging the slider visibly lagged
// behind the cursor. The transition must enumerate the hover/drag
// affordance properties (box-shadow for hover shadow + selection ring,
// transform for hover:scale, opacity for drag/dim states) instead of
// `all`, so width and color apply instantly.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
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
  width: 240,
  color: '#ff0000',
};

function renderNodeRoot(): HTMLElement {
  render(
    <NodeComponent
      node={baseNode}
      updateNodeRef={() => {}}
      isHighlighted={false}
      isConnected={false}
      isHovered={false}
      isDragging={false}
      toggleHighlight={() => {}}
      setHoveredNode={() => {}}
      hasHighlightedNodes={false}
      editMode={true}
      textSize={1}
      fontFamily="'Ubuntu', sans-serif"
    />,
  );
  const el = document.getElementById('node-n-1');
  if (!el) throw new Error('node not rendered');
  return el;
}

describe('NodeComponent transitions (PR #34 fb 47)', () => {
  it('does not transition `all` (width/background must apply instantly)', () => {
    const el = renderNodeRoot();
    expect(el.className).not.toMatch(/\btransition-all\b/);
  });

  it('keeps the hover/drag affordance transition (shadow, transform, opacity)', () => {
    const el = renderNodeRoot();
    expect(el.className).toContain('transition-[box-shadow,transform,opacity]');
  });
});
