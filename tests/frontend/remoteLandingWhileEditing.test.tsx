// The failure this feature exists to prevent, end to end: a chart from another
// person arrives (a poll, or the answer to a stale save) while the local editor
// is in use, and nothing the user has typed, or has open, is lost or reverted.
//
// Everything is real except the network: the chart document, the save and poll
// hooks, the canvas and its node editor (with the real MDXEditor in the second
// half). `ChartService` is mocked so a test can land a chart or answer a save
// at the exact moment it wants.
//
// Titles are typed under fake timers so a landing can be placed 50 ms after
// the last key, inside the 200 ms before a keystroke is committed. The details
// editor needs real timers (its chunk loads asynchronously), so there a poll
// is held open by hand and answered inside that window.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { lexical } from '@mdxeditor/editor';
import { _resetCanvasGestureStateForTest } from '../../src/hooks/_canvasGestureState';
import { _resetSwallowNextClickGuardForTest } from '../../src/hooks/useDismissOnOutsideEvent';
import { useChartSave } from '../../src/hooks/useChartSave';
import { useChartSync } from '../../src/hooks/useChartSync';
import { ToC } from '../../src/components/TheoryOfChangeGraph';
import { ChartService } from '../../src/services/chartService';
import { ChartDocument } from '../../src/sync/ChartDocument';
import { prepareAIResult } from '../../src/sync/aiEdit';
import { applyEdits } from '../../src/utils/graphEdits';
import { normalizeChart, type ToCData } from '../../shared/chart-model';
import { edit, findNode, node, nodeIn, removeNode } from '../shared/chart-fixtures';
import { deepFreeze } from './helpers/deepFreeze';

vi.mock('../../src/services/chartService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/chartService')>();
  return { ...actual, ChartService: { updateChart: vi.fn(), pollChart: vi.fn() } };
});

vi.mock('../../src/services/loggingService', () => ({
  loggingService: { reportError: vi.fn(), getCurrentChartId: vi.fn(() => 'chart-1') },
}));

const mockUpdateChart = vi.mocked(ChartService.updateChart);
const mockPollChart = vi.mocked(ChartService.pollChart);

type SaveAnswer = Awaited<ReturnType<typeof ChartService.updateChart>>;

const CHART: ToCData = deepFreeze(
  normalizeChart({
    title: 'T',
    sections: [
      {
        id: 's1',
        title: 'One',
        columns: [
          {
            id: 'c1',
            nodes: [
              node('n1', 100, { title: 'Alpha', text: 'old details' }),
              node('n2', 300, { title: 'Beta' }),
            ],
          },
        ],
      },
    ],
  }),
);

const titleOf = (chart: ToCData, id: string) => findNode(chart, id)?.title;
const retitle = (chart: ToCData, id: string, title: string) =>
  deepFreeze(
    edit(chart, (draft) => {
      nodeIn(draft, id).title = title;
    }),
  );

function openDoc(chart: ToCData = CHART, server: { version: number } | null = { version: 1 }) {
  return new ChartDocument({
    chart,
    editToken: server ? 'tok' : null,
    server: server ? { version: server.version, chart } : null,
  });
}

/** The save and poll hooks and the canvas over one document, as App wires them. */
function Editor({ doc, polling = true }: { doc: ChartDocument; polling?: boolean }) {
  const dragRef = useRef(false);
  useChartSave({ doc });
  useChartSync({ doc, authTokenReady: polling, isDragInFlightRef: dragRef });
  return (
    <ToC
      store={doc}
      showEditButton
      onDragActiveChange={(active) => {
        dragRef.current = active;
      }}
    />
  );
}

const q = <T extends HTMLElement = HTMLElement>(selector: string) => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`expected an element for ${selector}`);
  return el;
};

const openNodeEditor = (id: string) => {
  fireEvent.click(q(`[data-tocb-node="${id}"]`));
  return q('.node-editor');
};
const titleInput = () => screen.getByLabelText('Node title') as HTMLInputElement;

/** What the save hook sent: the chart and base version of every `updateChart` call. */
const sent = () => mockUpdateChart.mock.calls.map(([, chart, base]) => ({ chart, base }));
const lastSent = () => sent().at(-1)!;

