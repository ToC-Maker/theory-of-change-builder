// PR 5 Task 5.2 regression test for ConnectionHandles.
//
// Asserts:
//   - Renders nothing when `visible=false` (default state for nodes that
//     aren't hovered or selected).
//   - Renders two handle dots when `visible=true` (left + right edge),
//     each carrying `data-tocb-connection-handle="<nodeId>|<side>"` so
//     test selectors can pin them.
//   - Pointer-down on a handle dot invokes the binder returned by
//     `bindHandle(nodeId, side)`.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { ConnectionHandles } from '../../src/components/canvas/ConnectionHandles';
import type { HandleSide } from '../../src/hooks/useConnectionDrag';

afterEach(() => {
  cleanup();
});

const makeBindHandle =
  (onPointerDown: (e: React.PointerEvent) => void) =>
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  (_nodeId: string, _side: HandleSide) => ({ onPointerDown });

describe('ConnectionHandles', () => {
  it('renders nothing when visible=false', () => {
    const { container } = render(
      <ConnectionHandles nodeId="n-1" visible={false} bindHandle={makeBindHandle(vi.fn())} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders two handle dots (left + right) when visible=true', () => {
    render(<ConnectionHandles nodeId="n-1" visible={true} bindHandle={makeBindHandle(vi.fn())} />);
    const left = document.querySelector('[data-tocb-connection-handle="n-1|left"]');
    const right = document.querySelector('[data-tocb-connection-handle="n-1|right"]');
    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
  });

  it('passes pointerdown through to bindHandle(...).onPointerDown', () => {
    const onPointerDown = vi.fn();
    render(
      <ConnectionHandles nodeId="n-1" visible={true} bindHandle={makeBindHandle(onPointerDown)} />,
    );
    const left = document.querySelector('[data-tocb-connection-handle="n-1|left"]') as HTMLElement;
    fireEvent.pointerDown(left, { pointerId: 1 });
    expect(onPointerDown).toHaveBeenCalledTimes(1);
  });

  it('handle clicks do not bubble (so node click-to-select is not triggered)', () => {
    const innerClick = vi.fn();
    render(
      <button type="button" onClick={innerClick}>
        <ConnectionHandles nodeId="n-1" visible={true} bindHandle={makeBindHandle(vi.fn())} />
      </button>,
    );
    const right = document.querySelector(
      '[data-tocb-connection-handle="n-1|right"]',
    ) as HTMLElement;
    fireEvent.click(right);
    expect(innerClick).not.toHaveBeenCalled();
  });

  it('exposes left and right as distinct sides', () => {
    const calls: Array<{ id: string; side: HandleSide }> = [];
    const trackingBindHandle = (id: string, side: HandleSide) => {
      calls.push({ id, side });
      return { onPointerDown: vi.fn() };
    };
    render(<ConnectionHandles nodeId="n-7" visible={true} bindHandle={trackingBindHandle} />);
    expect(calls).toEqual([
      { id: 'n-7', side: 'left' },
      { id: 'n-7', side: 'right' },
    ]);
  });
});
