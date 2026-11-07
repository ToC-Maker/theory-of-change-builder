import { describe, expect, it } from 'vitest';
import { mergeCharts, type ConflictWinner } from '../../shared/chart-merge';
import { normalizeChart, type Node, type ToCData } from '../../shared/chart-model';
import { deepFreeze } from '../frontend/helpers/deepFreeze';
import {
  addConnection,
  columnIn,
  columnsOf,
  connectedChart,
  connectionOf,
  edit,
  findNode,
  hasNode,
  moveNode,
  node,
  nodeIn,
  nodesOf,
  removeColumn,
  removeNode,
  removeSection,
} from './chart-fixtures';

const B = connectedChart();

/**
 * Merges frozen copies of the inputs (a write into any of them throws) and
 * checks the result is a normalised chart with no key holding `undefined`
 * before returning it.
 */
function merge(
  base: ToCData,
  mine: ToCData,
  theirs: ToCData,
  onConflict: ConflictWinner = 'mine',
): ToCData {
  const out = mergeCharts(deepFreeze(base), deepFreeze(mine), deepFreeze(theirs), { onConflict });
  expect(normalizeChart(out)).toStrictEqual(JSON.parse(JSON.stringify(out)));
  return out;
}

const titleOf = (chart: ToCData, id: string) => findNode(chart, id)?.title;
const columnOfNode = (chart: ToCData, id: string) =>
  columnsOf(chart).find((c) => c.nodes.some((n) => n.id === id))?.id;
const nodeIds = (chart: ToCData) => nodesOf(chart).map((n) => n.id);

describe('mergeCharts: independent edits', () => {
  it('keeps edits to different nodes', () => {
    const mine = edit(B, (c) => (nodeIn(c, 'a').title = 'mine'));
    const theirs = edit(B, (c) => (nodeIn(c, 'b').title = 'their'));
    const r = merge(B, mine, theirs);
    expect(titleOf(r, 'a')).toBe('mine');
    expect(titleOf(r, 'b')).toBe('their');
  });

  it('keeps edits to different fields of one node', () => {
    const mine = edit(B, (c) => (nodeIn(c, 'a').title = 'mine'));
    const theirs = edit(B, (c) => (nodeIn(c, 'a').color = '#f00'));
    const r = merge(B, mine, theirs);
    expect(findNode(r, 'a')).toMatchObject({ title: 'mine', color: '#f00' });
  });

  it.each([
    ['mine', 'later'],
    ['theirs', 'earlier'],
  ] as const)('same field changed by both: onConflict %s keeps %s', (winner, expected) => {
    const mine = edit(B, (c) => (nodeIn(c, 'a').title = 'later'));
    const theirs = edit(B, (c) => (nodeIn(c, 'a').title = 'earlier'));
    expect(titleOf(merge(B, mine, theirs, winner), 'a')).toBe(expected);
  });

  it('merges chart-level fields one by one', () => {
    const mine = edit(B, (c) => {
      c.title = 'mine title';
      c.curvature = 0.1;
    });
    const theirs = edit(B, (c) => {
      c.textSize = 1.5;
      c.curvature = 0.9;
    });
    const r = merge(B, mine, theirs);
    expect(r).toMatchObject({ title: 'mine title', textSize: 1.5, curvature: 0.1 });
    expect(merge(B, mine, theirs, 'theirs').curvature).toBe(0.9);
  });

  it('unknown_fields_merge_per_field', () => {
    const base = edit(B, (c) => {
      Object.assign(nodeIn(c, 'a'), { foo: 1, bar: 1 });
    });
    const mine = edit(base, (c) => Object.assign(nodeIn(c, 'a'), { foo: 2 }));
    const theirs = edit(base, (c) => Object.assign(nodeIn(c, 'a'), { bar: 2 }));
    expect(findNode(merge(base, mine, theirs), 'a')).toMatchObject({ foo: 2, bar: 2 });
  });

  it('key_order_does_not_count_as_change', () => {
    const base = edit(B, (c) => {
      c.sections[0].columns[0].nodes[0].connections = [
        { targetId: 'c', confidence: 75, waypoints: [{ dx: 1, dy: 2 }] },
      ];
    });
    const mine = edit(base, (c) => {
      nodeIn(c, 'a').connections![0].waypoints = [{ dx: 5, dy: 2 }];
    });
    // Same value as base with the keys in another order (as stored JSONB comes back), plus an
    // unrelated edit so the merge cannot take a fast path.
    const theirs = edit(base, (c) => {
      nodeIn(c, 'a').connections![0].waypoints = [{ dy: 2, dx: 1 }];
      nodeIn(c, 'b').title = 'other';
    });
    const r = merge(base, mine, theirs, 'theirs');
    expect(connectionOf(r, 'a', 'c')?.waypoints).toEqual([{ dx: 5, dy: 2 }]);
    expect(titleOf(r, 'b')).toBe('other');
  });
});

