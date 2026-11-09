// A keyboard arrow on an editor slider (node width, edge confidence) buffers
// through `mutateDebounced`: the change is previewed in the chart document at
// once and committed when its 200 ms idle timer fires. Undo is allowed while
// such a control has focus, so an undo can arrive inside that window.
//
// `doc.undo()` commits a pending preview before it reverses anything, so the
// slider change joins the history: as part of the preceding step when it
// follows within the document's grouping window (300 ms), as a step of its own
// otherwise. The idle timer then fires with nothing left to commit. It must not
// re-apply the slider value over the undone chart, clear the redo stack or add
// an empty undo step.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useGraphMutation } from '../../src/hooks/useGraphMutation';
import type { ChartInput } from '../../src/types';
import { makeDoc } from './helpers/renderToC';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const makeData = (): ChartInput => ({ title: 'start', curvature: 0.5, sections: [] });

// Longer than the document's 300 ms grouping window.
const OUTSIDE_GROUPING_WINDOW_MS = 1000;

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

// A document with one committed edit, the step the user will undo.
async function setupWithEdit() {
  const testDoc = makeDoc(makeData());
  const start = testDoc.doc.getCommitted();
  const { result } = renderHook(() => useGraphMutation(testDoc.doc));
  act(() => {
    result.current.mutate((prev) => ({ ...prev, title: 'edited' }));
  });
  await advance(0);
  expect(testDoc.doc.getCommitted().title).toBe('edited');
  return { ...testDoc, result, start };
}

const slide = (result: Awaited<ReturnType<typeof setupWithEdit>>['result'], curvature: number) => {
  act(() => {
    result.current.mutateDebounced((prev) => ({ ...prev, curvature }), 'curvature');
  });
};

describe('undo shortly after an editor control change', () => {
  it('undoes the edit together with the pending slider change and keeps it redoable', async () => {
    const { doc, result, start } = await setupWithEdit();

    slide(result, 0.6);
    await advance(50);
    // The slider change is previewed, not committed.
    expect(doc.getLive().curvature).toBe(0.6);
    expect(doc.getCommitted().curvature).toBe(0.5);

    act(() => doc.undo());
    expect(doc.getCommitted()).toEqual(start);
    expect(result.current.data).toEqual(start);
    const undone = doc.getCommitted();
    const commits = doc.getCommitCount();

    await advance(1000);

    // The idle commit found nothing to commit.
    expect(doc.getCommitCount()).toBe(commits);
    expect(doc.getCommitted()).toBe(undone);
    expect(result.current.data).toEqual(start);
    expect(doc.getStatus()).toMatchObject({ canUndo: false, canRedo: true });

    act(() => doc.redo());
    expect(doc.getCommitted()).toMatchObject({ title: 'edited', curvature: 0.6 });
    expect(result.current.data).toMatchObject({ title: 'edited', curvature: 0.6 });
    expect(doc.getStatus()).toMatchObject({ canUndo: true, canRedo: false });
  });

  it('undoes a slider change outside the grouping window on its own, and the idle commit does not bring it back', async () => {
    const { doc, result, start } = await setupWithEdit();
    await advance(OUTSIDE_GROUPING_WINDOW_MS);

    slide(result, 0.6);
    await advance(50);
    act(() => doc.undo());

    // Only the slider change is undone; the edit before it stays.
    expect(doc.getCommitted()).toMatchObject({ title: 'edited', curvature: 0.5 });
    expect(doc.getStatus()).toMatchObject({ canUndo: true, canRedo: true });
    const undone = doc.getCommitted();
    const commits = doc.getCommitCount();

    await advance(1000);

    // The idle timer would have written 0.6 over the undone chart.
    expect(doc.getCommitCount()).toBe(commits);
    expect(doc.getCommitted()).toBe(undone);
    expect(result.current.data).toMatchObject({ title: 'edited', curvature: 0.5 });
    expect(doc.getStatus()).toMatchObject({ canUndo: true, canRedo: true });

    // No empty step sits between the two real ones: one more undo reaches the start.
    act(() => doc.undo());
    expect(doc.getCommitted()).toEqual(start);
    expect(doc.getStatus()).toMatchObject({ canUndo: false, canRedo: true });

    act(() => doc.redo());
    act(() => doc.redo());
    expect(doc.getCommitted()).toMatchObject({ title: 'edited', curvature: 0.6 });
    expect(doc.getStatus()).toMatchObject({ canUndo: true, canRedo: false });
  });

  it('still commits a slider change made after the undo', async () => {
    const { doc, result, start } = await setupWithEdit();

    slide(result, 0.6);
    act(() => doc.undo());
    slide(result, 0.8);
    await advance(1000);

    expect(doc.getCommitted()).toMatchObject({ title: 'start', curvature: 0.8 });
    expect(result.current.data).toMatchObject({ title: 'start', curvature: 0.8 });
    // A new commit ends the redo history and is itself undoable.
    expect(doc.getStatus()).toMatchObject({ canUndo: true, canRedo: false });

    act(() => doc.undo());
    expect(doc.getCommitted()).toEqual(start);
    expect(doc.getStatus().canUndo).toBe(false);
  });
});
