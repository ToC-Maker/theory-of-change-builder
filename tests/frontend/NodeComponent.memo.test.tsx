// Tests for `React.memo(NodeComponent)` with DEFAULT shallow equality.
//
// Acceptance (Important fix in plan §0.4):
//   - Identical props -> NodeComponent does NOT re-render.
//   - Prop change (e.g. selection state) -> re-renders.
//   - New inline callback prop -> re-renders (regression test that the
//     parent's `useCallback` wiring is load-bearing; without it the
//     memo is a no-op).
//
// We count renders via React.Profiler. When a memoized child bails out,
// React still calls `onRender` for the Profiler boundary itself, BUT
// `actualDuration` is essentially 0 because no inner work happened —
// `baseDuration` (the time it would take without memoization) stays
// constant. Bailed-out commits report `actualDuration < baseDuration`;
// real re-renders report `actualDuration >= baseDuration`.
//
// This DOES falsify: removing `memo(NodeComponentInner)` and exporting
// `NodeComponentInner` directly bumps `actualDuration` back up to the
// real-render value, and the "props identical" test fails.
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
  onDragStart: vi.fn(),
  onDragEnd: vi.fn(),
  editMode: true,
  textSize: 1,
  fontFamily: "'Ubuntu', sans-serif",
  setNodePopup: vi.fn(),
  isEditingTitle: false,
  setEditingNodeId: vi.fn(),
  updateNodeTitle: vi.fn(),
  ...overrides,
});

interface CommitRecord {
  phase: 'mount' | 'update' | 'nested-update';
  actualDuration: number;
  baseDuration: number;
}

// A "real" render is one where the Profiler's actualDuration is at
// least roughly equal to baseDuration (the no-memo cost). A "bailed"
// render reports actualDuration much smaller than baseDuration.
//
// We use 50% of baseDuration as the cutoff; in practice bailed-out
// renders are < 5% of baseDuration and real renders are > 80%.
function isRealRender(rec: CommitRecord): boolean {
  return rec.actualDuration >= rec.baseDuration * 0.5;
}

describe('React.memo(NodeComponent)', () => {
  it('does not re-render when props are referentially identical', () => {
    const records: CommitRecord[] = [];
    const onRender: ProfilerOnRenderCallback = (_id, phase, actualDuration, baseDuration) => {
      records.push({ phase, actualDuration, baseDuration });
    };
    const props = baseProps();
    const { rerender } = render(
      <Profiler id="node" onRender={onRender}>
        <NodeComponent {...props} />
      </Profiler>,
    );
    // Mount: one real render.
    expect(records.length).toBe(1);
    expect(records[0]!.phase).toBe('mount');
    expect(isRealRender(records[0]!)).toBe(true);

    // Re-render with the SAME props object. React.memo + default shallow
    // compare should bail out -> NodeComponent doesn't really render,
    // so actualDuration is near zero.
    rerender(
      <Profiler id="node" onRender={onRender}>
        <NodeComponent {...props} />
      </Profiler>,
    );
    expect(records.length).toBe(2);
    expect(records[1]!.phase).toBe('update');
    expect(isRealRender(records[1]!)).toBe(false);
  });

  it('re-renders when a primitive prop changes (selection)', () => {
    const records: CommitRecord[] = [];
    const onRender: ProfilerOnRenderCallback = (_id, phase, actualDuration, baseDuration) => {
      records.push({ phase, actualDuration, baseDuration });
    };
    const props = baseProps();
    const { rerender } = render(
      <Profiler id="node" onRender={onRender}>
        <NodeComponent {...props} />
      </Profiler>,
    );
    expect(records.length).toBe(1);
    expect(isRealRender(records[0]!)).toBe(true);

    rerender(
      <Profiler id="node" onRender={onRender}>
        <NodeComponent {...props} isHighlighted={true} />
      </Profiler>,
    );
    // Selection change -> real re-render.
    expect(records.length).toBe(2);
    expect(isRealRender(records[1]!)).toBe(true);
    // DOM reflects the new state.
    const node = document.getElementById('node-n-1');
    expect(node?.className).toMatch(/ring-2 ring-black/);
  });

  it('re-renders when an inline callback prop is passed (regression for missing useCallback)', () => {
    // If a parent passes `toggleHighlight={() => ...}` inline without
    // useCallback, the callback reference changes on each parent render,
    // breaking React.memo's bail-out. This test demonstrates the failure
    // mode that the `useCallback` audit in TheoryOfChangeGraph.tsx is
    // designed to prevent.
    const records: CommitRecord[] = [];
    const onRender: ProfilerOnRenderCallback = (_id, phase, actualDuration, baseDuration) => {
      records.push({ phase, actualDuration, baseDuration });
    };

    const { rerender } = render(
      <Profiler id="node" onRender={onRender}>
        <NodeComponent {...baseProps()} toggleHighlight={() => {}} />
      </Profiler>,
    );
    expect(records.length).toBe(1);
    expect(isRealRender(records[0]!)).toBe(true);

    // New inline callback -> new reference -> memo bail-out fails ->
    // real re-render.
    rerender(
      <Profiler id="node" onRender={onRender}>
        <NodeComponent {...baseProps()} toggleHighlight={() => {}} />
      </Profiler>,
    );
    expect(records.length).toBe(2);
    expect(isRealRender(records[1]!)).toBe(true);
  });
});
