// Plain-object helpers over the chart wire shape. Used by the mock (seeds, event summaries) and by
// the scenarios (oracles), so both read a chart the same way.

/** Every node with where it sits: `{ id, node, section, column, index }` (indices into the chart). */
export function nodesOf(chart) {
  const out = [];
  chart.sections.forEach((section, s) =>
    section.columns.forEach((column, c) =>
      column.nodes.forEach((node, index) => out.push({ id: node.id, node, s, c, index })),
    ),
  );
  return out;
}

export function nodeById(chart, id) {
  return nodesOf(chart).find((entry) => entry.id === id);
}

/** `{ n1: 'Alpha', ... }` */
export function titles(chart) {
  return Object.fromEntries(nodesOf(chart).map((entry) => [entry.id, entry.node.title]));
}

/** `['n1->n3', ...]`, sorted; connections come from `connections` (what the app reads). */
export function connections(chart) {
  return nodesOf(chart)
    .flatMap(({ id, node }) => (node.connections ?? []).map((conn) => `${id}->${conn.targetId}`))
    .sort();
}

/** The `connections` entry of `source->target`, or undefined. */
export function connection(chart, source, target) {
  return nodeById(chart, source)?.node.connections?.find((conn) => conn.targetId === target);
}

/** `{ n1: 's1c0', ... }`: the section and column index of each node. */
export function places(chart) {
  return Object.fromEntries(nodesOf(chart).map((entry) => [entry.id, `s${entry.s}c${entry.c}`]));
}

/** Ids that appear more than once. */
export function duplicateIds(chart) {
  const seen = new Set();
  const dup = new Set();
  for (const { id } of nodesOf(chart)) (seen.has(id) ? dup : seen).add(id);
  return [...dup];
}

/**
 * The chart every scenario starts from. Two sections; the second has two columns.
 *
 *   Inputs:    [n1 Alpha, n2 Bravo]
 *   Outcomes:  [n3 Charlie, n4 Delta] [n5 Echo, n6 Foxtrot]
 *
 * with edges n1->n3, n2->n4 and n3->n5 (the last bent by a `{dx, dy}` waypoint). `ids: true` gives
 * sections and columns stored ids (as a chart saved by an up-to-date client has); `ids: false` leaves
 * them off, as every chart saved before versions has.
 */
export function seedChart({ ids }) {
  const node = (id, title, y, connections = []) => ({
    id,
    title,
    text: `Details of ${title}.`,
    connectionIds: connections.map((conn) => conn.targetId),
    connections,
    yPosition: y,
    width: 192,
    color: '#ffffff',
  });
  const withId = (id, value) => (ids ? { id, ...value } : value);
  return {
    // A short title: a long one wraps, and a wrapped title moves every node down.
    title: 'Acceptance chart',
    curvature: 0.5,
    textSize: 1,
    columnPadding: 24,
    sectionPadding: 32,
    sections: [
      withId('sec-inputs', {
        title: 'Inputs',
        columns: [
          withId('col-inputs', {
            nodes: [
              node('n1', 'Alpha', 120, [{ targetId: 'n3', confidence: 75 }]),
              node('n2', 'Bravo', 320, [{ targetId: 'n4', confidence: 75 }]),
            ],
          }),
        ],
      }),
      withId('sec-outcomes', {
        title: 'Outcomes',
        columns: [
          withId('col-outcomes-a', {
            nodes: [
              node('n3', 'Charlie', 120, [
                { targetId: 'n5', confidence: 75, waypoints: [{ dx: 40, dy: -50 }] },
              ]),
              node('n4', 'Delta', 320),
            ],
          }),
          withId('col-outcomes-b', {
            nodes: [node('n5', 'Echo', 120), node('n6', 'Foxtrot', 320)],
          }),
        ],
      }),
    ],
  };
}

/** `{ 'n1->n3': [{ dx, dy }] }` for the connections that have waypoints. */
export function waypoints(chart) {
  return Object.fromEntries(
    nodesOf(chart).flatMap(({ id, node }) =>
      (node.connections ?? [])
        .filter((conn) => conn.waypoints?.length)
        .map((conn) => [`${id}->${conn.targetId}`, conn.waypoints]),
    ),
  );
}

/** A short view of a chart for event logs, enough to tell what a save carried. */
export function summary(chart) {
  return {
    titles: titles(chart),
    places: places(chart),
    connections: connections(chart),
    waypoints: waypoints(chart),
  };
}
