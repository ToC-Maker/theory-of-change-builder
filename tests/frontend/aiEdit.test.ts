// What an AI reply does to the chart: the model sees the chart without
// section and column ids, may reuse node ids a previous reply already used,
// and edits it by index paths, so its result has to be made safe to merge into
// whatever the chart is by the time the reply lands.
import { describe, expect, it } from 'vitest';
import { prepareAIResult } from '../../src/sync/aiEdit';
import { ChartDocument } from '../../src/sync/ChartDocument';
import { addNodePaths } from '../../src/utils/addNodePaths';
import { applyEdits, type EditInstruction } from '../../src/utils/graphEdits';
import {
  ChartShapeError,
  normalizeChart,
  type ChartInput,
  type Node,
} from '../../shared/chart-model';
import {
  connectedChart,
  connectionOf,
  edit,
  findNode,
  node,
  nodesOf,
  seedChart,
} from '../shared/chart-fixtures';

const asInput = (chart: ReturnType<typeof seedChart>): ChartInput => structuredClone(chart);

/** The result of an AI reply that adds `added` to column c1 and connects `a` to it. */
function replyAdding(added: Node): ChartInput {
  const result = asInput(seedChart());
  result.sections[0].columns[0].nodes.push(added);
  result.sections[0].columns[0].nodes[0].connections = [{ targetId: added.id, confidence: 80 }];
  result.sections[0].columns[0].nodes[0].connectionIds = [added.id];
  return result;
}

describe('prepareAIResult', () => {
  it('aiEdit_remaps_minted_node_ids', () => {
    const asSent = seedChart();
    const prepared = prepareAIResult(asSent, replyAdding(node('new-node-id', 500)));

    const added = nodesOf(prepared).filter((n) => !findNode(asSent, n.id));
    expect(added).toHaveLength(1);
    expect(added[0].id).toMatch(/^node-/);
    expect(added[0].id).not.toBe('new-node-id');
    // The connection to it follows the new id, in both representations.
    const a = findNode(prepared, 'a');
    expect(a?.connections).toEqual([{ targetId: added[0].id, confidence: 80 }]);
    expect(a?.connectionIds).toEqual([added[0].id]);
  });

  it('gives a second reply that reuses the same minted id a different id', () => {
    const asSent = seedChart();
    const first = prepareAIResult(asSent, replyAdding(node('new-node-id', 500)));
    const second = prepareAIResult(asSent, replyAdding(node('new-node-id', 500)));

    const idOfAdded = (chart: typeof first) =>
      nodesOf(chart).find((n) => !findNode(asSent, n.id))?.id;
    expect(idOfAdded(first)).not.toBe(idOfAdded(second));
  });

  it('keeps the ids of nodes the chart already had and gives a repeated id in the reply a new one', () => {
    const asSent = seedChart();
    const result = asInput(asSent);
    // The reply copies node `a` into column c2 under the same id.
    result.sections[0].columns[1].nodes.push({ ...node('a', 700) });

    const prepared = prepareAIResult(asSent, result);

    const ids = nodesOf(prepared).map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(findNode(prepared, 'a')?.yPosition).toBe(100);
    expect(ids.filter((id) => !findNode(asSent, id))).toHaveLength(1);
  });

  it('mints ids for nodes the reply gave none', () => {
    const asSent = seedChart();
    const result = asInput(asSent);
    const { id: _dropped, ...idless } = node('x', 500);
    void _dropped;
    result.sections[0].columns[0].nodes.push(idless as unknown as Node);

    const prepared = prepareAIResult(asSent, result);

    const added = nodesOf(prepared).filter((n) => !findNode(asSent, n.id));
    expect(added).toHaveLength(1);
    expect(added[0].id).toMatch(/^node-/);
  });

  it('gives sections and columns the reply created random ids, so two replies cannot share a positional one', () => {
    const asSent = seedChart();
    const reply = () => {
      const result = asInput(asSent);
      result.sections.push({ title: 'New', columns: [{ nodes: [] }] });
      return result;
    };

    const first = prepareAIResult(asSent, reply());
    const second = prepareAIResult(asSent, reply());

    expect(first.sections.slice(0, 2).map((s) => s.id)).toEqual(['s1', 's2']);
    expect(first.sections[2].id).toMatch(/^sec-/);
    expect(first.sections[2].columns[0].id).toMatch(/^col-/);
    expect(second.sections[2].id).not.toBe(first.sections[2].id);
    expect(second.sections[2].columns[0].id).not.toBe(first.sections[2].columns[0].id);
  });

  it('keeps an edge when the reply rewrites a whole node and lists only its connectionIds', () => {
    // graphEdits fills `connections` only for inserted and pushed nodes, so a
    // whole-node update leaves a node with connectionIds and no connections,
    // which the merge would read as every edge of that node deleted.
    const asSent = connectedChart();
    const edits: EditInstruction[] = [
      {
        type: 'update',
        path: 'sections.0.columns.0.nodes.0',
        value: { id: 'a', title: 'A retitled', text: 'a body', connectionIds: ['c'] },
      },
    ];
    const result = applyEdits(asSent, edits);
    expect(findNode(normalizeChart(result), 'a')).toBeDefined();
    expect((result.sections[0].columns[0].nodes[0] as Node).connections).toBeUndefined();

    const prepared = prepareAIResult(asSent, result);

    expect(findNode(prepared, 'a')?.title).toBe('A retitled');
    expect(connectionOf(prepared, 'a', 'c')).toBeDefined();
    expect(findNode(prepared, 'a')?.connectionIds).toEqual(['c']);

    // End to end: landing it on a chart a collaborator has since edited keeps both.
    const doc = new ChartDocument({
      chart: asSent,
      editToken: 't',
      server: { version: 1, chart: asSent },
    });
    doc.receiveRemote({ version: 2, chart: edit(asSent, (d) => (findNode(d, 'd')!.title = 'D!')) });
    doc.applyRebased(asSent, prepared);
    expect(findNode(doc.getCommitted(), 'a')?.title).toBe('A retitled');
    expect(findNode(doc.getCommitted(), 'd')?.title).toBe('D!');
    expect(connectionOf(doc.getCommitted(), 'a', 'c')).toBeDefined();
  });

  it('lands on the node an index path meant after a collaborator inserted a section', () => {
    const asSent = seedChart();
    const reply = applyEdits(asSent, [
      { type: 'update', path: 'sections.0.columns.0.nodes.0.title', value: 'Retitled by AI' },
    ]);
    const prepared = prepareAIResult(asSent, reply);

    const doc = new ChartDocument({
      chart: asSent,
      editToken: 't',
      server: { version: 1, chart: asSent },
    });
    // Someone inserts a section in front while the reply streams.
    doc.receiveRemote({
      version: 2,
      chart: edit(asSent, (d) =>
        d.sections.unshift({
          id: 'sec-new',
          title: 'Inserted',
          columns: [{ id: 'col-new', nodes: [] }],
        }),
      ),
    });
    doc.applyRebased(asSent, prepared);

    expect(findNode(doc.getCommitted(), 'a')?.title).toBe('Retitled by AI');
    expect(doc.getCommitted().sections[0].title).toBe('Inserted');
  });
});

