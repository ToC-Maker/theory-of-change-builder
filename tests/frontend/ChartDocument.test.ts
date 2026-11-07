// The client's synchronous chart store, driven the way the save and poll hooks and the canvas
// drive it: previews and commits, remote landings, save acknowledgements, undo and redo.
// Charts are the shared fixtures (a, b | c in section s1; d in s2), frozen so that any
// in-place write by the document throws, and the clock is injected so the 300 ms undo
// grouping is deterministic.
import { describe, expect, it, vi } from 'vitest';
import { ChartDocument, staticStore, type ServerState } from '../../src/sync/ChartDocument';
import type { ToCData } from '../../src/types';
import {
  columnIn,
  connectedChart,
  connectionOf,
  edit,
  findNode,
  hasNode,
  node,
  nodeIn,
  removeColumn,
  removeNode,
  seedChart,
} from '../shared/chart-fixtures';
import { deepFreeze } from './helpers/deepFreeze';

const TERMINAL_MESSAGE = 'The saved chart went back to an older version. Reload to continue.';

const seed = () => deepFreeze(seedChart());

/** A frozen copy of `chart` with `change` applied. */
const change = (chart: ToCData, mutate: (draft: ToCData) => void) =>
  deepFreeze(edit(chart, mutate));

const retitle = (chart: ToCData, id: string, title: string) =>
  change(chart, (d) => {
    nodeIn(d, id).title = title;
  });

const recolor = (chart: ToCData, id: string, color: string) =>
  change(chart, (d) => {
    nodeIn(d, id).color = color;
  });

const titleOf = (chart: ToCData, id: string) => findNode(chart, id)?.title;
const colorOf = (chart: ToCData, id: string) => findNode(chart, id)?.color;

/** A chart `mergeCharts` refuses. Built by hand: `edit` normalises, which would rename the repeated id. */
function chartWithRepeatedSectionId(): ToCData {
  const chart = structuredClone(seed());
  chart.sections[1].id = chart.sections[0].id;
  return deepFreeze(chart);
}

/** A document on server version `version` holding `chart`, with a clock the test advances. */
function openDoc(version = 1, chart: ToCData = seed()) {
  const clock = { now: 0 };
  const doc = new ChartDocument({
    chart,
    editToken: 'tok',
    server: { version, chart },
    now: () => clock.now,
  });
  return { doc, clock, chart };
}

/** A save that goes out and is acknowledged at `version`. */
function saveAt(doc: ChartDocument, version: number) {
  expect(doc.takeSave()).not.toBeNull();
  doc.saveSucceeded(version);
}

describe('ChartDocument previews and commits', () => {
  it('preview_survives_remote_landing', () => {
    const { doc } = openDoc();
    doc.preview((c) => retitle(c, 'a', 'Alphaabc'));

    doc.receiveRemote({ version: 2, chart: retitle(seed(), 'b', 'Remote B') });

    expect(titleOf(doc.getLive(), 'a')).toBe('Alphaabc');
    expect(titleOf(doc.getLive(), 'b')).toBe('Remote B');
    expect(titleOf(doc.getCommitted(), 'a')).toBe('A');
    expect(titleOf(doc.getCommitted(), 'b')).toBe('Remote B');
  });

  it('same_field_preview_beats_remote', () => {
    const { doc } = openDoc();
    doc.preview((c) => retitle(c, 'a', 'mine'));

    doc.receiveRemote({ version: 2, chart: retitle(seed(), 'a', 'theirs') });
    expect(titleOf(doc.getLive(), 'a')).toBe('mine');
    expect(titleOf(doc.getCommitted(), 'a')).toBe('theirs');

    doc.commit();
    expect(titleOf(doc.getCommitted(), 'a')).toBe('mine');
  });

  it('content_preview_keeps_remotely_deleted_node', () => {
    const { doc } = openDoc();
    doc.preview((c) =>
      change(c, (d) => {
        nodeIn(d, 'a').text = 'typed after the delete';
      }),
    );

    doc.receiveRemote({ version: 2, chart: change(seed(), (d) => removeNode(d, 'a')) });

    expect(findNode(doc.getLive(), 'a')?.text).toBe('typed after the delete');
    expect(hasNode(doc.getCommitted(), 'a')).toBe(false);
  });

  it('restyle_preview_loses_to_remote_delete', () => {
    const { doc } = openDoc();
    doc.preview((c) =>
      change(c, (d) => {
        nodeIn(d, 'a').width = 300;
      }),
    );

    doc.receiveRemote({ version: 2, chart: change(seed(), (d) => removeNode(d, 'a')) });

    expect(hasNode(doc.getLive(), 'a')).toBe(false);
  });

  it('preview_accepts_a_chart_value_as_well_as_an_updater', () => {
    const { doc } = openDoc();
    doc.preview(retitle(seed(), 'a', 'by value'));
    expect(titleOf(doc.getLive(), 'a')).toBe('by value');
    expect(titleOf(doc.getCommitted(), 'a')).toBe('A');
  });

  it('commit_promotes_live_and_counts', () => {
    const { doc } = openDoc();
    expect(doc.getCommitCount()).toBe(0);

    doc.preview((c) => retitle(c, 'a', 'X'));
    doc.commit();

    expect(doc.getCommitted()).toBe(doc.getLive());
    expect(titleOf(doc.getCommitted(), 'a')).toBe('X');
    expect(doc.getCommitCount()).toBe(1);
  });

  it('empty_commit_is_noop_and_clears_unsaved', () => {
    const { doc } = openDoc();
    doc.commit();
    expect(doc.getCommitCount()).toBe(0);
    expect(doc.getStatus().canUndo).toBe(false);

    doc.preview((c) => retitle(c, 'a', 'X'));
    doc.preview((c) => retitle(c, 'a', 'A'));
    doc.commit();

    expect(doc.getCommitCount()).toBe(0);
    expect(doc.getStatus().unsaved).toBe(false);
    expect(doc.getStatus().canUndo).toBe(false);
  });

  it('cancelled_preview_leaves_nothing_unsaved', () => {
    const { doc, chart } = openDoc();
    doc.preview((c) => retitle(c, 'a', 'X'));
    expect(doc.getStatus().unsaved).toBe(true);

    doc.preview((c) => retitle(c, 'a', 'A'));

    expect(doc.getStatus().unsaved).toBe(false);
    expect(doc.getLive()).toBe(doc.getCommitted());
    expect(doc.getCommitted()).toBe(chart);
  });

  it('edit_previews_and_commits_in_one_step', () => {
    const { doc } = openDoc();
    doc.edit((c) => recolor(c, 'a', '#f00'));
    expect(colorOf(doc.getCommitted(), 'a')).toBe('#f00');
    expect(doc.getCommitted()).toBe(doc.getLive());
    expect(doc.getCommitCount()).toBe(1);
  });
});

