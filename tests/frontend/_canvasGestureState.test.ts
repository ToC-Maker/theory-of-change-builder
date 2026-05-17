// Tests for the cross-PR canvas gesture mutex module.
//
// PR 4 ships `_canvasGestureState.ts` as the primitive PR 5
// (`useConnectionDrag`) and PR 7 (`useWaypointDrag`) lean on. The
// failure mode the test-analyzer flagged (and that motivates having
// this file at all): a future PR adds its own drag hook, forgets to
// clear the flag on cleanup, and node-drag silently stops working
// from then on with no console log to triage by. The reader-side
// contract is dead simple — three exports, one mutable boolean — but
// "simple" is exactly when regressions land unobserved.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  isCanvasGestureActive,
  setCanvasGestureActive,
  _resetCanvasGestureStateForTest,
} from '../../src/hooks/_canvasGestureState';

beforeEach(() => {
  _resetCanvasGestureStateForTest();
});

describe('_canvasGestureState', () => {
  it('starts in the inactive state', () => {
    expect(isCanvasGestureActive()).toBe(false);
  });

  it('setCanvasGestureActive(true) flips the flag to true', () => {
    setCanvasGestureActive(true);
    expect(isCanvasGestureActive()).toBe(true);
  });

  it('setCanvasGestureActive(false) flips the flag back to false', () => {
    setCanvasGestureActive(true);
    setCanvasGestureActive(false);
    expect(isCanvasGestureActive()).toBe(false);
  });

  it('is idempotent — setting true twice stays true', () => {
    setCanvasGestureActive(true);
    setCanvasGestureActive(true);
    expect(isCanvasGestureActive()).toBe(true);
  });

  it('_resetCanvasGestureStateForTest restores neutral state', () => {
    setCanvasGestureActive(true);
    _resetCanvasGestureStateForTest();
    expect(isCanvasGestureActive()).toBe(false);
  });

  it('survives multiple readers — get returns the same value', () => {
    // The point of a module singleton: every reader sees the same flag
    // without coordination. This pins the no-stateful-snapshot
    // contract PR 5/7 lean on.
    setCanvasGestureActive(true);
    const a = isCanvasGestureActive();
    const b = isCanvasGestureActive();
    const c = isCanvasGestureActive();
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(c).toBe(true);
  });
});
