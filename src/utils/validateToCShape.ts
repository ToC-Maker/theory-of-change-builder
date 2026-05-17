// Deep shape validation for imported / programmatically supplied ToC
// JSON. Walks sections → columns → nodes → connections → waypoints,
// returning `{ ok: false, reason }` with a specific path on the first
// malformation. The shallow `Array.isArray(parsed.sections)` check
// passes file shapes that would silently render as empty charts (e.g.
// `columns: "not an array"`); we walk deeper before letting the
// import overwrite the user's graph.
//
// PR 7 will add `connections[].waypoints: {x: number, y: number}[]`.
// We guard against bad coords now so the renderer never sees them
// (NaN/string coords would otherwise crash the SVG path builder).
import type { ToCData } from '../types';

export function validateToCShape(
  parsed: unknown,
): { ok: true; data: ToCData } | { ok: false; reason: string } {
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, reason: 'top-level is not an object' };
  }
  const top = parsed as { sections?: unknown };
  if (!Array.isArray(top.sections)) {
    return { ok: false, reason: 'sections is not an array' };
  }
  for (let i = 0; i < top.sections.length; i++) {
    const s = top.sections[i] as { columns?: unknown } | null;
    if (!s || typeof s !== 'object') {
      return { ok: false, reason: `sections[${i}] is not an object` };
    }
    if (!Array.isArray(s.columns)) {
      return { ok: false, reason: `sections[${i}].columns is not an array` };
    }
    for (let j = 0; j < s.columns.length; j++) {
      const c = s.columns[j] as { nodes?: unknown } | null;
      if (!c || typeof c !== 'object') {
        return { ok: false, reason: `sections[${i}].columns[${j}] is not an object` };
      }
      if (!Array.isArray(c.nodes)) {
        return { ok: false, reason: `sections[${i}].columns[${j}].nodes is not an array` };
      }
      for (let k = 0; k < c.nodes.length; k++) {
        const n = c.nodes[k] as { connections?: unknown } | null;
        if (!n || typeof n !== 'object') {
          return {
            ok: false,
            reason: `sections[${i}].columns[${j}].nodes[${k}] is not an object`,
          };
        }
        // `connections` is optional (older charts use `connectionIds`).
        // When present it must be an array of objects; waypoints (when
        // present) must be `{x: number, y: number}` with finite coords.
        if (n.connections !== undefined) {
          if (!Array.isArray(n.connections)) {
            return {
              ok: false,
              reason: `sections[${i}].columns[${j}].nodes[${k}].connections is not an array`,
            };
          }
          for (let m = 0; m < n.connections.length; m++) {
            const conn = n.connections[m] as { waypoints?: unknown } | null;
            if (!conn || typeof conn !== 'object') {
              return {
                ok: false,
                reason: `sections[${i}].columns[${j}].nodes[${k}].connections[${m}] is not an object`,
              };
            }
            if (conn.waypoints !== undefined) {
              if (!Array.isArray(conn.waypoints)) {
                return {
                  ok: false,
                  reason: `sections[${i}].columns[${j}].nodes[${k}].connections[${m}].waypoints is not an array`,
                };
              }
              for (let w = 0; w < conn.waypoints.length; w++) {
                const wp = conn.waypoints[w] as { x?: unknown; y?: unknown } | null;
                if (!wp || typeof wp !== 'object') {
                  return {
                    ok: false,
                    reason: `sections[${i}].columns[${j}].nodes[${k}].connections[${m}].waypoints[${w}] is not an object`,
                  };
                }
                if (
                  typeof wp.x !== 'number' ||
                  typeof wp.y !== 'number' ||
                  !Number.isFinite(wp.x) ||
                  !Number.isFinite(wp.y)
                ) {
                  return {
                    ok: false,
                    reason: `sections[${i}].columns[${j}].nodes[${k}].connections[${m}].waypoints[${w}] has invalid coords (expected finite numeric {x, y})`,
                  };
                }
              }
            }
          }
        }
      }
    }
  }
  return { ok: true, data: parsed as ToCData };
}