describe('ChartDocument undo and redo', () => {
  it('commits_within_300ms_group_into_one_undo', () => {
    const { doc, clock } = openDoc();
    for (const [at, title] of [
      [0, 'x1'],
      [100, 'x2'],
      [250, 'x3'],
    ] as const) {
      clock.now = at;
      doc.edit((c) => retitle(c, 'a', title));
    }
    clock.now = 700;
    doc.edit((c) => retitle(c, 'b', 'later'));

    doc.undo();
    expect(titleOf(doc.getCommitted(), 'b')).toBe('B');
    expect(titleOf(doc.getCommitted(), 'a')).toBe('x3');

    doc.undo();
    expect(titleOf(doc.getCommitted(), 'a')).toBe('A');
    expect(doc.getStatus().canUndo).toBe(false);
  });

  it('landing_closes_the_group', () => {
    const { doc, clock } = openDoc();
    doc.edit((c) => retitle(c, 'a', 'first'));
    clock.now = 100;
    doc.receiveRemote({ version: 2, chart: retitle(seed(), 'b', 'Remote B') });
    clock.now = 200;
    doc.edit((c) => recolor(c, 'a', '#f00'));

    doc.undo();
    expect(colorOf(doc.getCommitted(), 'a')).toBe('#fff');
    expect(titleOf(doc.getCommitted(), 'a')).toBe('first');

    doc.undo();
    expect(titleOf(doc.getCommitted(), 'a')).toBe('A');
    expect(titleOf(doc.getCommitted(), 'b')).toBe('Remote B');
    expect(doc.getStatus().canUndo).toBe(false);
  });

  it('the_grouping_window_slides_with_each_commit', () => {
    const { doc, clock } = openDoc();
    for (const [at, title] of [
      [0, 'x1'],
      [200, 'x2'],
      [400, 'x3'],
    ] as const) {
      clock.now = at;
      doc.edit((c) => retitle(c, 'a', title));
    }

    doc.undo();

    expect(titleOf(doc.getCommitted(), 'a')).toBe('A');
    expect(doc.getStatus().canUndo).toBe(false);
  });

  describe('a foreign change closes the open group', () => {
    // Each case: edit a.title at t=0, a foreign change at t=100, edit b.title at t=150. The
    // last edit is within 300 ms of the first, but must be an undo step of its own.
    const editAfter = (foreign: (doc: ChartDocument) => void) => {
      const { doc, clock } = openDoc();
      doc.edit((c) => retitle(c, 'a', 'X'));
      clock.now = 100;
      foreign(doc);
      clock.now = 150;
      doc.edit((c) => retitle(c, 'b', 'Y'));
      doc.undo();
      return doc;
    };

    it('undo', () => {
      const doc = editAfter((d) => d.undo());
      expect(titleOf(doc.getCommitted(), 'b')).toBe('B');
    });

    it('replace', () => {
      const doc = editAfter((d) => d.replace(retitle(seed(), 'd', 'Imported')));
      expect(titleOf(doc.getCommitted(), 'b')).toBe('B');
      expect(titleOf(doc.getCommitted(), 'd')).toBe('Imported');
    });

    it('applyRebased', () => {
      const doc = editAfter((d) =>
        d.applyRebased(d.getCommitted(), retitle(d.getCommitted(), 'd', 'AI')),
      );
      expect(titleOf(doc.getCommitted(), 'b')).toBe('B');
      expect(titleOf(doc.getCommitted(), 'd')).toBe('AI');
    });
  });

  it('undo_reverts_only_own_fields', () => {
    const { doc } = openDoc();
    doc.edit((c) => recolor(c, 'a', '#f00'));
    doc.receiveRemote({ version: 2, chart: retitle(seed(), 'b', 'Remote B') });

    doc.undo();

    expect(colorOf(doc.getCommitted(), 'a')).toBe('#fff');
    expect(titleOf(doc.getCommitted(), 'b')).toBe('Remote B');
  });

  it('undo_yields_to_later_same_field_change', () => {
    const { doc } = openDoc();
    doc.edit((c) => recolor(c, 'a', '#f00'));
    saveAt(doc, 2);
    // Someone else recolours the same node after my change reached the server.
    doc.receiveRemote({ version: 3, chart: recolor(doc.getCommitted(), 'a', '#00f') });

    doc.undo();

    expect(colorOf(doc.getCommitted(), 'a')).toBe('#00f');
  });

  it('undo_reverts_my_value_when_the_other_change_was_concurrent', () => {
    const { doc } = openDoc();
    doc.edit((c) => recolor(c, 'a', '#f00'));
    // Their recolour was made without seeing mine: mine lands last and wins, so it is mine to undo.
    doc.receiveRemote({ version: 2, chart: recolor(seed(), 'a', '#00f') });
    expect(colorOf(doc.getCommitted(), 'a')).toBe('#f00');

    doc.undo();

    expect(colorOf(doc.getCommitted(), 'a')).toBe('#fff');
  });

  it('undo_never_resurrects_node_they_deleted', () => {
    const { doc } = openDoc();
    doc.edit((c) => retitle(c, 'a', 'retitled'));
    saveAt(doc, 2);
    doc.receiveRemote({
      version: 3,
      chart: change(doc.getCommitted(), (d) => removeNode(d, 'a')),
    });
    expect(hasNode(doc.getCommitted(), 'a')).toBe(false);

    doc.undo();

    expect(hasNode(doc.getCommitted(), 'a')).toBe(false);
  });

  describe('a node someone else edited is not deleted by my undo, redo or AI edit', () => {
    const withText = (chart: ToCData, id: string, text: string) =>
      change(chart, (d) => {
        nodeIn(d, id).text = text;
      });

    it('undo of the node I added', () => {
      const { doc } = openDoc();
      doc.edit((c) => change(c, (d) => columnIn(d, 'c1').nodes.push(node('z'))));
      saveAt(doc, 2);
      doc.receiveRemote({ version: 3, chart: withText(doc.getCommitted(), 'z', 'their text') });

      doc.undo();

      expect(findNode(doc.getCommitted(), 'z')?.text).toBe('their text');
    });

    it('redo of the node I deleted', () => {
      const { doc } = openDoc();
      doc.edit((c) => change(c, (d) => removeNode(d, 'd')));
      doc.undo();
      doc.receiveRemote({ version: 2, chart: withText(seed(), 'd', 'their text') });

      doc.redo();

      expect(findNode(doc.getCommitted(), 'd')?.text).toBe('their text');
    });

    it('an AI edit that deletes the node', () => {
      const { doc } = openDoc();
      const asSent = doc.getCommitted();
      doc.receiveRemote({ version: 2, chart: withText(asSent, 'a', 'their text') });

      doc.applyRebased(
        asSent,
        change(asSent, (d) => removeNode(d, 'a')),
      );

      expect(findNode(doc.getCommitted(), 'a')?.text).toBe('their text');
    });
  });

  it('undo_commits_pending_preview_first', () => {
    const { doc, clock } = openDoc();
    doc.edit((c) => recolor(c, 'a', '#f00'));
    clock.now = 1000;
    doc.preview((c) => retitle(c, 'a', 'typed'));

    doc.undo();

    expect(titleOf(doc.getCommitted(), 'a')).toBe('A');
    expect(colorOf(doc.getCommitted(), 'a')).toBe('#f00');
    expect(doc.getLive()).toBe(doc.getCommitted());
  });

  it('undo_with_nothing_to_undo_is_a_noop', () => {
    const { doc, chart } = openDoc();
    doc.undo();
    doc.redo();
    expect(doc.getCommitted()).toBe(chart);
    expect(doc.getCommitCount()).toBe(0);
  });

  it('redo_mirrors_undo', () => {
    const { doc } = openDoc();
    doc.edit((c) => retitle(c, 'a', 'X'));

    doc.undo();
    expect(titleOf(doc.getCommitted(), 'a')).toBe('A');
    expect(doc.getStatus()).toMatchObject({ canUndo: false, canRedo: true });

    doc.receiveRemote({ version: 2, chart: retitle(doc.getCommitted(), 'b', 'Remote B') });
    doc.redo();

    expect(titleOf(doc.getCommitted(), 'a')).toBe('X');
    expect(titleOf(doc.getCommitted(), 'b')).toBe('Remote B');
    expect(doc.getStatus()).toMatchObject({ canUndo: true, canRedo: false });
  });

  it('redo_yields_to_later_same_field_change', () => {
    const { doc } = openDoc();
    doc.edit((c) => recolor(c, 'a', '#f00'));
    doc.undo();
    doc.receiveRemote({ version: 2, chart: recolor(seed(), 'a', '#00f') });

    doc.redo();

    expect(colorOf(doc.getCommitted(), 'a')).toBe('#00f');
  });

  it('redo_replays_in_the_order_undone', () => {
    const { doc, clock } = openDoc();
    doc.edit((c) => retitle(c, 'a', 'X'));
    clock.now = 1000;
    doc.edit((c) => retitle(c, 'b', 'Y'));
    doc.undo();
    doc.undo();

    doc.redo();

    expect(titleOf(doc.getCommitted(), 'a')).toBe('X');
    expect(titleOf(doc.getCommitted(), 'b')).toBe('B');
  });

  it('a_remote_landing_does_not_clear_redo', () => {
    const { doc } = openDoc();
    doc.edit((c) => retitle(c, 'a', 'X'));
    doc.undo();

    doc.receiveRemote({ version: 2, chart: retitle(doc.getCommitted(), 'b', 'Remote B') });

    expect(doc.getStatus().canRedo).toBe(true);
  });

  it('redo_commits_a_pending_preview_first_which_leaves_nothing_to_redo', () => {
    const { doc } = openDoc();
    doc.edit((c) => retitle(c, 'a', 'X'));
    doc.undo();
    doc.preview((c) => retitle(c, 'b', 'typed'));

    doc.redo();

    expect(titleOf(doc.getCommitted(), 'b')).toBe('typed');
    expect(titleOf(doc.getCommitted(), 'a')).toBe('A');
    expect(doc.getStatus().canRedo).toBe(false);
  });

  it('a_new_edit_clears_redo', () => {
    const { doc } = openDoc();
    doc.edit((c) => retitle(c, 'a', 'X'));
    doc.undo();
    doc.edit((c) => recolor(c, 'b', '#0f0'));
    expect(doc.getStatus().canRedo).toBe(false);
  });

  it('every_undo_and_redo_counts_as_a_commit', () => {
    const { doc } = openDoc();
    doc.edit((c) => retitle(c, 'a', 'X'));
    expect(doc.getCommitCount()).toBe(1);
    doc.undo();
    expect(doc.getCommitCount()).toBe(2);
    doc.redo();
    expect(doc.getCommitCount()).toBe(3);
  });

  it('canUndo_is_true_while_only_a_preview_is_pending', () => {
    const { doc } = openDoc();
    expect(doc.getStatus().canUndo).toBe(false);
    doc.preview((c) => retitle(c, 'a', 'typing'));
    expect(doc.getStatus().canUndo).toBe(true);
  });
});