/** A server that acknowledges every save with the next version. */
function acknowledgeSaves() {
  mockUpdateChart.mockImplementation(async (_token, _chart, base) => ({
    status: 'saved',
    version: base + 1,
  }));
}

/** Polls that find nothing new. */
function quietPolls() {
  mockPollChart.mockImplementation(async (_token, known) => ({ version: known }));
}

/** A request the test answers by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// Testing Library settles after each user-event call, and in `waitFor`, with a
// timer it only advances when it sees a `jest` global, so under vitest's fake
// timers it would wait forever.
function installFakeTimers() {
  vi.useFakeTimers();
  (globalThis as { jest?: unknown }).jest = { advanceTimersByTime: vi.advanceTimersByTime };
}

beforeEach(() => {
  mockUpdateChart.mockReset();
  mockPollChart.mockReset();
  acknowledgeSaves();
  quietPolls();
});

afterEach(() => {
  cleanup();
  _resetCanvasGestureStateForTest();
  _resetSwallowNextClickGuardForTest();
  document.body.innerHTML = '';
  vi.useRealTimers();
  delete (globalThis as { jest?: unknown }).jest;
});

// Generous: on a loaded machine the first render alone can pass the 5 s default.
describe('typing a title while a remote chart lands', { timeout: 20_000 }, () => {
  // Poll at 2500 ms; the user's last key is at 2450 ms.
  const KEY_TIME = 2450;
  const POLL_TIME = 2500;

  beforeEach(installFakeTimers);

  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  /** Mounts the editor, opens n1 and types `abc` after its title, ending at KEY_TIME. */
  async function typeAbc(doc: ChartDocument) {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime, delay: null });
    render(<Editor doc={doc} />);
    await advance(KEY_TIME - 50);
    openNodeEditor('n1');
    const input = titleInput();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    await advance(50);
    await user.keyboard('abc');
    return input;
  }

  it('typing_survives_remote_change_to_another_node', async () => {
    const doc = openDoc();
    mockPollChart.mockResolvedValueOnce({ version: 2, chartData: retitle(CHART, 'n2', 'Beta!') });

    const input = await typeAbc(doc);
    expect(input.value).toBe('Alphaabc');

    // The poll answers 50 ms after the last key, before the idle commit.
    await advance(POLL_TIME - KEY_TIME);

    expect(mockPollChart).toHaveBeenCalledTimes(1);
    expect(doc.getStatus().serverVersion).toBe(2);
    expect(titleOf(doc.getCommitted(), 'n2')).toBe('Beta!');
    // The landing came while the typing was still a preview: nothing of it committed yet.
    expect(titleOf(doc.getCommitted(), 'n1')).toBe('Alpha');
    expect(titleOf(doc.getLive(), 'n1')).toBe('Alphaabc');
    // The input is the one the user is typing in, with their text, focus and caret.
    expect(titleInput()).toBe(input);
    expect(input.value).toBe('Alphaabc');
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(8);
    expect(input.selectionEnd).toBe(8);

    // The tail commits and saves together with the other person's change.
    await advance(200 + 300 + 50);
    expect(sent()).toHaveLength(1);
    expect(lastSent().base).toBe(2);
    expect(titleOf(lastSent().chart, 'n1')).toBe('Alphaabc');
    expect(titleOf(lastSent().chart, 'n2')).toBe('Beta!');
    expect(input.value).toBe('Alphaabc');
  });

  it('typing_survives_remote_delete_of_the_node', async () => {
    const doc = openDoc();
    mockPollChart.mockResolvedValueOnce({
      version: 2,
      chartData: deepFreeze(edit(CHART, (draft) => removeNode(draft, 'n1'))),
    });

    const input = await typeAbc(doc);
    await advance(POLL_TIME - KEY_TIME);

    // Someone deleted the node the user is typing into: it stays, with their text,
    // though the committed chart (the typing is still a preview) no longer has it.
    expect(findNode(doc.getCommitted(), 'n1')).toBeUndefined();
    expect(findNode(doc.getLive(), 'n1')?.title).toBe('Alphaabc');
    expect(titleInput()).toBe(input);
    expect(input.value).toBe('Alphaabc');
    expect(document.activeElement).toBe(input);

    await advance(200 + 300 + 50);
    expect(lastSent().base).toBe(2);
    expect(titleOf(lastSent().chart, 'n1')).toBe('Alphaabc');
  });

  it('conflict_during_typing_keeps_text', async () => {
    const doc = openDoc();
    const firstSave = deferred<SaveAnswer>();
    mockUpdateChart.mockReset();
    mockUpdateChart.mockImplementationOnce(() => firstSave.promise);
    acknowledgeSaves();
    render(<Editor doc={doc} />);
    await advance(100);
    openNodeEditor('n1');
    const input = titleInput();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);

    // A save is in flight on version 1.
    act(() => doc.edit((prev) => ({ ...prev, curvature: 0.8 })));
    await advance(300);
    expect(sent()).toHaveLength(1);
    expect(sent()[0].base).toBe(1);

    // The user keeps typing; the save then comes back as a conflict.
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime, delay: null });
    await user.keyboard('abc');
    await advance(50);
    expect(input.value).toBe('Alphaabc');
    await act(async () => {
      firstSave.resolve({
        status: 'conflict',
        theirs: { version: 3, chart: retitle(CHART, 'n2', 'Beta!') },
      });
      await Promise.resolve();
    });

    expect(input.value).toBe('Alphaabc');
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(8);
    expect(titleOf(doc.getCommitted(), 'n2')).toBe('Beta!');
    // The conflict came while the typing was still a preview.
    expect(titleOf(doc.getCommitted(), 'n1')).toBe('Alpha');

    await advance(200 + 300 + 50);
    const final = lastSent();
    expect(final.base).toBeGreaterThanOrEqual(3);
    expect(titleOf(final.chart, 'n1')).toBe('Alphaabc');
    expect(titleOf(final.chart, 'n2')).toBe('Beta!');
    expect(final.chart.curvature).toBe(0.8);
    expect(input.value).toBe('Alphaabc');
  });

  it('format_slider_tick_keeps_canvas_preview', async () => {
    const doc = openDoc();
    const input = await typeAbc(doc);

    // A Format-menu tick lands inside the title's idle window.
    await advance(100);
    act(() => doc.edit((prev) => ({ ...prev, textSize: 1.2 })));

    expect(titleOf(doc.getCommitted(), 'n1')).toBe('Alphaabc');
    expect(doc.getCommitted().textSize).toBe(1.2);
    expect(input.value).toBe('Alphaabc');

    await advance(200 + 300 + 50);
    expect(titleOf(lastSent().chart, 'n1')).toBe('Alphaabc');
    expect(lastSent().chart.textSize).toBe(1.2);
  });

  it('ai_reply_after_long_stream_keeps_concurrent_edits', async () => {
    const doc = openDoc();
    mockPollChart.mockResolvedValueOnce({
      version: 2,
      chartData: retitle(CHART, 'n2', 'Beta from someone else'),
    });
    render(<Editor doc={doc} />);

    // The message is sent against version 1; the reply streams for a while.
    const asSent = doc.getCommitted();
    await advance(2500);
    expect(titleOf(doc.getCommitted(), 'n2')).toBe('Beta from someone else');

    const reply = applyEdits(asSent, [
      { type: 'update', path: 'sections.0.columns.0.nodes.0.title', value: 'Alpha by AI' },
    ]);
    act(() => doc.applyRebased(asSent, prepareAIResult(asSent, reply)));

    expect(titleOf(doc.getCommitted(), 'n1')).toBe('Alpha by AI');
    expect(titleOf(doc.getCommitted(), 'n2')).toBe('Beta from someone else');
    expect(screen.getByText('Alpha by AI')).toBeTruthy();
    expect(screen.getByText('Beta from someone else')).toBeTruthy();

    await advance(300 + 50);
    expect(lastSent().base).toBe(2);
    expect(titleOf(lastSent().chart, 'n1')).toBe('Alpha by AI');
    expect(titleOf(lastSent().chart, 'n2')).toBe('Beta from someone else');
  });

  it('ai_reply_yields_on_a_field_someone_changed_during_the_stream', async () => {
    const doc = openDoc();
    mockPollChart.mockResolvedValueOnce({
      version: 2,
      chartData: retitle(CHART, 'n1', 'Alpha from someone else'),
    });
    render(<Editor doc={doc} />);

    const asSent = doc.getCommitted();
    await advance(2500);
    expect(titleOf(doc.getCommitted(), 'n1')).toBe('Alpha from someone else');

    const reply = applyEdits(asSent, [
      { type: 'update', path: 'sections.0.columns.0.nodes.0.title', value: 'Alpha by AI' },
      { type: 'update', path: 'sections.0.columns.0.nodes.1.title', value: 'Beta by AI' },
    ]);
    act(() => doc.applyRebased(asSent, prepareAIResult(asSent, reply)));

    expect(titleOf(doc.getCommitted(), 'n1')).toBe('Alpha from someone else');
    expect(titleOf(doc.getCommitted(), 'n2')).toBe('Beta by AI');
  });

  it('undo_after_remote_landing_reverts_only_mine', async () => {
    const doc = openDoc();
    render(<Editor doc={doc} />);
    await advance(100);

    act(() => doc.edit((prev) => ({ ...prev, curvature: 0.8 })));
    await advance(300 + 50);
    expect(lastSent().base).toBe(1);

    // Another person retitles n2 (version 3, after our save made version 2).
    mockPollChart.mockResolvedValueOnce({
      version: 3,
      chartData: deepFreeze({ ...retitle(CHART, 'n2', 'Beta!'), curvature: 0.8 }),
    });
    await advance(2500);
    expect(titleOf(doc.getCommitted(), 'n2')).toBe('Beta!');

    act(() => doc.undo());

    expect(doc.getCommitted().curvature).toBe(CHART.curvature);
    expect(titleOf(doc.getCommitted(), 'n2')).toBe('Beta!');
    await advance(300 + 50);
    expect(lastSent().base).toBe(3);
    expect(lastSent().chart.curvature).toBe(CHART.curvature);
    expect(titleOf(lastSent().chart, 'n2')).toBe('Beta!');
  });

  it('edits_during_create_save_with_created_version', async () => {
    // A chart on `/` has no server yet: the first message or a share creates
    // it, and the user keeps typing while that request is out.
    const doc = openDoc(CHART, null);
    const input = await typeAbc(doc);
    await advance(200 + 300 + 50);
    expect(sent()).toHaveLength(0);
    expect(input.value).toBe('Alphaabc');

    // createChart answers with version 1 and the chart that was sent (without the typing).
    act(() => doc.attachServer('tok', { version: 1, chart: CHART }));
    await advance(300 + 50);

    expect(sent()).toHaveLength(1);
    expect(lastSent().base).toBe(1);
    expect(titleOf(lastSent().chart, 'n1')).toBe('Alphaabc');
  });

  it('import_replaces_local_chart', async () => {
    const doc = openDoc();
    render(<Editor doc={doc} />);
    const imported = normalizeChart({
      title: 'Imported',
      sections: [
        {
          id: 's1',
          title: 'One',
          columns: [
            {
              id: 'c1',
              nodes: [
                node('n2', 300, { title: 'Beta' }),
                node('n9', 100, { title: 'From the file' }),
              ],
            },
          ],
        },
      ],
    });

    // The import happens 100 ms before the next poll and its save (300 ms
    // after it) has not gone out yet when a collaborator's chart arrives.
    await advance(2400);
    act(() => doc.replace(imported));
    expect(screen.getByText('From the file')).toBeTruthy();
    expect(screen.queryByText('Alpha')).toBeNull();
    expect(doc.getCommitted()).toEqual(imported);

    mockPollChart.mockResolvedValueOnce({
      version: 2,
      chartData: retitle(CHART, 'n2', 'Beta by collaborator'),
    });
    await advance(100);

    expect(sent()).toHaveLength(0);
    expect(titleOf(doc.getCommitted(), 'n2')).toBe('Beta by collaborator');
    expect(screen.getByText('From the file')).toBeTruthy();
    expect(screen.queryByText('Alpha')).toBeNull();

    await advance(300 + 50);
    expect(lastSent().base).toBe(2);
    expect(titleOf(lastSent().chart, 'n2')).toBe('Beta by collaborator');
    expect(titleOf(lastSent().chart, 'n9')).toBe('From the file');
    expect(findNode(lastSent().chart, 'n1')).toBeUndefined();
  });
});

