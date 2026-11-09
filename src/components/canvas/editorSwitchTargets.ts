// Click-through rules for the editors' dismiss-click guard (PR #34 fb7
// issue 77).
//
// `useDismissOnOutsideEvent` consumes the click/dblclick of the gesture
// that dismissed an editor, so closing a NodeEditor/EdgeEditor can't
// surprise-fire a canvas affordance (gutter "+ Column", double-click
// node create). The guard exists for the canvas only. Two kinds of
// outside press keep their click:
//
// 1. Presses OUTSIDE the canvas — the top bar and its menus, the chat
//    panel, zoom controls, dialogs. These are explicit actions with no
//    surprise to guard against, so the first press must act (File opens
//    on one click, not two). The canvas is the `[data-tocb-canvas]`
//    root that `ToC` renders.
//
// 2. Selection switch targets INSIDE the canvas, where the press is the
//    OPEN gesture of the next editor:
//
//   - a node root (`[data-tocb-node]`) — clicking node B while editing
//     node A selects B on React onClick (NodeComponent.handleClick →
//     toggleHighlight) and reopens the editor there. This subtree also
//     covers the node's connection-source handle dots.
//   - a connection's fat hit path (`[data-tocb-connection-hitpath]`) —
//     clicking a connection of the selected node opens its EdgeEditor
//     (ConnectionsComponent's onClick → setSelectedEdge).
//   - the waypoint/midpoint handles of a connection — manipulation
//     affordances of the object being edited: a click on either is a
//     stopPropagation no-op, but a press on the midpoint that doesn't
//     become a drag opens the connection's editor (useWaypointDrag's
//     tap handler, on pointerup), and double-click on a waypoint
//     handle resets the curve (useWaypointDrag.resetWaypoints) and
//     must not be eaten when the press also dismissed an editor.
//
// The switch-target selectors are deliberately the same family App.tsx's
// `excludeFromPan` treats as canvas-interactive. Both editors share
// `isClickThroughOnDismiss` so the rule can't diverge between them.

import { NODE_DOM_ATTR } from '../NodeComponent';

/**
 * DOM attribute the canvas root (`ToC`'s outermost element) carries.
 * Hoisted next to its reader (not the writer, as `NODE_DOM_ATTR` is)
 * because `ToC` already imports from `canvas/`, while importing `ToC`
 * here would close an import cycle through the editors.
 */
export const CANVAS_DOM_ATTR = 'data-tocb-canvas';

const EDITOR_SWITCH_TARGET_SELECTOR = [
  `[${NODE_DOM_ATTR}]`,
  '[data-tocb-connection-hitpath]',
  '[data-tocb-waypoint-handle]',
  '[data-tocb-midpoint-handle]',
  '[data-tocb-waypoint-handles]',
].join(', ');

/**
 * True when the dismissing press landed on a selection switch target —
 * the press's follow-up click should pass through the swallow guard
 * and perform its selection (switch editors / drag handles).
 */
export function isEditorSwitchTarget(event: MouseEvent): boolean {
  const target = event.target as Element | null;
  return Boolean(target?.closest?.(EDITOR_SWITCH_TARGET_SELECTOR));
}

/**
 * True when the dismissing press's follow-up click must pass through
 * the swallow guard: the press landed outside the canvas (an explicit
 * control) or on a selection switch target inside it. Only a press on
 * canvas content that is not a switch target (gutters, column bodies,
 * the title) has its click consumed.
 */
export function isClickThroughOnDismiss(event: MouseEvent): boolean {
  const target = event.target as Element | null;
  return !target?.closest?.(`[${CANVAS_DOM_ATTR}]`) || isEditorSwitchTarget(event);
}
