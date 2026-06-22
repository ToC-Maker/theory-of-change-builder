// Selection switch targets for the editors' dismiss-click guard
// (PR #34 fb7 issue 77).
//
// `useDismissOnOutsideEvent` consumes the click/dblclick of the gesture
// that dismissed an editor, so closing a NodeEditor/EdgeEditor can't
// surprise-fire a canvas affordance (gutter "+ Column", double-click
// node create). But some outside presses are themselves the OPEN
// gesture of the next editor and must keep their click:
//
//   - a node root (`[data-tocb-node]`) — clicking node B while editing
//     node A selects B on React onClick (NodeComponent.handleClick →
//     toggleHighlight) and reopens the editor there. This subtree also
//     covers the node's connection-source handle dots.
//   - a connection's fat hit path (`[data-tocb-connection-hitpath]`) —
//     clicking a connection of the selected node opens its EdgeEditor
//     (ConnectionsComponent's onClick → setSelectedEdge).
//   - the waypoint/midpoint handles of a connection — manipulation
//     affordances of the object being edited: their click is a
//     stopPropagation no-op, but double-click on a waypoint handle
//     resets the curve (useWaypointDrag.resetWaypoints) and must not
//     be eaten when the press also dismissed an editor.
//
// This is deliberately the same family of selectors App.tsx's
// `excludeFromPan` treats as canvas-interactive. Both editors share
// this predicate so the switch semantics can't drift apart.

import { NODE_DOM_ATTR } from '../NodeComponent';

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