// The details editor is the real MDXEditor, whose chunk loads asynchronously,
// so the editor is opened on real timers; the clock is then faked and polling
// started, so that a landing can be placed 50 ms after the last edit. jsdom has
// no layout, so Lexical needs a rect for the selection it scrolls into view.
describe('the details editor while a remote chart lands', () => {
  beforeEach(() => {
    Range.prototype.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      toJSON: () => ({}),
    });
  });

  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  async function openDetails(doc: ChartDocument) {
    const { rerender } = render(<Editor doc={doc} polling={false} />);
    const editor = openNodeEditor('n1');
    const content = await waitFor(
      () => {
        const el = editor.querySelector<HTMLElement>('[contenteditable="true"]');
        expect(el).not.toBeNull();
        return el!;
      },
      { timeout: 10000 },
    );
    // Opening reports the editor's normal form of the text; let that settle.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    installFakeTimers();
    rerender(<Editor doc={doc} polling />);
    return content;
  }

  /** Types into the real editor the way a keystroke reaches the app: an edit inside Lexical. */
  const typeInto = (content: HTMLElement, text: string) =>
    act(async () => {
      const editor = (content as unknown as { __lexicalEditor: lexical.LexicalEditor })
        .__lexicalEditor;
      editor.update(() => {
        const leaf = lexical
          .$getRoot()
          .getFirstChild<lexical.ElementNode>()!
          .getFirstChild<lexical.TextNode>()!;
        leaf.setTextContent(leaf.getTextContent() + text);
      });
      await Promise.resolve();
    });

  const undoButton = () => q<HTMLButtonElement>('button[aria-label^="Undo"]');

  it('landing_while_details_editor_focused', async () => {
    const doc = openDoc();
    const content = await openDetails(doc);
    act(() => content.focus());
    expect(document.activeElement).toBe(content);
    expect(content.textContent).toBe('old details');

    // Someone else rewrites this node's details.
    const theirs = deepFreeze(
      edit(CHART, (draft) => {
        nodeIn(draft, 'n1').text = 'details from a collaborator';
      }),
    );
    mockPollChart.mockResolvedValueOnce({ version: 2, chartData: theirs });
    await advance(2500 + 100);

    expect(content.textContent).toBe('details from a collaborator');
    // The same editor, still focused: nothing remounted.
    expect(q('.node-editor [contenteditable="true"]')).toBe(content);
    expect(document.activeElement).toBe(content);

    // Undo must not bring the old text back, by button or by keyboard.
    expect(undoButton().disabled).toBe(true);
    fireEvent.click(undoButton());
    fireEvent.keyDown(content, { key: 'z', ctrlKey: true });
    await advance(100);
    expect(content.textContent).toBe('details from a collaborator');
    expect(findNode(doc.getLive(), 'n1')?.text).toBe('details from a collaborator');

    // Nothing carries the old text to the server.
    await advance(1000);
    expect(mockUpdateChart).not.toHaveBeenCalled();
    expect(doc.getStatus().unsaved).toBe(false);
  }, 20000);

  it('typed_details_survive_a_landing_on_another_node', async () => {
    const doc = openDoc();
    const content = await openDetails(doc);
    act(() => content.focus());
    mockPollChart.mockResolvedValueOnce({ version: 2, chartData: retitle(CHART, 'n2', 'Beta!') });

    // The poll answers 50 ms after the last edit, before it is committed.
    await advance(2450);
    await typeInto(content, ' and more');
    expect(findNode(doc.getLive(), 'n1')?.text).toBe('old details and more');
    expect(doc.getCommitted()).toBe(CHART);
    await advance(50);

    expect(mockPollChart).toHaveBeenCalledTimes(1);
    expect(doc.getStatus().serverVersion).toBe(2);
    expect(titleOf(doc.getCommitted(), 'n2')).toBe('Beta!');
    // The landing came while the typing was still a preview.
    expect(findNode(doc.getCommitted(), 'n1')?.text).toBe('old details');
    expect(findNode(doc.getLive(), 'n1')?.text).toBe('old details and more');
    expect(content.textContent).toBe('old details and more');
    expect(document.activeElement).toBe(content);

    await advance(200 + 300 + 50);
    expect(sent()).toHaveLength(1);
    expect(lastSent().base).toBe(2);
    expect(findNode(lastSent().chart, 'n1')?.text).toBe('old details and more');
    expect(titleOf(lastSent().chart, 'n2')).toBe('Beta!');
  }, 20000);
});
