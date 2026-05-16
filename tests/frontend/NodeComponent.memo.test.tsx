// Tests for `React.memo(NodeComponent)` with DEFAULT shallow equality.
//
// Acceptance (Important fix in plan §0.4):
//   - Identical props -> NodeComponent does NOT re-render.
//   - Prop change (e.g. selection state) -> re-renders.
//   - New inline callback prop -> re-renders (regression test that the
//     parent's `useCallback` wiring is load-bearing; without it the
//     memo is a no-op).
//
// We use React.Profiler's `actualDuration` vs `baseDuration` ratio.
// Bailed-out commits report actualDuration as a small fraction of
// baseDuration (typically < 0.15). Real renders sit at or above 1.0.
// The 0.3 threshold leaves headroom for CPU-loaded test runners while
// still falsifying when `memo(NodeComponentInner)` is removed (the
// ratio shifts above 1.0 for the "identical props" case).
import { Profiler } from 'react';
import type { ComponentProps, ProfilerOnRenderCallback } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
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

// Render-count spy: the mount-only `updateNodeRef` callback. We verify
// the memo bail-out by re-rendering the parent with the same props
// reference and checking `updateNodeRef` is called at most once.
//
// PR 3: dropped `setNodePopup`, `isEditingTitle`, `setEditingNodeId`,
// and `updateNodeTitle` from the prop shape — those concerns moved to
// the anchored `<NodeEditor>`.
// PR 4: dropped `onDragStart` and `onDragEnd` (HTML5 DnD retired);
// added `onPointerDown` for `usePointerDrag` to bind to.
const baseProps = (
  overrides: Partial<ComponentProps<typeof NodeComponent>> = {},
): ComponentProps<typeof NodeComponent> => ({
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

interface CommitRecord {
  phase: 'mount' | 'update' | 'nested-update';
  actualDuration: number;
  baseDuration: number;
}

function isRealRender(rec: CommitRecord): boolean {
  return rec.actualDuration >= rec.baseDuration * 0.3;
}

function renderProfiled(props: ComponentProps<typeof NodeComponent>) {
  const records: CommitRecord[] = [];
  const onRender: ProfilerOnRenderCallback = (_id, phase, actualDuration, baseDuration) => {
    records.push({ phase, actualDuration, baseDuration });
  };
  const utils = render(
    <Profiler id="node" onRender={onRender}>
      <NodeComponent {...props} />
    </Profiler>,
  );
  const rerenderWithProps = (next: ComponentProps<typeof NodeComponent>) =>
    utils.rerender(
      <Profiler id="node" onRender={onRender}>
        <NodeComponent {...next} />
      </Profiler>,
    );
  return { records, rerenderWithProps };
}

describe('React.memo(NodeComponent)', () => {
  it('does not re-render when props are referentially identical', () => {
    const props = baseProps();
    const { records, rerenderWithProps } = renderProfiled(props);

    expect(records.length).toBe(1);
    expect(records[0]!.phase).toBe('mount');

    rerenderWithProps(props);
    expect(records.length).toBe(2);
    expect(records[1]!.phase).toBe('update');
    expect(isRealRender(records[1]!)).toBe(false);
  });

  it('re-renders when a primitive prop changes (selection)', () => {
    const props = baseProps();
    const { records, rerenderWithProps } = renderProfiled(props);
    expect(records.length).toBe(1);

    rerenderWithProps({ ...props, isHighlighted: true });
    expect(records.length).toBe(2);
    expect(isRealRender(records[1]!)).toBe(true);
    const node = document.getElementById('node-n-1');
    expect(node?.className).toMatch(/ring-2 ring-black/);
  });

  it('re-renders when an inline callback prop is passed (regression for missing useCallback)', () => {
    // If a parent passes `toggleHighlight={() => ...}` inline without
    // useCallback, the callback reference changes on each parent render,
    // breaking React.memo's bail-out. This test demonstrates the failure
    // mode that the `useCallback` audit in TheoryOfChangeGraph.tsx is
    // designed to prevent.
    const { records, rerenderWithProps } = renderProfiled({
      ...baseProps(),
      toggleHighlight: () => {},
    });
    expect(records.length).toBe(1);

    rerenderWithProps({ ...baseProps(), toggleHighlight: () => {} });
    expect(records.length).toBe(2);
    expect(isRealRender(records[1]!)).toBe(true);
  });
});