describe('mergeCharts: deleting a node', () => {
  it('keeps a node whose text someone edited, with the text', () => {
    const mine = edit(B, (c) => removeNode(c, 'a'));
    const theirs = edit(B, (c) => (nodeIn(c, 'a').text = 'long considered text'));
    expect(findNode(merge(B, mine, theirs), 'a')?.text).toBe('long considered text');
  });

  it('keeps a node whose title someone edited', () => {
    const mine = edit(B, (c) => removeNode(c, 'b'));
    const theirs = edit(B, (c) => (nodeIn(c, 'b').title = 'renamed'));
    expect(titleOf(merge(B, mine, theirs), 'b')).toBe('renamed');
  });

  it.each([
    ['position', (n: Node) => (n.yPosition = 900)],
    ['width', (n: Node) => (n.width = 300)],
    ['colour', (n: Node) => (n.color = '#f00')],
    ['unknown field', (n: Node) => Object.assign(n, { foo: 1 })],
  ])('loses to the delete when the other side only changed its %s', (_name, change) => {
    const mine = edit(B, (c) => removeNode(c, 'b'));
    const theirs = edit(B, (c) => change(nodeIn(c, 'b')));
    expect(hasNode(merge(B, mine, theirs), 'b')).toBe(false);
  });

  it('removes connections into the deleted node, whether or not the delete cleaned them', () => {
    const unrelated = edit(B, (c) => (nodeIn(c, 'd').title = 'other'));
    const cleaned = edit(B, (c) => removeNode(c, 'c'));
    const dangling = edit(B, (c) => removeNode(c, 'c', false));
    expect(dangling.sections[0].columns[0].nodes[0].connections).toHaveLength(1);
    expect(findNode(merge(B, cleaned, unrelated), 'a')?.connections).toEqual([]);
    expect(findNode(merge(B, dangling, unrelated), 'a')?.connections).toEqual([]);
  });

  it('removes the deleted node when both sides delete it', () => {
    const mine = edit(B, (c) => removeNode(c, 'b'));
    const theirs = edit(B, (c) => removeNode(c, 'b'));
    expect(hasNode(merge(B, mine, theirs), 'b')).toBe(false);
  });
});

describe('mergeCharts: moving nodes', () => {
  it.each([
    ['mine', 'c3', 50],
    ['theirs', 'c4', 70],
  ] as const)(
    'concurrent moves of one node leave one copy, where onConflict %s put it',
    (winner, column, y) => {
      const mine = edit(B, (c) => moveNode(c, 'a', 'c3', 50));
      const theirs = edit(B, (c) => moveNode(c, 'a', 'c4', 70));
      const r = merge(B, mine, theirs, winner);
      expect(nodeIds(r).filter((id) => id === 'a')).toHaveLength(1);
      expect(columnOfNode(r, 'a')).toBe(column);
      expect(findNode(r, 'a')?.yPosition).toBe(y);
    },
  );

  it('keeps both a move and a rename of the same node', () => {
    const mine = edit(B, (c) => moveNode(c, 'a', 'c3', 50));
    const theirs = edit(B, (c) => (nodeIn(c, 'a').title = 'renamed'));
    const r = merge(B, mine, theirs);
    expect(titleOf(r, 'a')).toBe('renamed');
    expect(columnOfNode(r, 'a')).toBe('c3');
  });

  it('appends a node moved into a column after the nodes already there', () => {
    const mine = edit(B, (c) => moveNode(c, 'a', 'c3', 50));
    const theirs = edit(B, (c) => (nodeIn(c, 'd').title = 'other'));
    expect(columnIn(merge(B, mine, theirs), 'c3').nodes.map((n) => n.id)).toEqual(['d', 'a']);
  });
});