describe('prepareAIResult with a result that is not a chart', () => {
  // Model output is not shape-checked before it gets here.
  it.each([
    ['a section whose columns are not an array', { sections: [{ title: 'S', columns: 'x' }] }],
    ['a column without nodes', { sections: [{ title: 'S', columns: [{}] }] }],
    ['a node that is not an object', { sections: [{ title: 'S', columns: [{ nodes: ['a'] }] }] }],
    ['no sections', { title: 'T' }],
  ])('throws a ChartShapeError for %s', (_label, result) => {
    expect(() => prepareAIResult(seedChart(), result as unknown as ChartInput)).toThrow(
      ChartShapeError,
    );
  });
});

describe('prepareAIResult with edge lists that are not arrays', () => {
  // The shape check lets a non-array `connections` through (stored charts have
  // them), so the reply's own copy of one must not crash the id rewrite.
  it.each([
    ['connections is null', { connections: null, connectionIds: ['c'] }],
    ['connections is a string', { connections: 'x', connectionIds: ['c'] }],
    [
      'connectionIds is a string',
      { connections: [{ targetId: 'c', confidence: 70 }], connectionIds: 'c' },
    ],
  ])('keeps the edge when %s', (_label, edges) => {
    const asSent = connectedChart();
    const result = asInput(asSent);
    Object.assign(result.sections[0].columns[0].nodes[0], edges);

    const prepared = prepareAIResult(asSent, result);

    expect(findNode(prepared, 'a')?.connections?.map((c) => c.targetId)).toEqual(['c']);
  });
});

describe('addNodePaths', () => {
  it('aiEdit_hides_container_ids_from_model', () => {
    const withPaths = addNodePaths(connectedChart());

    for (const section of withPaths.sections) {
      expect(section).not.toHaveProperty('id');
      for (const column of section.columns) expect(column).not.toHaveProperty('id');
    }
    // Node ids stay: the model refers to nodes by id in connections.
    expect(withPaths.sections[0].columns[0].nodes[0].id).toBe('a');
    expect(withPaths.sections[0].columns[0].nodes[0].connections?.[0].targetId).toBe('c');
  });

  it('leaves the chart it was given untouched', () => {
    const chart = seedChart();
    const before = structuredClone(chart);
    addNodePaths(chart);
    expect(chart).toEqual(before);
  });
});
