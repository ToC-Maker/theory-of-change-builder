// `useDismissOnOutsideEvent` swallow-next-click guard (PR #34 fb7
// issue 77).
//
// The hook dismisses on document MOUSEDOWN; canvas add-affordances fire
// on CLICK (and node-create on DBLCLICK). mousedown and click are
// separate events of the same physical gesture, so before the guard, a
// single click outside an editor both dismissed it AND fired whatever
// affordance the press landed on (gutter → surprise column). The guard:
// when the hook dismisses due to an outside press, the same gesture's
// click and dblclick are consumed at document capture phase — "first
// click closes only; a second click performs canvas actions".
//
// Mechanics under test:
//   - swallow of the follow-up click (and dblclick) at the press point
//   - one-shot: the SECOND click passes through
//   - position sanity: a click far from the press is not eaten
//   - timeout: the guard disarms after ~500ms
//   - Escape dismissal arms nothing (no press, nothing to swallow)
//   - `allowClickThroughOnDismiss` lets switch-targets pass (node /
//     connection clicks must still select in one gesture)
//   - `shouldSkipDismiss` bypass (Cmd/Ctrl multi-select) arms nothing
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import React, { useRef, useState } from 'react';
import {
  useDismissOnOutsideEvent,
  _resetSwallowNextClickGuardForTest,
} from '../../src/hooks/useDismissOnOutsideEvent';

