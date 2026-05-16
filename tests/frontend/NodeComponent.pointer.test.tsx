// Tests for the PR 4 NodeComponent surface:
//
//   - Root carries `data-tocb-node="<id>"` (the new excludeFromPan
//     selector + the test hook for pointer-drag callsites).
//   - Root carries Tailwind's `touch-none` class so pointer events on
//     mobile don't get swallowed by browser scroll gestures.
//   - `onPointerDown` is bound to the root and fires when the prop is
//     wired through (pointer-drag binding).
//
// We do NOT exercise the full `usePointerDrag` hook here — that's
// covered by `usePointerDrag.test.ts`. The contract this test pins is
// the shape NodeComponent exposes to a caller.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { NodeComponent } from '../../src/components/NodeComponent';
import type { Node } from '../../src/types';

afterEach(() => {
  cleanup();
});

const baseNode: Node = {
  id: 'n-1',
  title: 'Title',
  text: 'Body',
  connectionIds: [],
  connections: [],
};

const baseProps = (overrides: Record<string, unknown> = {}) => ({
  node: baseNode,
  updateNodeRef: vi.fn(),
  isHighlighted: false,
  isConnected: false,
  isHovered: false,
  isDragging: false,
  toggleHighlight: vi.fn(),
  setHoveredNode: vi.fn(),
  hasHighlightedNodes: false,
  onPointerDown: vi.fn(),
  editMode: true,
  textSize: 1,
  fontFamily: "'Ubuntu', sans-serif",
  ...overrides,
});

describe('NodeComponent (PR 4 pointer surface)', () => {
  it('roots have `data-tocb-node` matching the node id', () => {
    const props = baseProps();
    render(<NodeComponent {...props} />);
    // The id-bearing root is `node-${id}`.
    const root = document.getElementById('node-n-1');
    expect(root).not.toBeNull();
    expect(root?.getAttribute('data-tocb-node')).toBe('n-1');
  });

  it('roots have the `touch-none` class so pointer events are not swallowed', () => {
    const props = baseProps();
    render(<NodeComponent {...props} />);
    const root = document.getElementById('node-n-1');
    expect(root?.className).toMatch(/(?:^|\s)touch-none(?:\s|$)/);
  });

  it('roots do not have the legacy `draggable` attribute', () => {
    // PR 4 dropped HTML5 DnD; the `draggable` attribute should be gone
    // (or at least not `"true"`) so the browser does not start its own
    // drag-image capture.
    const props = baseProps();
    render(<NodeComponent {...props} />);
    const root = document.getElementById('node-n-1');
    expect(root?.getAttribute('draggable')).not.toBe('true');
  });

  it('fires the bound onPointerDown on root pointerdown', () => {
    const onPointerDown = vi.fn();
    render(<NodeComponent {...baseProps({ onPointerDown })} />);
    const root = document.getElementById('node-n-1');
    expect(root).not.toBeNull();
    fireEvent.pointerDown(root!, { clientX: 50, clientY: 60 });
    expect(onPointerDown).toHaveBeenCalledTimes(1);
  });

  it('does not bind onPointerDown when editMode=false', () => {
    const onPointerDown = vi.fn();
    render(<NodeComponent {...baseProps({ onPointerDown, editMode: false })} />);
    const root = document.getElementById('node-n-1');
    fireEvent.pointerDown(root!, { clientX: 50, clientY: 60 });
    expect(onPointerDown).not.toHaveBeenCalled();
  });
});