describe('ChartDocument AI edits and replacement', () => {
  it('applyRebased_merges_against_current', () => {
    const { doc, clock } = openDoc();
    doc.edit((c) => recolor(c, 'c', '#abc'));
    doc.undo(); // leaves a redo entry for the AI edit to clear
    expect(doc.getStatus().canRedo).toBe(true);
    clock.now = 1000;
    const asSent = doc.getCommitted();
    doc.receiveRemote({ version: 2, chart: retitle(asSent, 'b', 'Remote B') });

    doc.applyRebased(asSent, retitle(asSent, 'a', 'AI title'));

    expect(titleOf(doc.getCommitted(), 'a')).toBe('AI title');
    expect(titleOf(doc.getCommitted(), 'b')).toBe('Remote B');
    expect(doc.getStatus().canRedo).toBe(false);
    expect(doc.getCommitCount()).toBe(3); // the edit, its undo, the AI edit

    doc.undo();
    expect(titleOf(doc.getCommitted(), 'a')).toBe('A');
    expect(titleOf(doc.getCommitted(), 'b')).toBe('Remote B');
    expect(doc.getStatus().canUndo).toBe(false);
  });

  it('applyRebased_noop_creates_no_entry', () => {
    const { doc } = openDoc();
    const asSent = doc.getCommitted();

    doc.applyRebased(asSent, asSent);

    expect(doc.getStatus().canUndo).toBe(false);
    expect(doc.getCommitCount()).toBe(0);
    expect(doc.getCommitted()).toBe(asSent);
  });

  it('applyRebased_commits_a_pending_preview_first', () => {
    const { doc } = openDoc();
    const asSent = doc.getCommitted();
    doc.preview((c) => retitle(c, 'b', 'typed'));

    doc.applyRebased(asSent, recolor(asSent, 'a', '#f00'));

    expect(titleOf(doc.getCommitted(), 'b')).toBe('typed');
    expect(colorOf(doc.getCommitted(), 'a')).toBe('#f00');
  });

  it('replace_sets_local_chart_exactly', () => {
    const { doc, chart } = openDoc();
    const imported = change(seed(), (d) => {
      nodeIn(d, 'a').title = 'Imported';
      removeNode(d, 'd');
    });

    doc.replace(imported);

    expect(doc.getCommitted()).toBe(imported);
    expect(doc.getLive()).toBe(imported);
    expect(doc.getStatus()).toMatchObject({ canUndo: true, canRedo: false });

    doc.undo();
    expect(doc.getCommitted()).toEqual(chart);
    expect(doc.getStatus().canUndo).toBe(false);
  });

  describe('replace_then_remote_then_undo_keeps_collaborator', () => {
    const imported = () =>
      change(seed(), (d) => {
        nodeIn(d, 'a').title = 'Imported';
        removeNode(d, 'd');
      });

    it('undoing the import brings back the chart the collaborator edited, not the old one', () => {
      const { doc } = openDoc();
      doc.replace(imported());
      doc.receiveRemote({ version: 9, chart: retitle(seed(), 'b', 'T title') });

      doc.undo();

      expect(titleOf(doc.getCommitted(), 'b')).toBe('T title');
      expect(titleOf(doc.getCommitted(), 'a')).toBe('A');
      expect(hasNode(doc.getCommitted(), 'd')).toBe(true);
      // That is exactly what the server holds, so there is nothing to send.
      expect(doc.takeSave()).toBeNull();
    });

    it('and what is sent next still carries the collaborator title', () => {
      const { doc, clock } = openDoc();
      doc.edit((c) => recolor(c, 'c', '#abc'));
      clock.now = 1000;
      doc.replace(imported());
      doc.receiveRemote({ version: 9, chart: retitle(seed(), 'b', 'T title') });

      doc.undo();
      const sent = doc.takeSave();

      expect(sent?.baseVersion).toBe(9);
      expect(titleOf(sent!.chart, 'b')).toBe('T title');
      expect(colorOf(sent!.chart, 'c')).toBe('#abc');
    });
  });

  it('replace_commits_a_pending_preview_first', () => {
    const { doc } = openDoc();
    doc.preview((c) => retitle(c, 'a', 'typed before the import'));

    doc.replace(retitle(seed(), 'd', 'Imported'));
    doc.undo();

    expect(titleOf(doc.getCommitted(), 'a')).toBe('typed before the import');
    expect(titleOf(doc.getCommitted(), 'd')).toBe('D');
  });

  it('replace_clears_redo', () => {
    const { doc } = openDoc();
    doc.edit((c) => retitle(c, 'a', 'X'));
    doc.undo();
    expect(doc.getStatus().canRedo).toBe(true);

    doc.replace(retitle(seed(), 'd', 'Imported'));

    expect(doc.getStatus().canRedo).toBe(false);
  });

  it('replace_on_unsaved_new_chart_counts_as_unsaved', () => {
    const doc = new ChartDocument({ chart: seed(), editToken: null, server: null });
    expect(doc.getStatus().unsaved).toBe(false);

    doc.replace(retitle(seed(), 'a', 'Imported'));

    expect(doc.getStatus().unsaved).toBe(true);
  });
});

