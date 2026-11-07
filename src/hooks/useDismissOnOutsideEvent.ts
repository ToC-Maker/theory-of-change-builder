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
// ---------------------------------------------------------------------------
// Swallow-next-click guard (PR #34 fb7 issue 77)
// ---------------------------------------------------------------------------
//
// Dismissal fires on MOUSEDOWN, but canvas affordances act on CLICK
// (gutter "+ Column"/"+ Section") or DBLCLICK (column-body node
// create). Those are separate events of the same physical gesture, so
// stopping one does not suppress the other — before this guard, the
// click that dismissed an editor ALSO fired whatever affordance it
// landed on (close modal → surprise-create a column).
//
// When the mousedown path here actually dismisses, we register
// ONE-SHOT capture-phase `click` + `dblclick` listeners on `document`
// that consume (preventDefault + stopPropagation) the gesture's
// follow-up events, then remove themselves. Standard popover
// light-dismiss semantics: the first click only closes; a second click
// performs canvas actions.
//
// Safety rails so an unrelated later click is never eaten:
//   - one-shot per event type (first click / first dblclick only);
//   - a position sanity check (the consumed event must land within
//     SWALLOW_RADIUS_PX per axis of the dismissing press — a press
//     that turned into a drag/pan produces its click far away, which
//     passes through);
//   - a SWALLOW_TIMEOUT_MS timer that disarms everything.
//
// The guard is module-scoped, NOT effect-scoped: the dismissal usually
// unmounts the editor (and so this hook) before the gesture's click
// even fires; tying the listeners to the effect cleanup would tear
// them down too early. At most one guard is armed at a time (a newer
// dismissal supersedes any pending one).
//
// `allowClickThroughOnDismiss` (see arg docs) exempts selection switch
// targets: clicking node B while editing node A must dismiss A's
// editor AND let the click select B (reopen on B) in one gesture.
// Escape dismissal arms nothing — there's no press, so there's nothing
// to swallow.
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

/**
 * How long after the dismissing press the swallow guard stays armed.
 * Long enough to cover the gesture's own click + dblclick (the second
 * click of a double-click typically lands well under 500ms after the
 * first press), short enough that an unrelated later click is safe.
 */
const SWALLOW_TIMEOUT_MS = 500;

/**
 * Per-axis slop between the dismissing press and the follow-up
 * click/dblclick for them to count as the same gesture. Generous
 * compared to drag thresholds (4px) on purpose: a sloppy press that
 * wobbles a few px still fires the underlying affordance's onClick, so
 * a tight radius would let the dismiss-click double as a canvas action
 * again. 24px matches the platform's minimum-touch-target convention.
 */
const SWALLOW_RADIUS_PX = 24;

/** Disarms the currently-armed guard, if any. Module-level singleton. */
let disarmActiveSwallowGuard: (() => void) | null = null;

/** Test-only: disarm any pending swallow-next-click guard so a guard
 * armed in one test can't eat a click fired by the next test (jsdom
 * shares `document` across tests within a file). */
export function _resetSwallowNextClickGuardForTest(): void {
  disarmActiveSwallowGuard?.();
}

function armSwallowNextClickGuard(press: MouseEvent): void {
  // A newer dismissal supersedes any pending guard.
  disarmActiveSwallowGuard?.();

  const pressX = press.clientX;
  const pressY = press.clientY;
  const isSameGesture = (e: MouseEvent): boolean =>
    Math.abs(e.clientX - pressX) <= SWALLOW_RADIUS_PX &&
    Math.abs(e.clientY - pressY) <= SWALLOW_RADIUS_PX;

  const swallowOnce = (e: MouseEvent): void => {
    if (isSameGesture(e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  // Each listener is one-shot independently: the gesture's click is
  // consumed without disarming the dblclick listener, so a double-click
  // that dismissed an editor doesn't fall through to the node-create
  // path either. (Its SECOND single click deliberately passes — "a
  // second click performs canvas actions".)
  const onClick = (e: MouseEvent): void => {
    document.removeEventListener('click', onClick, true);
    swallowOnce(e);
  };
  const onDblClick = (e: MouseEvent): void => {
    document.removeEventListener('dblclick', onDblClick, true);
    swallowOnce(e);
  };

  const timer = setTimeout(() => disarm(), SWALLOW_TIMEOUT_MS);
  const disarm = (): void => {
    clearTimeout(timer);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('dblclick', onDblClick, true);
    if (disarmActiveSwallowGuard === disarm) disarmActiveSwallowGuard = null;
  };

  // Capture phase so we run before React's root-delegated handlers and
  // any element-level listeners.
  document.addEventListener('click', onClick, true);
  document.addEventListener('dblclick', onDblClick, true);
  disarmActiveSwallowGuard = disarm;
}

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
  /**
   * Optional gate on the swallow-next-click guard, evaluated against
   * the dismissing mousedown. By default a mousedown dismissal consumes
   * the same gesture's `click` and `dblclick` (see the guard section in
   * the file header). Return `true` to let the gesture's click pass
   * through instead — used for selection switch targets (nodes,
   * connection hit paths) where the click must still select/open the
   * next editor in one gesture rather than being eaten.
   */
  allowClickThroughOnDismiss?: (event: MouseEvent) => boolean;
}

export function useDismissOnOutsideEvent({
  containerRef,
  onDismiss,
  extraSafeRefs,
  shouldSkipDismiss,
  allowClickThroughOnDismiss,
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
      // The dismissing gesture's click/dblclick must not double as a
      // canvas action — unless the caller marks the press target as a
      // selection switch target (then the click is the NEXT editor's
      // open gesture and must survive).
      if (!(allowClickThroughOnDismiss && allowClickThroughOnDismiss(e))) {
        armSwallowNextClickGuard(e);
      }
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
  }, [containerRef, onDismiss, extraSafeRefs, shouldSkipDismiss, allowClickThroughOnDismiss]);
}
