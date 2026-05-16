// `useGraphLayout` — geometry helpers for the ToC canvas.
//
// Exposes:
//   sectionWidths    — per-section width memo (extracted from
//                      TheoryOfChangeGraph.tsx:587-619).
//   columnRects      — cached column bounding rects, refreshed by a
//                      ResizeObserver wrapped in requestAnimationFrame.
//   classifyRegion   — given a local point inside the container, decide
//                      which X-axis zone the point sits in (node-slot,
//                      over-node, new-column, new-section, or null).
//                      Called only during an active drag (see Task 0.5).
//   getLocalPosition — walk the offsetParent chain to compute container-
//                      relative position. Immune to CSS zoom/transforms.
//
// ResizeObserver coalescing (Red-Team Critical "ResizeObserver
// invalidation storm during slider drags"): the observer callback wraps
// rect-cache invalidation in `requestAnimationFrame` so at most one
// re-read of `getBoundingClientRect` happens per frame regardless of
// observer fire rate. `scheduleRectRefresh` is exported for the
// dedicated regression test.
//
// Structural-mutation correctness (L5 / red-team Important "PR 5 rect
// cache staleness on structural mutation"): the hook also subscribes to
// `data.sections` shape (count + identities); on shape change, a fresh
// rAF rect refresh is scheduled before the next pointermove.
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import type { RefObject } from 'react';
import type { ToCData } from '../types';

// ---------------------------------------------------------------------------
// Pure-function types
// ---------------------------------------------------------------------------

export interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface LayoutSnapshot {
  sectionPadding: number;
  columnPadding: number;
  // columnRects[sectionIdx][columnIdx]
  columnRects: Rect[][];
  containerWidth: number;
  containerHeight: number;
  // Existing node bounding rects within each column, keyed by
  // `${sectionIdx}-${columnIdx}`. Used to detect "over-node".
  nodeRects: Record<string, Rect[]>;
}

export type Region =
  | { kind: 'node-slot'; sectionIdx: number; columnIdx: number; yPosition: number }
  | { kind: 'over-node'; sectionIdx: number; columnIdx: number }
  | { kind: 'new-column'; sectionIdx: number; columnIdx: number }
  | { kind: 'new-section'; sectionIdx: number };

// ---------------------------------------------------------------------------
// classifyRegion (pure)
// ---------------------------------------------------------------------------
//
// X-axis zone partitioning. The geometry is sequential (no overlap),
// so the algorithm walks zones left-to-right and matches the first one
// containing `x`.

export function classifyRegion(
  snap: LayoutSnapshot,
  point: { x: number; y: number },
): Region | null {
  const { columnRects } = snap;
  if (columnRects.length === 0) return null;

  // Determine the global Y range of the column area. If `y` is outside
  // the union of all column rects, treat as void.
  let minTop = Infinity;
  let maxBottom = -Infinity;
  for (const section of columnRects) {
    for (const col of section) {
      if (col.top < minTop) minTop = col.top;
      if (col.bottom > maxBottom) maxBottom = col.bottom;
    }
  }
  if (point.y < minTop || point.y > maxBottom) return null;

  // Compute section X-extents so we can detect "between sections".
  const sectionXExtents = columnRects.map((cols) => {
    if (cols.length === 0) return null;
    return {
      left: Math.min(...cols.map((c) => c.left)),
      right: Math.max(...cols.map((c) => c.right)),
    };
  });

  // Leftmost edge: X to the left of section 0's leftmost column.
  const firstSection = sectionXExtents[0];
  if (firstSection && point.x < firstSection.left) {
    return { kind: 'new-section', sectionIdx: 0 };
  }

  // Walk sections left-to-right.
  for (let sIdx = 0; sIdx < columnRects.length; sIdx++) {
    const section = columnRects[sIdx];
    const sExt = sectionXExtents[sIdx];
    if (!sExt) continue;

    // Inside this section's X range?
    if (point.x >= sExt.left && point.x <= sExt.right) {
      // Walk columns to find which one (or which gutter) contains X.
      for (let cIdx = 0; cIdx < section.length; cIdx++) {
        const col = section[cIdx];
        if (point.x >= col.left && point.x <= col.right) {
          // Inside column body. Check whether Y is over an existing node.
          const key = `${sIdx}-${cIdx}`;
          const nodes = snap.nodeRects[key] ?? [];
          const overNode = nodes.some((n) => point.y >= n.top && point.y <= n.bottom);
          if (overNode) {
            return { kind: 'over-node', sectionIdx: sIdx, columnIdx: cIdx };
          }
          return {
            kind: 'node-slot',
            sectionIdx: sIdx,
            columnIdx: cIdx,
            yPosition: point.y - col.top,
          };
        }
        // Gutter to the right of this column?
        const nextCol = section[cIdx + 1];
        if (nextCol && point.x > col.right && point.x < nextCol.left) {
          return { kind: 'new-column', sectionIdx: sIdx, columnIdx: cIdx + 1 };
        }
      }
      // Inside section X-range but not in any column or gutter — should
      // not happen if rects are contiguous, but treat as void.
      return null;
    }

    // Between this section and the next?
    const nextSection = sectionXExtents[sIdx + 1];
    if (nextSection && point.x > sExt.right && point.x < nextSection.left) {
      return { kind: 'new-section', sectionIdx: sIdx + 1 };
    }
  }

  // Past the last section's right edge.
  const lastSection = sectionXExtents[sectionXExtents.length - 1];
  if (lastSection && point.x > lastSection.right) {
    return { kind: 'new-section', sectionIdx: columnRects.length };
  }

  return null;
}