describe('ChartDocument saving', () => {
  it('takeSave_sends_committed_with_base_version', () => {
    const { doc } = openDoc(3);
    doc.edit((c) => retitle(c, 'a', 'X'));

    const first = doc.takeSave();
    expect(first).toEqual({ editToken: 'tok', baseVersion: 3, chart: doc.getCommitted() });
    expect(first!.chart).toBe(doc.getCommitted());
    expect(doc.getStatus().saving).toBe(true);

    expect(doc.takeSave()).toBeNull();
  });

  it('takeSave_sends_the_committed_chart_not_the_pending_preview', () => {
    const { doc } = openDoc(3);
    doc.edit((c) => retitle(c, 'a', 'committed'));
    doc.preview((c) => retitle(c, 'a', 'still typing'));

    const save = doc.takeSave();

    expect(titleOf(save!.chart, 'a')).toBe('committed');
    expect(titleOf(doc.getLive(), 'a')).toBe('still typing');
  });

  it('takeSave_sends_nothing_without_changes_a_server_or_a_token', () => {
    const { doc } = openDoc();
    expect(doc.takeSave()).toBeNull();

    const noServer = new ChartDocument({ chart: seed(), editToken: null, server: null });
    noServer.edit((c) => retitle(c, 'a', 'X'));
    expect(noServer.takeSave()).toBeNull();

    const noToken = new ChartDocument({
      chart: seed(),
      editToken: null,
      server: { version: 1, chart: seed() },
    });
    noToken.edit((c) => retitle(c, 'a', 'X'));
    expect(noToken.takeSave()).toBeNull();
  });

  it('takeSave_with_content_equal_to_server_sends_nothing', () => {
    const { doc } = openDoc();
    doc.edit((c) => retitle(c, 'a', 'X'));
    doc.edit((c) => retitle(c, 'a', 'A'));
    expect(doc.getStatus().unsaved).toBe(true);

    expect(doc.takeSave()).toBeNull();

    expect(doc.getStatus()).toMatchObject({ unsaved: false, saving: false });
  });

  it('save_success_advances_base', () => {
    const { doc } = openDoc(3);
    doc.edit((c) => retitle(c, 'a', 'X'));
    doc.takeSave();

    doc.saveSucceeded(4);

    expect(doc.getStatus()).toMatchObject({ serverVersion: 4, unsaved: false, saving: false });
    expect(doc.takeSave()).toBeNull();
  });

  it('a_save_in_flight_keeps_the_document_unsaved_even_if_undo_returns_to_the_server_chart', () => {
    const { doc, chart } = openDoc(3);
    doc.edit((c) => retitle(c, 'a', 'X'));
    doc.takeSave();

    doc.undo();

    expect(doc.getCommitted()).toBe(chart);
    expect(doc.getStatus()).toMatchObject({ saving: true, unsaved: true });
  });

  it('an_edit_made_during_a_save_goes_out_on_the_acknowledged_version', () => {
    const { doc } = openDoc(3);
    doc.edit((c) => retitle(c, 'a', 'X'));
    doc.takeSave();
    doc.edit((c) => retitle(c, 'b', 'Y'));

    doc.saveSucceeded(4);

    expect(doc.getStatus().unsaved).toBe(true);
    const next = doc.takeSave();
    expect(next?.baseVersion).toBe(4);
    expect(titleOf(next!.chart, 'a')).toBe('X');
    expect(titleOf(next!.chart, 'b')).toBe('Y');
  });

  it('an_identical_write_acknowledged_at_the_same_version_is_saved', () => {
    const { doc } = openDoc(3);
    doc.edit((c) => retitle(c, 'a', 'X'));
    doc.takeSave();

    doc.saveSucceeded(3);

    expect(doc.getStatus()).toMatchObject({ serverVersion: 3, unsaved: false });
  });

  it('saveFailed_keeps_the_edit_unsaved_and_resendable', () => {
    const { doc } = openDoc(3);
    doc.edit((c) => retitle(c, 'a', 'X'));
    doc.takeSave();

    doc.saveFailed();

    expect(doc.getStatus()).toMatchObject({ unsaved: true, saving: false, serverVersion: 3 });
    expect(doc.takeSave()?.baseVersion).toBe(3);
  });

  it('conflict_merges_and_resends', () => {
    const { doc } = openDoc(3);
    doc.edit((c) => retitle(c, 'a', 'mine'));
    doc.takeSave();

    doc.saveConflicted({ version: 5, chart: retitle(seed(), 'b', 'Remote B') });

    expect(titleOf(doc.getCommitted(), 'a')).toBe('mine');
    expect(titleOf(doc.getCommitted(), 'b')).toBe('Remote B');
    const resend = doc.takeSave();
    expect(resend?.baseVersion).toBe(5);
    expect(resend?.chart).toBe(doc.getCommitted());
  });

  it('conflict_during_typing_keeps_the_preview', () => {
    const { doc } = openDoc(3);
    doc.edit((c) => retitle(c, 'a', 'one'));
    doc.takeSave();
    doc.preview((c) => retitle(c, 'a', 'one more'));

    doc.saveConflicted({ version: 4, chart: retitle(seed(), 'b', 'Remote B') });

    expect(titleOf(doc.getLive(), 'a')).toBe('one more');
    expect(titleOf(doc.getLive(), 'b')).toBe('Remote B');
    expect(titleOf(doc.getCommitted(), 'a')).toBe('one');
  });

  it('a_stale_conflict_leaves_the_edit_resendable', () => {
    const { doc } = openDoc(3);
    doc.edit((c) => retitle(c, 'a', 'X'));
    doc.takeSave();

    doc.saveConflicted({ version: 3, chart: seed() });

    expect(doc.getStatus().saving).toBe(false);
    expect(doc.takeSave()?.baseVersion).toBe(3);
  });

  describe('remote_during_inflight_save_never_stops_saving', () => {
    const remote = (version: number, title = 'Remote B'): ServerState => ({
      version,
      chart: retitle(seed(), 'b', title),
    });

    it('a poll landing mid-save is ignored and the conflict then merges it', () => {
      const { doc } = openDoc(3);
      doc.edit((c) => retitle(c, 'a', 'mine'));
      doc.takeSave();
      const committedBefore = doc.getCommitted();

      doc.receiveRemote(remote(4));
      expect(doc.getCommitted()).toBe(committedBefore);

      doc.saveConflicted(remote(4));
      expect(titleOf(doc.getCommitted(), 'b')).toBe('Remote B');
      expect(doc.takeSave()?.baseVersion).toBe(4);
    });

    it('a poll answer newer than the save acknowledgement, delivered first, changes nothing until the acknowledgement', () => {
      const { doc } = openDoc(3);
      doc.edit((c) => retitle(c, 'a', 'mine'));
      doc.takeSave();
      const committedBefore = doc.getCommitted();
      // Served after my save landed (version 4) and someone else's write followed (5), so it
      // holds both, and it overtakes the acknowledgement of version 4.
      const poll: ServerState = {
        version: 5,
        chart: retitle(retitle(seed(), 'a', 'mine'), 'b', 'Remote B'),
      };

      doc.receiveRemote(poll);
      expect(doc.getCommitted()).toBe(committedBefore);
      doc.saveSucceeded(4);

      expect(doc.getStatus()).toMatchObject({ serverVersion: 4, unsaved: false });
      doc.edit((c) => recolor(c, 'c', '#abc'));
      doc.receiveRemote(poll);
      const save = doc.takeSave();
      expect(save?.baseVersion).toBe(5);
      expect(titleOf(save!.chart, 'a')).toBe('mine');
      expect(titleOf(save!.chart, 'b')).toBe('Remote B');
      expect(colorOf(save!.chart, 'c')).toBe('#abc');
    });

    it('a conflict carrying the version already known is stale and the save is retried', () => {
      const { doc } = openDoc(3);
      doc.edit((c) => retitle(c, 'a', 'mine'));
      doc.takeSave();

      doc.saveConflicted(remote(3));

      expect(doc.takeSave()?.baseVersion).toBe(3);
    });

    it('a poll answered after the conflict is ignored or merged, never fatal', () => {
      const { doc } = openDoc(3);
      doc.edit((c) => retitle(c, 'a', 'mine'));
      doc.takeSave();
      doc.saveConflicted(remote(4));

      doc.receiveRemote(remote(4)); // the poll that raced the save, answered late
      expect(doc.takeSave()?.baseVersion).toBe(4);
      doc.saveFailed();

      doc.receiveRemote(remote(5, 'Newer B'));
      expect(titleOf(doc.getCommitted(), 'b')).toBe('Newer B');
      expect(doc.takeSave()?.baseVersion).toBe(5);
    });

    it('a poll landing between a failed save and its retry merges and the retry uses its version', () => {
      const { doc } = openDoc(3);
      doc.edit((c) => retitle(c, 'a', 'mine'));
      doc.takeSave();
      doc.saveFailed();

      doc.receiveRemote(remote(4));

      expect(doc.takeSave()?.baseVersion).toBe(4);
    });
  });

  it('conflict_with_lower_version_is_terminal', () => {
    const { doc } = openDoc(5);
    doc.edit((c) => retitle(c, 'a', 'X'));
    doc.takeSave();

    doc.saveConflicted({ version: 4, chart: seed() });

    expect(doc.getStatus().terminalError).toBe(TERMINAL_MESSAGE);
    expect(doc.getStatus().saving).toBe(false);
    expect(doc.takeSave()).toBeNull();
    doc.edit((c) => retitle(c, 'b', 'more'));
    expect(doc.takeSave()).toBeNull();
  });

  it('stale_remote_is_ignored', () => {
    const { doc } = openDoc(5);
    const before = doc.getCommitted();

    doc.receiveRemote({ version: 4, chart: retitle(seed(), 'a', 'old') });
    doc.receiveRemote({ version: 5, chart: retitle(seed(), 'a', 'echo') });

    expect(doc.getCommitted()).toBe(before);
    expect(doc.getStatus().serverVersion).toBe(5);
  });

  it('a_landing_with_nothing_local_adopts_the_remote_chart_without_copying_it', () => {
    const { doc } = openDoc(1);
    const remote = retitle(seed(), 'b', 'Remote B');

    doc.receiveRemote({ version: 2, chart: remote });

    expect(doc.getCommitted()).toBe(remote);
    expect(doc.getLive()).toBe(remote);
    expect(doc.getStatus()).toMatchObject({ serverVersion: 2, unsaved: false });
  });

  it('a_local_edit_that_matches_the_remote_one_is_not_saved_again', () => {
    const { doc } = openDoc(1);
    doc.edit((c) => retitle(c, 'a', 'same'));

    doc.receiveRemote({ version: 2, chart: retitle(seed(), 'a', 'same') });
    expect(doc.getStatus().unsaved).toBe(true);

    expect(doc.takeSave()).toBeNull();
    expect(doc.getStatus().unsaved).toBe(false);
  });

  it('a_preview_equal_to_the_landing_commits_to_nothing', () => {
    const { doc } = openDoc(1);
    doc.preview((c) => retitle(c, 'a', 'same'));

    doc.receiveRemote({ version: 2, chart: retitle(seed(), 'a', 'same') });
    doc.commit();

    expect(doc.getCommitCount()).toBe(0);
    expect(doc.getLive()).toBe(doc.getCommitted());
    expect(doc.getStatus()).toMatchObject({ unsaved: false, canUndo: false });
  });

  it('a_remote_chart_with_a_dangling_connection_lands', () => {
    const base = deepFreeze(connectedChart());
    const { doc } = openDoc(1, base);
    doc.edit((c) => retitle(c, 'b', 'mine'));
    // Deleting a column leaves connections to its nodes behind.
    const remote = change(base, (d) => removeColumn(d, 'c2'));
    expect(connectionOf(remote, 'a', 'c')).toBeDefined();

    doc.receiveRemote({ version: 2, chart: remote });

    expect(titleOf(doc.getCommitted(), 'b')).toBe('mine');
    expect(hasNode(doc.getCommitted(), 'c')).toBe(false);
    expect(connectionOf(doc.getCommitted(), 'a', 'c')).toBeUndefined();
  });

  it('a_merge_that_throws_leaves_the_document_as_it_was', () => {
    const { doc } = openDoc(1);
    doc.edit((c) => retitle(c, 'a', 'mine'));
    const before = doc.getCommitted();
    const duplicateSection = chartWithRepeatedSectionId();

    expect(() => doc.receiveRemote({ version: 2, chart: duplicateSection })).toThrow();

    expect(doc.getCommitted()).toBe(before);
    expect(doc.getStatus().serverVersion).toBe(1);
    expect(doc.takeSave()?.baseVersion).toBe(1);
  });

  it('a_conflict_whose_merge_throws_still_ends_the_save_and_tells_subscribers', () => {
    const { doc } = openDoc(3);
    doc.edit((c) => retitle(c, 'a', 'mine'));
    doc.takeSave();
    const listener = vi.fn();
    doc.subscribe(listener);

    expect(() => doc.saveConflicted({ version: 4, chart: chartWithRepeatedSectionId() })).toThrow();

    expect(doc.getStatus().saving).toBe(false);
    expect(listener).toHaveBeenCalled();
  });
});

