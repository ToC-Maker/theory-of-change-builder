// `useDismissOnOutsideEvent` — fires `onDismiss` when the user clicks
// outside a referenced container element, or presses Escape.
//
// Used by the anchored editors (`EdgeEditor`, and intended for sharing
// with `NodeEditor` over time) so the same dismissal semantics live in
// one place. The earlier inline pattern only listened to `mousedown` and
// did not handle the Escape key; surfacing both as a single hook keeps
// the editors consistent and avoids a per-component drift in semantics.
//
// We listen on `mousedown` (not `click`) so dismissal fires before any
// focus-shift the click would cause — same rationale as the original
// inline pattern in `NodeEditor`.
//
// `extraSafeRefs` lets callers exclude additional regions from the
// "outside" check (e.g. the EdgeEditor passes its anchor element so that
// clicks on the connection midpoint don't dismiss the editor that's
// anchored to it).
//
// `shouldSkipDismiss` is an optional caller-supplied predicate that gates
// the mousedown dismissal. Used by NodeEditor to keep Cmd/Ctrl+click
// multi-select on a sibling node from clearing the current selection:
// the document-level mousedown handler here fires BEFORE React's onClick,
// so without the bypass the dismissal would clear `highlightedNodes`
// before `toggleHighlight('multi')` could extend it. Keyboard dismissal
// (Escape) is intentionally NOT gated by this predicate — Escape should
// always close the editor regardless of modifier state.
//
// Edge cases:
//   - Clicks on the container itself (e.target === el) are treated as
//     inside via `Element.contains` (which returns `true` for self).
//   - Refs whose `current` is `null` at handler-call time are skipped.
//   - The handler uses `e.target instanceof Node` as the type-narrowing
//     gate so SVG / shadow-DOM targets without a parent-of relationship
//     to the document still hit `onDismiss` (they're outside any HTML
//     container by definition).

import { useEffect } from 'react';
import type { RefObject } from 'react';

interface UseDismissOnOutsideEventArgs {
  /** The editor's outer container; clicks inside are considered "in". */
  containerRef: RefObject<HTMLElement | null>;
  /** Fired on outside mousedown or Escape keydown. */
  onDismiss: () => void;
  /**
   * Additional ref(s) whose contents should ALSO count as "in" — e.g. the
   * anchor element the editor is anchored to, so a click on the source
   * affordance doesn't dismiss the editor it just opened.
   */
  extraSafeRefs?: ReadonlyArray<RefObject<HTMLElement | null>>;
  /**
   * Optional gate on the mousedown dismissal. When this returns `true`,
   * the handler skips `onDismiss` even though the click is outside the
   * safe region. Use cases: letting Cmd/Ctrl+click on a sibling node
   * extend a multi-selection without first dismissing the editor (the
   * document mousedown fires before React's onClick, so an unconditional
   * dismiss would clear the selection mid-gesture). Does NOT gate the
   * Escape handler.
   */
  shouldSkipDismiss?: (event: MouseEvent) => boolean;
}

export function useDismissOnOutsideEvent({
  containerRef,
  onDismiss,
  extraSafeRefs,
  shouldSkipDismiss,
}: UseDismissOnOutsideEventArgs): void {
  useEffect(() => {
    const isInsideSafeRegion = (target: EventTarget | null): boolean => {
      if (!(target instanceof Node)) return false;
      const container = containerRef.current;
      if (container && container.contains(target)) return true;
      if (extraSafeRefs) {
        for (const ref of extraSafeRefs) {
          const el = ref.current;
          if (el && el.contains(target)) return true;
        }
      }
      return false;
    };

    const handleMouseDown = (e: MouseEvent) => {
      if (isInsideSafeRegion(e.target)) return;
      if (shouldSkipDismiss && shouldSkipDismiss(e)) return;
      onDismiss();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Don't fight with text inputs / textareas OUTSIDE our container —
      // those have their own Escape semantics (IME composition close,
      // search field clear, etc.). We only bail when the focused element
      // is a form control we're not the parent of.
      const active = document.activeElement as HTMLElement | null;
      const container = containerRef.current;
      if (active && (!container || !container.contains(active))) {
        const isTextInput =
          active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.tagName === 'SELECT' ||
          (active as HTMLElement).isContentEditable;
        if (isTextInput) return;
      }
      e.preventDefault();
      onDismiss();
    };

    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [containerRef, onDismiss, extraSafeRefs, shouldSkipDismiss]);
}