// ---------------------------------------------------------------------------
// getLocalPosition (pure)
// ---------------------------------------------------------------------------
//
// Walk the offsetParent chain summing `offsetLeft`/`offsetTop` until we
// hit the container. Uses offset* (not getBoundingClientRect) so the
// result is immune to CSS zoom/transforms on the container or ancestors.
// Ported verbatim from the inline impl previously in
// `ConnectionsComponent.tsx:698-713`.

export function getLocalPosition(
  element: HTMLElement,
  container: HTMLElement,
): { x: number; y: number; width: number; height: number } {
  let x = 0;
  let y = 0;
  const width = element.offsetWidth;
  const height = element.offsetHeight;
  let current: HTMLElement | null = element;
  while (current && current !== container) {
    x += current.offsetLeft;
    y += current.offsetTop;
    current = current.offsetParent as HTMLElement | null;
  }
  return { x, y, width, height };
}

// ---------------------------------------------------------------------------
// scheduleRectRefresh — rAF coalescing (exported for test)
// ---------------------------------------------------------------------------
//
// `state.pending` is a single-slot flag: while a rAF is in flight, more
// invalidations are collapsed into the same tick.

export interface RefreshState {
  pending: boolean;
}

export function scheduleRectRefresh(state: RefreshState, refresh: () => void): void {
  if (state.pending) return;
  state.pending = true;
  requestAnimationFrame(() => {
    state.pending = false;
    refresh();
  });
}

// ---------------------------------------------------------------------------
// sectionWidths — pure memoizable computation
// ---------------------------------------------------------------------------
//
// Extracted from `TheoryOfChangeGraph.tsx:587-619`. Same return shape
// (number[] = total width per section).

export interface SectionWidthsOptions {
  columnPadding: number;
  editMode: boolean;
}

export function computeSectionWidths(data: ToCData, opts: SectionWidthsOptions): number[] {
  if (!data.sections || !Array.isArray(data.sections)) {
    return [400];
  }
  return data.sections.map((section) => {
    const cols = section.columns;
    if (cols.length === 0) return 192;
    const columnWidths = cols.map((col) =>
      col.nodes.length === 0 ? 128 : Math.max(...col.nodes.map((n) => n.width || 192), 128),
    );
    const totalColumnWidth = columnWidths.reduce((s, w) => s + w, 0);
    // PR 5: edit mode renders the column-gutter affordances between
    // columns, so the flex `gap` between columns is 0 (gutters provide
    // their own spacing). View mode keeps the bare gaps.
    const gaps = opts.editMode ? 0 : Math.max(0, columnWidths.length - 1) * opts.columnPadding;
    return totalColumnWidth + gaps;
  });
}

// ---------------------------------------------------------------------------
// useGraphLayout — React hook
// ---------------------------------------------------------------------------
//
// Subscribes to a container ref and the data shape. Returns a memoized
// `sectionWidths` array and a `getSnapshot()` accessor for use by drag
// machinery. The actual column-rect cache lives in a ref; consumers
// (in PR 4 / PR 5) read it on pointermove without forcing a re-render.

export interface UseGraphLayoutArgs {
  data: ToCData;
  containerRef: RefObject<HTMLElement | null>;
  columnPadding: number;
  sectionPadding: number;
  editMode: boolean;
}

export interface UseGraphLayoutResult {
  sectionWidths: number[];
  /**
   * Read the current layout snapshot (rect cache + paddings). Cheap; safe
   * to call inside a pointermove handler. The returned object is a
   * shallow copy so callers can't mutate the cache.
   */
  getSnapshot: () => LayoutSnapshot;
}