describe('mergeCharts: sections and columns', () => {
  it('lets a section inserted at the front leave a rename of the second section alone', () => {
    const mine = edit(B, (c) =>
      c.sections.unshift({ id: 'sNew', title: 'Front', columns: [{ id: 'cNew', nodes: [] }] }),
    );
    const theirs = edit(B, (c) => (c.sections[1].title = 'Two renamed'));
    const r = merge(B, mine, theirs);
    expect(r.sections.map((s) => s.id)).toEqual(['sNew', 's1', 's2']);
    expect(r.sections[2].title).toBe('Two renamed');
  });

  it('keeps two columns inserted at one spot, mine first', () => {
    const mine = edit(B, (c) => c.sections[0].columns.splice(1, 0, { id: 'cA', nodes: [] }));
    const theirs = edit(B, (c) => c.sections[0].columns.splice(1, 0, { id: 'cB', nodes: [] }));
    expect(merge(B, mine, theirs).sections[0].columns.map((c) => c.id)).toEqual([
      'c1',
      'cA',
      'cB',
      'c2',
    ]);
  });

  it('keeps a column, and the node added to it, when the other side deletes the column', () => {
    const mine = edit(B, (c) => c.sections[1].columns.splice(1, 1));
    const theirs = edit(B, (c) => columnIn(c, 'c4').nodes.push(node('new', 40)));
    const r = merge(B, mine, theirs);
    expect(columnOfNode(r, 'new')).toBe('c4');
  });

  it('keeps a section, its column and the node renamed in it when the other side deletes the section', () => {
    const mine = edit(B, (c) => removeSection(c, 's2'));
    const theirs = edit(B, (c) => (nodeIn(c, 'd').title = 'kept'));
    const r = merge(B, mine, theirs);
    expect(titleOf(r, 'd')).toBe('kept');
    expect(r.sections.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(columnsOf(r).map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
  });

  it('section_rename_loses_to_section_delete', () => {
    const base = edit(B, (c) =>
      c.sections.push({ id: 's3', title: 'Empty', columns: [{ id: 'c5', nodes: [] }] }),
    );
    const mine = edit(base, (c) => removeSection(c, 's3'));
    const theirs = edit(base, (c) => (c.sections[2].title = 'Renamed'));
    expect(merge(base, mine, theirs).sections.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('merges a section title edit with a column insert in that section', () => {
    const mine = edit(B, (c) => (c.sections[0].title = 'One renamed'));
    const theirs = edit(B, (c) => c.sections[0].columns.push({ id: 'cNew', nodes: [] }));
    const r = merge(B, mine, theirs);
    expect(r.sections[0].title).toBe('One renamed');
    expect(r.sections[0].columns.map((c) => c.id)).toEqual(['c1', 'c2', 'cNew']);
  });
});

describe('mergeCharts: containers deleted by the other side', () => {
  it('a_column_deleted_by_theirs_stays_deleted', () => {
    const mine = edit(B, (c) => (nodeIn(c, 'd').title = 'other'));
    const theirs = edit(B, (c) => removeColumn(c, 'c4'));
    expect(columnsOf(merge(B, mine, theirs)).map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
  });

  it('a_section_deleted_by_theirs_stays_deleted', () => {
    const base = edit(B, (c) =>
      c.sections.push({ id: 's3', title: 'Empty', columns: [{ id: 'c5', nodes: [] }] }),
    );
    const mine = edit(base, (c) => (nodeIn(c, 'd').title = 'other'));
    const theirs = edit(base, (c) => removeSection(c, 's3'));
    const r = merge(base, mine, theirs);
    expect(r.sections.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(columnsOf(r).map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c4']);
  });
});

describe('mergeCharts: order', () => {
  it('places a new item after its nearest left neighbour that survives', () => {
    const base = edit(B, (c) => columnIn(c, 'c1').nodes.push(node('p'), node('q')));
    const mine = edit(base, (c) => columnIn(c, 'c1').nodes.push(node('new')));
    const theirs = edit(base, (c) => removeNode(c, 'q'));
    expect(columnIn(merge(base, mine, theirs), 'c1').nodes.map((n) => n.id)).toEqual([
      'a',
      'b',
      'p',
      'new',
    ]);
  });
});

describe('mergeCharts: undo and redo in revert form', () => {
  it('reverts only the undone change', () => {
    const after = edit(B, (c) => (nodeIn(c, 'a').color = '#0f0'));
    const current = edit(after, (c) => (nodeIn(c, 'b').title = 'other person'));
    const r = merge(after, B, current, 'theirs');
    expect(findNode(r, 'a')?.color).toBe('#fff');
    expect(titleOf(r, 'b')).toBe('other person');
  });

  it('restores a deleted node and its connection, keeping other edits', () => {
    const after = edit(B, (c) => removeNode(c, 'a'));
    const current = edit(after, (c) => (nodeIn(c, 'b').title = 'other person'));
    const r = merge(after, B, current, 'theirs');
    expect(connectionOf(r, 'a', 'c')?.confidence).toBe(75);
    expect(titleOf(r, 'b')).toBe('other person');
  });

  it('yields to a later change of the same field', () => {
    const after = edit(B, (c) => (nodeIn(c, 'a').color = '#0f0'));
    const current = edit(after, (c) => (nodeIn(c, 'a').color = '#00f'));
    expect(findNode(merge(after, B, current, 'theirs'), 'a')?.color).toBe('#00f');
  });

  it('theirs_mode_keeps_their_delete', () => {
    const mine = edit(B, (c) => (nodeIn(c, 'b').title = 'edited by me'));
    const theirs = edit(B, (c) => removeNode(c, 'b'));
    expect(hasNode(merge(B, mine, theirs, 'theirs'), 'b')).toBe(false);
    expect(hasNode(merge(B, mine, theirs, 'mine'), 'b')).toBe(true);
  });

  it('keeps a node someone renamed when undoing its creation', () => {
    const before = B;
    const after = edit(B, (c) => columnIn(c, 'c4').nodes.push(node('x', 40)));
    const current = edit(after, (c) => (nodeIn(c, 'x').title = 'renamed by other'));
    expect(titleOf(merge(after, before, current, 'theirs'), 'x')).toBe('renamed by other');
  });

  it('does not bring back, by redo, a node the collaborator deleted', () => {
    const after = edit(B, (c) => addConnection(c, 'a', 'd', { confidence: 75, evidence: 'why' }));
    const current = edit(B, (c) => removeNode(c, 'd'));
    const redone = merge(B, after, current, 'theirs');
    expect(hasNode(redone, 'd')).toBe(false);
    expect(connectionOf(redone, 'a', 'd')).toBeUndefined();
  });
});

describe('mergeCharts: undo and redo, more cases', () => {
  it('yields to a later rename of the section as well as of a node', () => {
    const after = edit(B, (c) => (c.sections[0].title = 'my rename'));
    const current = edit(after, (c) => (c.sections[0].title = 'collaborator rename'));
    expect(merge(after, B, current, 'theirs').sections[0].title).toBe('collaborator rename');
  });

  it('does not bring back, by redo, a node whose connection I added after the collaborator deleted its source', () => {
    const after = edit(B, (c) => addConnection(c, 'a', 'd', { confidence: 75, evidence: 'why' }));
    const current = edit(B, (c) => removeNode(c, 'a'));
    const redone = merge(B, after, current, 'theirs');
    expect(hasNode(redone, 'a')).toBe(false);
    expect(hasNode(redone, 'd')).toBe(true);
  });
});

describe('mergeCharts: connections', () => {
  it('connection_evidence_edit_keeps_deleted_end_node', () => {
    const mine = edit(B, (c) => removeNode(c, 'c'));
    const theirs = edit(B, (c) => (nodeIn(c, 'a').connections![0].evidence = 'why'));
    const r = merge(B, mine, theirs);
    expect(hasNode(r, 'c')).toBe(true);
    expect(connectionOf(r, 'a', 'c')).toMatchObject({ confidence: 75, evidence: 'why' });
  });

  it('keeps a node and the evidence I typed when the other side deletes the node', () => {
    const mine = edit(B, (c) => (nodeIn(c, 'a').connections![0].assumptions = 'because'));
    const theirs = edit(B, (c) => removeNode(c, 'c'));
    const r = merge(B, mine, theirs);
    expect(hasNode(r, 'c')).toBe(true);
    expect(connectionOf(r, 'a', 'c')?.assumptions).toBe('because');
  });

  it.each(['mine', 'theirs'] as const)(
    'column_delete_keeps_connection_with_typed_evidence (typed by %s)',
    (typist) => {
      const deleter = edit(B, (c) => removeColumn(c, 'c2'));
      // The app leaves the connection behind, pointing at a node the chart no longer has.
      expect(nodeIn(deleter, 'a').connections).toHaveLength(1);
      expect(hasNode(deleter, 'c')).toBe(false);
      const typer = edit(B, (c) => (nodeIn(c, 'a').connections![0].evidence = 'typed'));
      const r = typist === 'mine' ? merge(B, typer, deleter) : merge(B, deleter, typer);
      expect(columnOfNode(r, 'c')).toBe('c2');
      expect(connectionOf(r, 'a', 'c')?.evidence).toBe('typed');
    },
  );

  it('new_connection_with_evidence_pins_endpoints', () => {
    const base = edit(B, (c) => columnIn(c, 'c4').nodes.push(node('x', 40)));
    const mine = edit(base, (c) => removeNode(c, 'x'));
    const theirs = edit(base, (c) => addConnection(c, 'd', 'x', { evidence: 'e' }));
    const r = merge(base, mine, theirs);
    expect(hasNode(r, 'x')).toBe(true);
    expect(connectionOf(r, 'd', 'x')?.evidence).toBe('e');
  });

  it('lets a new connection without evidence lose to the delete of its target', () => {
    const base = edit(B, (c) => columnIn(c, 'c4').nodes.push(node('x', 40)));
    const mine = edit(base, (c) => removeNode(c, 'x'));
    const theirs = edit(base, (c) => addConnection(c, 'd', 'x', { confidence: 90 }));
    const r = merge(base, mine, theirs);
    expect(hasNode(r, 'x')).toBe(false);
    expect(findNode(r, 'd')?.connections).toEqual([]);
  });

  it('confidence_change_loses_to_connection_delete', () => {
    const mine = edit(B, (c) => (nodeIn(c, 'a').connections = []));
    const theirs = edit(B, (c) => (nodeIn(c, 'a').connections![0].confidence = 90));
    const r = merge(B, mine, theirs);
    expect(connectionOf(r, 'a', 'c')).toBeUndefined();
    expect(hasNode(r, 'c')).toBe(true);
  });

  it('waypoint_change_loses_to_node_delete', () => {
    const mine = edit(B, (c) => removeNode(c, 'c'));
    const theirs = edit(B, (c) => {
      nodeIn(c, 'a').connections![0].waypoints = [{ dx: 10, dy: -5 }];
    });
    const r = merge(B, mine, theirs);
    expect(hasNode(r, 'c')).toBe(false);
    expect(connectionOf(r, 'a', 'c')).toBeUndefined();
  });

  it('treats a connection to a node the chart no longer has as absent', () => {
    const mine = edit(B, (c) => addConnection(c, 'b', 'ghost', { confidence: 60 }));
    const theirs = edit(B, (c) => (nodeIn(c, 'd').title = 'other'));
    const r = merge(B, mine, theirs);
    expect(findNode(r, 'b')?.connections).toEqual([]);
    expect(findNode(r, 'b')?.connectionIds).toEqual([]);
  });

  it.each([
    ['mine', 90],
    ['theirs', 30],
  ] as const)(
    'merges a connection both sides added field by field, onConflict %s deciding the shared one',
    (winner, confidence) => {
      const mine = edit(B, (c) =>
        addConnection(c, 'a', 'b', { confidence: 90, evidence: 'typed by mine' }),
      );
      const theirs = edit(B, (c) => addConnection(c, 'a', 'b', { confidence: 30 }));
      expect(connectionOf(merge(B, mine, theirs, winner), 'a', 'b')).toEqual({
        targetId: 'b',
        confidence,
        evidence: 'typed by mine',
      });
    },
  );

  it('keeps connections both sides added to one node', () => {
    const mine = edit(B, (c) => addConnection(c, 'a', 'b', { confidence: 60 }));
    const theirs = edit(B, (c) => addConnection(c, 'a', 'd', { confidence: 40 }));
    const r = merge(B, mine, theirs);
    expect(findNode(r, 'a')?.connections?.map((c) => c.targetId)).toEqual(['c', 'b', 'd']);
    expect(findNode(r, 'a')?.connectionIds).toEqual(['c', 'b', 'd']);
  });
});

describe('mergeCharts: connections, more cases', () => {
  it('keeps the source node and the evidence when the other side deletes the source', () => {
    const mine = edit(B, (c) => (nodeIn(c, 'a').connections![0].evidence = 'typed'));
    const theirs = edit(B, (c) => removeNode(c, 'a'));
    const r = merge(B, mine, theirs);
    expect(hasNode(r, 'a')).toBe(true);
    expect(connectionOf(r, 'a', 'c')?.evidence).toBe('typed');
  });

  it.each([
    ['empty evidence', { evidence: '' }],
    ['null assumptions', { assumptions: null as unknown as string }],
  ])('lets a new connection with %s lose to the delete of its target', (_name, props) => {
    const base = edit(B, (c) => columnIn(c, 'c4').nodes.push(node('x', 40)));
    const mine = edit(base, (c) => removeNode(c, 'x'));
    const theirs = edit(base, (c) => addConnection(c, 'd', 'x', props));
    expect(hasNode(merge(base, mine, theirs), 'x')).toBe(false);
  });

  it('omits the keys one side deleted, at chart, section and connection level', () => {
    const base = edit(B, (c) => {
      c.textSize = 1.5;
      Object.assign(c.sections[0], { foo: 'x' });
      nodeIn(c, 'a').connections![0].evidence = 'old';
    });
    const mine = edit(base, (c) => {
      delete c.textSize;
      delete (c.sections[0] as unknown as Record<string, unknown>).foo;
      delete nodeIn(c, 'a').connections![0].evidence;
    });
    const theirs = edit(base, (c) => (nodeIn(c, 'd').title = 'other'));
    const r = merge(base, mine, theirs);
    expect(r).not.toHaveProperty('textSize');
    expect(r.sections[0]).not.toHaveProperty('foo');
    expect(connectionOf(r, 'a', 'c')).not.toHaveProperty('evidence');
  });

  it('treats field names such as __proto__ and toString as plain data', () => {
    const hostile = (meta: string, nodeFields: string, x: number) =>
      normalizeChart(
        JSON.parse(`{ "title": "T", ${meta}
          "sections": [{ "id": "s1", "title": "One", "columns": [{ "id": "c1", "nodes": [
            { "id": "a", "title": "A", "text": "", "connectionIds": [], ${nodeFields} "x": ${x} }
          ] }] }] }`),
      );
    const withNames = hostile(
      '"__proto__": {"polluted": true}, "constructor": "meta value",',
      '"__proto__": {"polluted": true}, "toString": "node value",',
      1,
    );
    const mine = hostile('"__proto__": {"polluted": true},', '"__proto__": {"polluted": true},', 1);
    const theirs = hostile(
      '"__proto__": {"polluted": true}, "constructor": "meta value",',
      '"__proto__": {"polluted": true}, "toString": "node value",',
      2,
    );
    const r = mergeCharts(withNames, mine, theirs, { onConflict: 'mine' });
    const a = findNode(r, 'a') as unknown as Record<string, unknown>;
    expect(a.x).toBe(2);
    expect(Object.hasOwn(a, 'toString')).toBe(false);
    expect(Object.hasOwn(r, 'constructor')).toBe(false);
    expect(Object.hasOwn(a, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(a)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(r)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('mergeCharts: AI edit against a stale base', () => {
  it('lands an edit made by index on the intended node after a section was inserted', () => {
    const asSent = B;
    const aiResult = edit(asSent, (c) => (c.sections[1].columns[0].nodes[0].title = 'AI title'));
    const current = edit(B, (c) =>
      c.sections.unshift({ id: 'sNew', title: 'Front', columns: [{ id: 'cNew', nodes: [] }] }),
    );
    const r = merge(asSent, aiResult, current);
    expect(titleOf(r, 'd')).toBe('AI title');
    expect(r.sections[0].id).toBe('sNew');
  });
});

describe('mergeCharts: output', () => {
  it('returns the input itself when the other side did not change anything', () => {
    const mine = edit(B, (c) => (nodeIn(c, 'a').title = 'mine'));
    const sameAsBase = structuredClone(B);
    expect(mergeCharts(B, mine, sameAsBase, { onConflict: 'mine' })).toBe(mine);
    expect(mergeCharts(B, sameAsBase, mine, { onConflict: 'mine' })).toBe(mine);
  });

  it('returns a chart equal to the input when all three are the same', () => {
    expect(merge(B, B, B)).toEqual(B);
  });

  it('rebuilds yPosition from the merged position and omits keys that end up undefined', () => {
    const mine = edit(B, (c) => {
      moveNode(c, 'a', 'c3', 50);
      nodeIn(c, 'a').color = undefined;
    });
    const theirs = edit(B, (c) => (nodeIn(c, 'd').title = 'other'));
    const a = findNode(merge(B, mine, theirs), 'a');
    expect(a?.yPosition).toBe(50);
    expect(a).not.toHaveProperty('color');
    expect(a).toMatchObject({
      connections: [{ targetId: 'c', confidence: 75 }],
      connectionIds: ['c'],
    });
  });

  it('leaves a node without yPosition when neither side positioned it', () => {
    const base = edit(B, (c) => (nodeIn(c, 'b').yPosition = undefined));
    const mine = edit(base, (c) => (nodeIn(c, 'b').title = 'mine'));
    const theirs = edit(base, (c) => (nodeIn(c, 'd').title = 'other'));
    expect(findNode(merge(base, mine, theirs), 'b')).not.toHaveProperty('yPosition');
  });

  it.each([
    ['section', 's1', (c: ToCData) => c.sections.push({ id: 's1', title: 'again', columns: [] })],
    ['column', 'c1', (c: ToCData) => c.sections[1].columns.push({ id: 'c1', nodes: [] })],
    ['node', 'a', (c: ToCData) => columnIn(c, 'c2').nodes.push(node('a'))],
  ])('throws on a %s id that repeats within one chart', (kind, id, repeat) => {
    const repeated = structuredClone(B);
    repeat(repeated);
    const theirs = edit(B, (c) => (nodeIn(c, 'd').title = 'other'));
    expect(() => mergeCharts(B, repeated, theirs, { onConflict: 'mine' })).toThrow(
      `Chart repeats ${kind} id ${id}`,
    );
  });

  it('rebuilds a chart from deletes, a move and an added section in one pass', () => {
    const mine = edit(B, (c) => {
      removeColumn(c, 'c2');
      removeNode(c, 'b');
      c.sections.push({ id: 's9', title: 'new', columns: [{ id: 'c9', nodes: [node('n9')] }] });
    });
    const theirs = edit(B, (c) => {
      nodeIn(c, 'c').text = 'edited';
      nodeIn(c, 'b').title = 'renamed';
      moveNode(c, 'd', 'c1', 10);
    });
    const r = merge(B, mine, theirs);
    expect(r.sections.map((s) => s.id)).toEqual(['s1', 's2', 's9']);
    expect(r.sections[0].columns.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(nodeIds(r).sort()).toEqual(['a', 'b', 'c', 'd', 'n9']);
    expect(columnOfNode(r, 'd')).toBe('c1');
    expect(connectionOf(r, 'a', 'c')).toBeUndefined();
  });
});
