// `useGraphLayout` — geometry helpers for the ToC canvas.
//
// Exposes:
//   sectionWidths    — per-section width memo (extracted from
//                      TheoryOfChangeGraph.tsx:587-619).
//   getLocalPosition — walk the offsetParent chain to compute container-
//                      relative position. Immune to CSS zoom/transforms.
//
// ResizeObserver coalescing (Red-Team Critical "ResizeObserver
// invalidation storm during slider drags"): the observer callback wraps
// rect-cache invalidation in `requestAnimationFrame` so at most one
// re-read of `getBoundingClientRect` happens per frame regardless of
// observer fire rate.
//
// Structural-mutation correctness (L5 / red-team Important "PR 5 rect
// cache staleness on structural mutation"): the hook subscribes to
// `data.sections` shape (count); on shape change, a fresh rAF rect
// refresh is scheduled.
import { useEffect, useMemo, useRef, useCallback } from 'react';
import type { RefObject } from 'react';
import type { ToCData } from '../types';

// ---------------------------------------------------------------------------
// Pure-function types
// ---------------------------------------------------------------------------

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface LayoutSnapshot {
  sectionPadding: number;
  columnPadding: number;
  // columnRects[sectionIdx][columnIdx]
  columnRects: Rect[][];
  containerWidth: number;
  containerHeight: number;
}

// ---------------------------------------------------------------------------
// getLocalPosition (pure)
// ---------------------------------------------------------------------------
//
// Walk the offsetParent chain summing `offsetLeft`/`offsetTop` until we
// hit the container. Uses offset* (not getBoundingClientRect) so the
// result is immune to CSS zoom/transforms on the container or ancestors.
// Migrated from three near-identical inline copies in
// `ConnectionsComponent.tsx` and `TheoryOfChangeGraph.tsx`.

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
// scheduleRectRefresh — rAF coalescing (internal)
// ---------------------------------------------------------------------------
//
// `state.pending` is a single-slot flag: while a rAF is in flight, more
// invalidations are collapsed into the same tick.

interface RefreshState {
  pending: boolean;
}

function scheduleRectRefresh(state: RefreshState, refresh: () => void): void {
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
  layoutMode: boolean;
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
    const gaps =
      opts.editMode && opts.layoutMode
        ? 0
        : Math.max(0, columnWidths.length - 1) * opts.columnPadding;
    return totalColumnWidth + gaps;
  });
}

// ---------------------------------------------------------------------------
// useGraphLayout — React hook
// ---------------------------------------------------------------------------
//
// Subscribes to a container ref and the data shape. Returns a memoized
// `sectionWidths` array. The internal column-rect cache lives in a ref
// and is refreshed via a rAF-coalesced ResizeObserver; no current
// consumer reads it (the drag machinery in PR 4 / PR 5 will).

export interface UseGraphLayoutArgs {
  data: ToCData;
  containerRef: RefObject<HTMLElement | null>;
  columnPadding: number;
  sectionPadding: number;
  editMode: boolean;
  layoutMode: boolean;
}

export interface UseGraphLayoutResult {
  sectionWidths: number[];
}

export function useGraphLayout({
  data,
  containerRef,
  columnPadding,
  sectionPadding,
  editMode,
  layoutMode,
}: UseGraphLayoutArgs): UseGraphLayoutResult {
  const sectionWidths = useMemo(
    () => computeSectionWidths(data, { columnPadding, editMode, layoutMode }),
    [data, columnPadding, editMode, layoutMode],
  );

  // Rect cache lives in a ref so future consumers can poll without
  // re-rendering. Populated by `refresh()` below.
  const snapshotRef = useRef<LayoutSnapshot>({
    sectionPadding,
    columnPadding,
    columnRects: [],
    containerWidth: 0,
    containerHeight: 0,
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

  return { sectionWidths };
}