describe('ChartDocument server attachment', () => {
  it('attachServer_first_wins', () => {
    const doc = new ChartDocument({ chart: seed(), editToken: null, server: null });

    expect(doc.attachServer('first', { version: 1, chart: seed() })).toBe(true);
    expect(doc.attachServer('second', { version: 7, chart: retitle(seed(), 'a', 'other') })).toBe(
      false,
    );

    expect(doc.getStatus()).toMatchObject({ serverVersion: 1, editToken: 'first' });
  });

  it('a_refused_attachServer_notifies_nobody', () => {
    const doc = new ChartDocument({ chart: seed(), editToken: null, server: null });
    doc.attachServer('first', { version: 1, chart: seed() });
    const listener = vi.fn();
    doc.subscribe(listener);

    doc.attachServer('second', { version: 7, chart: seed() });

    expect(listener).not.toHaveBeenCalled();
  });

  it('attachServer_wakes_subscribers_so_a_save_can_start', () => {
    const created = seed();
    const doc = new ChartDocument({ chart: created, editToken: null, server: null });
    const listener = vi.fn();
    doc.subscribe(listener);

    doc.attachServer('tok', { version: 1, chart: created });

    expect(listener).toHaveBeenCalled();
  });

  it('edits_made_before_the_server_is_attached_go_out_on_its_version', () => {
    const created = seed();
    const doc = new ChartDocument({ chart: created, editToken: null, server: null });
    doc.edit((c) => retitle(c, 'a', 'typed during create'));
    expect(doc.getStatus().unsaved).toBe(true);
    expect(doc.takeSave()).toBeNull();

    doc.attachServer('tok', { version: 1, chart: created });

    const save = doc.takeSave();
    expect(save?.editToken).toBe('tok');
    expect(save?.baseVersion).toBe(1);
    expect(titleOf(save!.chart, 'a')).toBe('typed during create');
  });
});

