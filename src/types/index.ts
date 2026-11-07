/**
 * A custom bend point, stored as a pixel offset from the midpoint of
 * the straight line between a connection's source and target anchors.
 * Relative to the nodes, so it follows them through any layout change.
 */
export interface WaypointOffset {
  dx: number;
  dy: number;
}

export interface Connection {
  targetId: string;
  confidence: number; // 0-100 scale
  evidence?: string; // Evidence supporting this connection
  assumptions?: string; // Key assumptions underlying this connection
  /**
   * Optional custom bend points as offsets from the connection's line
   * midpoint (see `WaypointOffset`; the conversion to canvas
   * coordinates lives in `src/utils/connectionGeometry.ts`). When
   * present, the connection path runs source -> waypoint -> target as
   * a multi-segment cubic bezier (one `<path>` element, see
   * `src/utils/connectionPath.ts`). When absent, empty or not made of
   * finite `{dx, dy}` entries (including the earlier absolute `{x, y}`
   * format), the renderer draws the automatic curve.
   *
   * The UI reads and writes AT MOST ONE entry. Dragging replaces the
   * whole array with the dragged waypoint, and double-clicking a
   * handle clears it (see `useWaypointDrag`).
   */
  waypoints?: WaypointOffset[];
}

export interface Node {
  id: string;
  title: string;
  text: string;
  connectionIds: string[];
  connections?: Connection[];
  yPosition?: number;
  width?: number; // Width in pixels (default 192px = w-48)
  color?: string; // Background color (default white)
}

export interface ToCData {
  title?: string; // Optional title for the theory of change
  color?: string; // Section header background color (default gray-700)
  sections: {
    title: string;
    columns: {
      nodes: Node[];
    }[];
  }[];
  textSize?: number; // Optional text size scaling factor (0.5 to 2.0)
  curvature?: number; // Optional curve shape setting (0.0 to 1.0)
  columnPadding?: number; // Optional column spacing in pixels (default 24px)
  sectionPadding?: number; // Optional section spacing in pixels (default 32px)
  fontFamily?: string; // Optional font family (default system font)
}