function HookHost(props: {
  onDismiss: () => void;
  allowClickThroughOnDismiss?: (event: MouseEvent) => boolean;
  shouldSkipDismiss?: (event: MouseEvent) => boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  useDismissOnOutsideEvent({
    containerRef,
    onDismiss: props.onDismiss,
    allowClickThroughOnDismiss: props.allowClickThroughOnDismiss,
    shouldSkipDismiss: props.shouldSkipDismiss,
  });
  return <div ref={containerRef}>editor</div>;
}

/**
 * Renders the hook host plus an outside button carrying React onClick +
 * onDoubleClick spies — the stand-in for a canvas affordance.
 *
 * The host UNMOUNTS on dismiss, mirroring NodeEditor/EdgeEditor (whose
 * `onRequestClose` clears the selection that gates their render). This
 * is load-bearing for the physical double-click test: in the real app
 * the first click's dismiss tears the editor (and so the hook's
 * mousedown listener) down, so the gesture's SECOND mousedown can't
 * re-arm the guard. A harness that left the host mounted would re-arm on
 * that second press and wrongly swallow the second click.
 */
function setup(hostProps?: Partial<React.ComponentProps<typeof HookHost>>) {
  const onDismiss = vi.fn();
  const onOutsideClick = vi.fn();
  const onOutsideDblClick = vi.fn();

  function Harness() {
    const [open, setOpen] = useState(true);
    return (
      <>
        {open && (
          <HookHost
            onDismiss={() => {
              onDismiss();
              setOpen(false);
            }}
            allowClickThroughOnDismiss={hostProps?.allowClickThroughOnDismiss}
            shouldSkipDismiss={hostProps?.shouldSkipDismiss}
          />
        )}
        <button
          type="button"
          data-testid="outside-affordance"
          onClick={onOutsideClick}
          onDoubleClick={onOutsideDblClick}
        >
          affordance
        </button>
      </>
    );
  }

  render(<Harness />);
  const affordance = document.querySelector('[data-testid="outside-affordance"]') as HTMLElement;
  return { onDismiss, onOutsideClick, onOutsideDblClick, affordance };
}

const at = (x: number, y: number) => ({ clientX: x, clientY: y });

afterEach(() => {
  cleanup();
  _resetSwallowNextClickGuardForTest();
  vi.useRealTimers();
});

describe('useDismissOnOutsideEvent swallow-next-click guard', () => {
  it('dismisses on outside mousedown and swallows the same gesture click', () => {
    const { onDismiss, onOutsideClick, affordance } = setup();

    fireEvent.mouseDown(affordance, at(50, 50));
    expect(onDismiss).toHaveBeenCalledTimes(1);

    fireEvent.click(affordance, at(50, 50));
    expect(onOutsideClick).not.toHaveBeenCalled();
  });

  it('swallows the dblclick of the dismissing gesture (double-click-to-create)', () => {
    const { onDismiss, onOutsideClick, onOutsideDblClick, affordance } = setup();

    // Full physical double-click starting while the editor is open:
    //   down(1) → dismiss → host unmounts → arm guard
    //   click(1) → swallowed (one-shot click listener)
    //   down(2) → host gone, nothing re-arms
    //   click(2) → passes (the click listener was spent on click(1))
    //   dblclick → swallowed (one-shot dblclick listener still armed)
    // Net: the editor closes, the gesture never reaches the node-create
    // path, and a deliberate later click would still act.
    fireEvent.mouseDown(affordance, at(50, 50));
    fireEvent.mouseUp(affordance, at(50, 50));
    fireEvent.click(affordance, at(50, 50));
    fireEvent.mouseDown(affordance, at(50, 50));
    fireEvent.mouseUp(affordance, at(50, 50));
    fireEvent.click(affordance, at(50, 50));
    fireEvent.dblClick(affordance, at(50, 50));

    expect(onDismiss).toHaveBeenCalledTimes(1); // only the first press dismisses
    expect(onOutsideDblClick).not.toHaveBeenCalled();
    // The second single click of the pair still passes through.
    expect(onOutsideClick).toHaveBeenCalledTimes(1);
  });

  it('is one-shot: the second click passes through and performs the action', () => {
    const { onOutsideClick, affordance } = setup();

    fireEvent.mouseDown(affordance, at(50, 50)); // dismiss + arm; host unmounts
    fireEvent.click(affordance, at(50, 50)); // swallowed
    expect(onOutsideClick).not.toHaveBeenCalled();

    // Second click, same spot. The host has unmounted (dismiss cleared
    // it), so no new guard is armed; the original guard's click listener
    // was spent on the first click. This click performs the action.
    fireEvent.click(affordance, at(50, 50));
    expect(onOutsideClick).toHaveBeenCalledTimes(1);
  });

  it('does not swallow a click far from the press point (unrelated click)', () => {
    const { onOutsideClick, affordance } = setup();

    fireEvent.mouseDown(affordance, at(50, 50));
    // e.g. the press started a drag/pan; the trailing click lands far
    // away — must not be eaten.
    fireEvent.click(affordance, at(400, 400));
    expect(onOutsideClick).toHaveBeenCalledTimes(1);
  });

  it('disarms after the safety timeout', () => {
    vi.useFakeTimers();
    const { onOutsideClick, affordance } = setup();

    fireEvent.mouseDown(affordance, at(50, 50));
    vi.advanceTimersByTime(600);

    fireEvent.click(affordance, at(50, 50));
    expect(onOutsideClick).toHaveBeenCalledTimes(1);
  });

  it('does not arm the guard on Escape dismissal', () => {
    const { onDismiss, onOutsideClick, affordance } = setup();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledTimes(1);

    fireEvent.click(affordance, at(50, 50));
    expect(onOutsideClick).toHaveBeenCalledTimes(1);
  });

  it('lets the click through when allowClickThroughOnDismiss matches the press', () => {
    const { onDismiss, onOutsideClick, affordance } = setup({
      allowClickThroughOnDismiss: (event) =>
        (event.target as Element | null)?.closest('[data-testid="outside-affordance"]') != null,
    });

    fireEvent.mouseDown(affordance, at(50, 50));
    expect(onDismiss).toHaveBeenCalledTimes(1); // still dismisses…

    fireEvent.click(affordance, at(50, 50));
    expect(onOutsideClick).toHaveBeenCalledTimes(1); // …but the click acts
  });

  it('arms nothing when shouldSkipDismiss bypasses the dismissal (multi-select path)', () => {
    const { onDismiss, onOutsideClick, affordance } = setup({
      shouldSkipDismiss: (event) => event.metaKey,
    });

    fireEvent.mouseDown(affordance, { ...at(50, 50), metaKey: true });
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.click(affordance, { ...at(50, 50), metaKey: true });
    expect(onOutsideClick).toHaveBeenCalledTimes(1);
  });
});