describe('ChartDocument as an external store', () => {
  it('getLive_getCommitted_and_getStatus_are_stable_between_changes', () => {
    const { doc } = openDoc();
    doc.preview((c) => retitle(c, 'a', 'X'));
    const [live, committed, status] = [doc.getLive(), doc.getCommitted(), doc.getStatus()];

    expect(doc.getLive()).toBe(live);
    expect(doc.getCommitted()).toBe(committed);
    expect(doc.getStatus()).toBe(status);
  });

  it('the_status_object_changes_only_when_a_field_does', () => {
    const { doc } = openDoc();
    doc.preview((c) => retitle(c, 'a', 'X'));
    const status = doc.getStatus();

    doc.preview((c) => retitle(c, 'a', 'XY')); // a keystroke: nothing App shows changed
    expect(doc.getStatus()).toBe(status);

    doc.commit();
    expect(doc.getStatus()).toBe(status);

    doc.takeSave();
    expect(doc.getStatus()).not.toBe(status);
    expect(doc.getStatus().saving).toBe(true);
  });

  it('subscribers_hear_every_state_change_until_they_unsubscribe', () => {
    const { doc, clock } = openDoc(1);
    const listener = vi.fn();
    const unsubscribe = doc.subscribe(listener);
    const heard = () => listener.mock.calls.length;

    const steps: [string, () => void][] = [
      ['preview', () => doc.preview((c) => retitle(c, 'a', 'X'))],
      ['commit', () => doc.commit()],
      ['edit', () => doc.edit((c) => recolor(c, 'a', '#f00'))],
      ['takeSave', () => doc.takeSave()],
      ['saveFailed', () => doc.saveFailed()],
      ['undo', () => doc.undo()],
      ['redo', () => doc.redo()],
      ['receiveRemote', () => doc.receiveRemote({ version: 2, chart: retitle(seed(), 'b', 'R') })],
      ['replace', () => doc.replace(retitle(seed(), 'd', 'Imported'))],
      ['applyRebased', () => doc.applyRebased(seed(), retitle(seed(), 'c', 'AI'))],
      ['takeSave again', () => doc.takeSave()],
      ['saveSucceeded', () => doc.saveSucceeded(3)],
      [
        'takeSave and conflict',
        () => {
          doc.edit((c) => retitle(c, 'a', 'Y'));
          doc.takeSave();
          doc.saveConflicted({ version: 4, chart: retitle(seed(), 'b', 'R2') });
        },
      ],
    ];
    for (const [name, step] of steps) {
      clock.now += 1000;
      const before = heard();
      step();
      expect(heard(), name).toBeGreaterThan(before);
    }

    unsubscribe();
    const after = heard();
    doc.edit((c) => retitle(c, 'a', 'Z'));
    expect(heard()).toBe(after);
  });

  it('a_preview_that_changes_nothing_notifies_nobody', () => {
    const { doc } = openDoc();
    doc.preview((c) => retitle(c, 'a', 'X'));
    const listener = vi.fn();
    doc.subscribe(listener);

    doc.preview((c) => c);
    doc.preview(doc.getLive());

    expect(listener).not.toHaveBeenCalled();
  });

  it('a_subscriber_reads_the_new_state_when_it_is_told', () => {
    const { doc } = openDoc();
    const seen: (string | undefined)[] = [];
    doc.subscribe(() => seen.push(titleOf(doc.getLive(), 'a')));

    doc.preview((c) => retitle(c, 'a', 'X'));

    expect(seen).toEqual(['X']);
  });

  describe('staticStore', () => {
    it('serves the chart and ignores writes', () => {
      const chart = seed();
      const store = staticStore(chart);
      const listener = vi.fn();
      const unsubscribe = store.subscribe(listener);

      store.preview((c) => retitle(c, 'a', 'X'));
      store.commit();

      expect(store.getLive()).toBe(chart);
      expect(store.getCommitted()).toBe(chart);
      expect(store.getCommitCount()).toBe(0);
      expect(listener).not.toHaveBeenCalled();
      expect(() => unsubscribe()).not.toThrow();
    });
  });
});
