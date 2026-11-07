// ConnectionHandles: the drag-to-connect handles on a node's edges.
//
// Asserts:
//   - Stays mounted when `visible=false` (nodes that aren't hovered or
//     selected): the hover state that shows the handle renders a frame
//     after the pointer arrives, so a press that beats it must still land
//     on the handle instead of on the node or edge beneath. The dot is
//     only hidden visually.
//   - Renders two handle targets (left + right edge) carrying
//     `data-tocb-connection-handle="<nodeId>|<side>"` so test selectors
//     can pin them.
//   - Pointer-down on a handle dot invokes the binder returned by
//     `bindHandle(nodeId, side)`.
//   - Both handles carry `data-export-exclude`, so a PNG/PDF export of
//     the chart leaves out the dots that show while a node is hovered or
//     selected.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
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
  it('keeps both handles mounted but hidden when visible=false', () => {
    render(<ConnectionHandles nodeId="n-1" visible={false} bindHandle={makeBindHandle(vi.fn())} />);
    for (const side of ['left', 'right']) {
      const handle = document.querySelector(`[data-tocb-connection-handle="n-1|${side}"]`);
      expect(handle).not.toBeNull();
      expect(handle?.querySelector('[data-tocb-handle-dot]')?.className).toMatch(/\bopacity-0\b/);
    }
  });

  it('shows the dots when visible=true', () => {
    render(<ConnectionHandles nodeId="n-1" visible={true} bindHandle={makeBindHandle(vi.fn())} />);
    const dot = document.querySelector('[data-tocb-handle-dot]');
    expect(dot?.className).toMatch(/\bopacity-100\b/);
  });

  it('starts the gesture from a hidden handle (press before the hover render)', () => {
    const onPointerDown = vi.fn();
    render(
      <ConnectionHandles nodeId="n-1" visible={false} bindHandle={makeBindHandle(onPointerDown)} />,
    );
    const right = document.querySelector(
      '[data-tocb-connection-handle="n-1|right"]',
    ) as HTMLElement;
    fireEvent.pointerDown(right, { pointerId: 1 });
    expect(onPointerDown).toHaveBeenCalledTimes(1);
  });

  it('keeps both handles out of the accessibility tree', () => {
    // Pointer-only affordances that do nothing on activation: a screen
    // reader would list two dead buttons on every node.
    render(<ConnectionHandles nodeId="n-1" visible={true} bindHandle={makeBindHandle(vi.fn())} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getAllByRole('button', { hidden: true })).toHaveLength(2);
  });

  it('keeps hidden handles out of the keyboard tab order', () => {
    render(<ConnectionHandles nodeId="n-1" visible={false} bindHandle={makeBindHandle(vi.fn())} />);
    document.querySelectorAll('[data-tocb-connection-handle]').forEach((h) => {
      expect(h.getAttribute('tabindex')).toBe('-1');
    });
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

  it.each([true, false])(
    'marks both handles for exclusion from exports (visible=%s)',
    (visible) => {
      render(
        <ConnectionHandles nodeId="n-1" visible={visible} bindHandle={makeBindHandle(vi.fn())} />,
      );
      const handles = document.querySelectorAll('[data-tocb-connection-handle]');
      expect(handles).toHaveLength(2);
      handles.forEach((handle) => expect(handle.hasAttribute('data-export-exclude')).toBe(true));
    },
  );

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
