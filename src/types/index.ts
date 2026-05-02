export interface Connection {
  targetId: string;
  confidence: number; // 0-100 scale
  evidence?: string; // Evidence supporting this connection
  assumptions?: string; // Key assumptions underlying this connection
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