export function useGraphLayout({
  data,
  containerRef,
  columnPadding,
  sectionPadding,
  editMode,
}: UseGraphLayoutArgs): UseGraphLayoutResult {
  const sectionWidths = useMemo(
    () => computeSectionWidths(data, { columnPadding, editMode }),
    [data, columnPadding, editMode],
  );

  // Rect cache lives in a ref so consumers can poll without re-rendering.
  const snapshotRef = useRef<LayoutSnapshot>({
    sectionPadding,
    columnPadding,
    columnRects: [],
    containerWidth: 0,
    containerHeight: 0,
    nodeRects: {},
  });

  // Keep paddings in the snapshot fresh.
  useEffect(() => {
    snapshotRef.current = {
      ...snapshotRef.current,
      sectionPadding,
      columnPadding,
    };
  }, [sectionPadding, columnPadding]);

  // Reads the DOM and writes the cache. Called inside rAF.
  const refresh = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const cols = Array.from(container.querySelectorAll<HTMLElement>('[data-column]'));
    // Group by sectionIdx (from data-column = "${sIdx}-${cIdx}")
    const grouped: Record<number, { cIdx: number; rect: Rect }[]> = {};
    const nodeRects: Record<string, Rect[]> = {};
    for (const el of cols) {
      const attr = el.dataset.column;
      if (!attr) continue;
      const [sStr, cStr] = attr.split('-');
      const sIdx = Number(sStr);
      const cIdx = Number(cStr);
      const r = el.getBoundingClientRect();
      const rect: Rect = {
        left: r.left - containerRect.left,
        right: r.right - containerRect.left,
        top: r.top - containerRect.top,
        bottom: r.bottom - containerRect.top,
      };
      if (!grouped[sIdx]) grouped[sIdx] = [];
      grouped[sIdx].push({ cIdx, rect });

      // Capture node rects within this column for over-node detection.
      const innerNodes = Array.from(el.children) as HTMLElement[];
      const nrects: Rect[] = innerNodes.map((nodeEl) => {
        const nr = nodeEl.getBoundingClientRect();
        return {
          left: nr.left - containerRect.left,
          right: nr.right - containerRect.left,
          top: nr.top - containerRect.top,
          bottom: nr.bottom - containerRect.top,
        };
      });
      nodeRects[`${sIdx}-${cIdx}`] = nrects;
    }
    const maxSIdx = Math.max(-1, ...Object.keys(grouped).map(Number));
    const columnRects: Rect[][] = [];
    for (let s = 0; s <= maxSIdx; s++) {
      const arr = grouped[s] ?? [];
      arr.sort((a, b) => a.cIdx - b.cIdx);
      columnRects.push(arr.map((x) => x.rect));
    }
    snapshotRef.current = {
      sectionPadding,
      columnPadding,
      columnRects,
      containerWidth: containerRect.width,
      containerHeight: containerRect.height,
      nodeRects,
    };
  }, [containerRef, sectionPadding, columnPadding]);

  // Single-slot rAF coalescing state (Red-Team Critical).
  const refreshState = useRef<RefreshState>({ pending: false });
  const requestRefresh = useCallback(() => {
    scheduleRectRefresh(refreshState.current, refresh);
  }, [refresh]);

  // Observe container + columns. ResizeObserver fires for every size
  // change; rAF coalesces them.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => requestRefresh());
    ro.observe(container);
    // Also observe each column element.
    const cols = Array.from(container.querySelectorAll<HTMLElement>('[data-column]'));
    for (const el of cols) ro.observe(el);
    // Initial seed.
    requestRefresh();
    return () => ro.disconnect();
  }, [containerRef, requestRefresh]);

  // Section-shape signature: when sections / columns are added or
  // removed, re-read rects on next frame (L5 mitigation). We hash by
  // section count + per-section column count.
  const shapeSignature = useMemo(() => {
    return data.sections.map((s) => s.columns.length).join('|');
  }, [data.sections]);

  // Re-seed when shape changes. Triggers on first mount too.
  useEffect(() => {
    requestRefresh();
  }, [shapeSignature, requestRefresh]);

  // Tracks whether anything outside React forces a re-render. We don't
  // want to force one on every rAF tick — consumers poll the ref. But
  // we DO want to surface sectionWidths changes, which is already handled
  // by the useMemo above.
  const [, _setForceRender] = useState(0);
  void _setForceRender; // currently unused; reserved for future use.

  const getSnapshot = useCallback(() => ({ ...snapshotRef.current }), []);

  return { sectionWidths, getSnapshot };
}
