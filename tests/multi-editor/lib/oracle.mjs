// Checks every scenario ends with: the pages and the server agree, and the chart is sound.
import { Checks } from './checks.mjs';
import { duplicateIds } from './chart.mjs';
import { settle } from './editors.mjs';

/**
 * Waits for the pages and server to agree, then records a loss for each way they do not or the
 * chart is unsound. Returns `{ checks, server, models }` for the scenario's own predictions.
 */
export async function settleAndCheck({ mock, token, pages, checks = new Checks(), ...options }) {
  const settled = await settle({ mock, token, pages, ...options });
  checks.ok('pages and server converge', settled.converged, settled.why);
  checks.eq('duplicate node ids on the server', duplicateIds(settled.server.chart), []);
  if (settled.models.length > 1) {
    const [first, ...rest] = settled.models;
    rest.forEach((m, i) => {
      checks.eq(
        `layout of page ${i + 1} equals page 0`,
        normaliseLayout(m.layout),
        normaliseLayout(first.layout),
      );
    });
  }
  return { checks, ...settled };
}

// Pages may differ by a pixel or two from sub-pixel rounding; compare in 4 px cells.
const normaliseLayout = (layout) =>
  Object.fromEntries(
    Object.entries(layout).map(([id, [x, y]]) => [id, [Math.round(x / 4), Math.round(y / 4)]]),
  );
