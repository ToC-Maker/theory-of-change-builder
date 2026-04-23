// Types for structured graph edits.
// `value` is unknown because edits come from untrusted model output; callers
// validate the shape per-field. The path helpers below walk nested objects
// or arrays, so internally they treat the current cursor as a loose
// Record-or-Array<unknown>.
export type EditInstruction =
  | { type: "update"; path: string; value: unknown }
  | { type: "delete"; path: string }
  | { type: "insert"; path: string; value: unknown }
  | { type: "push"; path: string; value: unknown }; // For adding to arrays

// Minimal shape the path walker needs: a value that might be an object, an
// array, or something else entirely. Narrowing happens at each step.
type PathCursor = Record<string, unknown> | unknown[] | null | undefined;

// Index into a PathCursor with a string key; for arrays this accepts the
// numeric string the walker receives. Returns undefined on any mismatch so
// callers can fall through to the "parent missing" path without throwing.
function indexCursor(cursor: PathCursor, key: string): unknown {
  if (cursor === null || cursor === undefined) return undefined;
  if (Array.isArray(cursor)) {
    const index = Number(key);
    return Number.isInteger(index) ? cursor[index] : undefined;
  }
  if (typeof cursor === 'object') {
    return (cursor as Record<string, unknown>)[key];
  }
  return undefined;
}

// Apply structured edits to a graph object
export function applyEdits<T>(graphData: T, edits: EditInstruction[]): T {
  if (!graphData) {
    throw new Error("Graph data is null or undefined");
  }

  if (!Array.isArray(edits)) {
    throw new Error("Edit instructions must be an array");
  }

  const updated = JSON.parse(JSON.stringify(graphData)) as T; // Deep clone

  const getAtPath = (obj: unknown, path: string[]): unknown => {
    return path.reduce<unknown>((acc, key) => indexCursor(acc as PathCursor, key), obj);
  };

  const setAtPath = (obj: unknown, path: string[], value: unknown): void => {
    const lastKey = path[path.length - 1];
    const parentPath = path.slice(0, -1);

    const target = parentPath.reduce<PathCursor>((acc, key) => {
      const current = acc as Record<string, unknown>;
      if (current[key] === undefined) {
        // If the key is numeric, create an array, otherwise create an object
        current[key] = /^\d+$/.test(key) ? [] : {};
      }
      return current[key] as PathCursor;
    }, obj as PathCursor);

    if (target && typeof target === 'object') {
      (target as Record<string, unknown>)[lastKey] = value;
    }
  };

  const insertAtIndex = (obj: unknown, path: string[], value: unknown): void => {
    if (path.length === 0) return;

    const lastKey = path[path.length - 1];
    const parentPath = path.slice(0, -1);
    const target = getAtPath(obj, parentPath);

    if (Array.isArray(target) && /^\d+$/.test(lastKey)) {
      const index = parseInt(lastKey);
      target.splice(index, 0, value); // Insert at index without replacing
    } else {
      // For non-arrays or non-numeric keys, just set the value.
      // The upstream validator (line 131) rejects insert paths that don't end
      // in a digit, so this fallback is defensive only.
      setAtPath(obj, path, value);
    }
  };

  const deleteAtPath = (obj: unknown, path: string[]): void => {
    if (path.length === 0) return;

    const lastKey = path[path.length - 1];
    const parentPath = path.slice(0, -1);
    const target = getAtPath(obj, parentPath);

    if (target && typeof target === 'object') {
      if (Array.isArray(target)) {
        const index = parseInt(lastKey);
        if (!isNaN(index)) {
          target.splice(index, 1);
        }
      } else {
        delete (target as Record<string, unknown>)[lastKey];
      }
    }
  };

  const pushToPath = (obj: unknown, path: string[], value: unknown): void => {
    const target = getAtPath(obj, path);
    if (Array.isArray(target)) {
      target.push(value);
    } else if (target === undefined) {
      // Path doesn't exist, try to create it
      const lastKey = path[path.length - 1];
      const parentPath = path.slice(0, -1);
      const parent = getAtPath(obj, parentPath);

      if (parent && typeof parent === 'object') {
        (parent as Record<string, unknown>)[lastKey] = [value]; // Create new array with the value
      } else {
        console.warn(`Cannot create array at path: ${path.join('.')}, parent doesn't exist`);
      }
    } else {
      console.warn(`Cannot push to non-array at path: ${path.join('.')}, found: ${typeof target}`);
    }
  };

  // Validate and apply each edit sequentially
  // This allows later edits to reference things created by earlier edits
  edits.forEach((edit, index) => {
    // Validate edit structure
    if (!edit.type || typeof edit.type !== 'string') {
      throw new Error(`Edit ${index}: Missing or invalid type`);
    }

    if (!edit.path || typeof edit.path !== 'string') {
      throw new Error(`Edit ${index}: Missing or invalid path`);
    }

    // Check for valid edit types
    if (!['update', 'insert', 'delete', 'push'].includes(edit.type)) {
      throw new Error(`Edit ${index}: Unknown edit type "${edit.type}"`);
    }

    // Check for invalid properties - only allow known properties
    const validProperties = ['type', 'path', 'value'];
    const editKeys = Object.keys(edit);
    const invalidProperties = editKeys.filter(key => !validProperties.includes(key));
    if (invalidProperties.length > 0) {
      throw new Error(`Edit ${index}: Invalid properties: ${invalidProperties.join(', ')}. Only 'type', 'path', and 'value' are allowed.`);
    }

    // For insert operations, the index should be part of the path, not a separate property
    if (edit.type === 'insert' && edit.path && !edit.path.match(/\.\d+$/)) {
      throw new Error(`Edit ${index}: Insert operations must specify the index in the path (e.g., "sections.2.columns.0" not "sections.2.columns")`);
    }

    // Validate path format
    const path = edit.path.split('.');
    if (path.length === 0 || path.some(segment => segment.trim() === '')) {
      throw new Error(`Edit ${index}: Invalid path format "${edit.path}"`);
    }

    // Check for invalid array indices
    const hasNegativeIndex = path.some(segment => /^-\d+$/.test(segment));
    if (hasNegativeIndex) {
      throw new Error(`Edit ${index}: Negative array indices not allowed in path "${edit.path}"`);
    }

    // Validate that the path exists in the current data structure
    try {
      const pathArray = edit.path.split('.');
      let current: unknown = updated;

      for (let i = 0; i < pathArray.length - 1; i++) {
        const segment = pathArray[i];

        if (current === null || current === undefined) {
          throw new Error(`Path segment "${segment}" leads to null/undefined`);
        }

        if (typeof current !== 'object') {
          throw new Error(`Path segment "${segment}" is not an object`);
        }

        // For array indices, check if they're within bounds
        if (/^\d+$/.test(segment)) {
          const idx = parseInt(segment);
          if (Array.isArray(current) && (idx < 0 || idx >= current.length)) {
            throw new Error(`Array index ${idx} is out of bounds (length: ${current.length})`);
          }
        }

        current = indexCursor(current as PathCursor, segment);
      }

      // For delete operations, check that the final target exists
      if (edit.type === 'delete') {
        const lastSegment = pathArray[pathArray.length - 1];
        if (current === null || current === undefined || typeof current !== 'object' || !(lastSegment in (current as Record<string, unknown>))) {
          throw new Error(`Cannot delete non-existent property "${lastSegment}"`);
        }
      }

    } catch (pathError) {
      throw new Error(`Edit ${index}: Invalid path "${edit.path}" - ${pathError instanceof Error ? pathError.message : 'Unknown path error'}`);
    }

    // Apply the edit immediately after validation
    switch (edit.type) {
      case "update":
        setAtPath(updated, path, edit.value);
        break;
      case "insert": {
        // Ensure nodes have connections array
        const insertValue = edit.value;
        if (insertValue && typeof insertValue === 'object' && 'id' in insertValue && !(insertValue as Record<string, unknown>).connections) {
          (insertValue as Record<string, unknown>).connections = [];
        }
        insertAtIndex(updated, path, insertValue);
        break;
      }
      case "delete":
        deleteAtPath(updated, path);
        break;
      case "push": {
        // Ensure nodes have connections array
        const pushValue = edit.value;
        if (pushValue && typeof pushValue === 'object' && 'id' in pushValue && !(pushValue as Record<string, unknown>).connections) {
          (pushValue as Record<string, unknown>).connections = [];
        }
        pushToPath(updated, path, pushValue);
        break;
      }
    }
  });

  return updated;
}

// Local shapes for traversal only — the real ToCData is stricter, but the
// AI sometimes hands us partial fragments during streaming, so we stay loose.
interface SummaryNode {
  id?: string
  title?: string
  color?: string
  width?: number
  yPosition?: number
  connections?: Array<{ targetId?: string; confidence?: number; evidence?: string; assumptions?: string }>
}
interface SummaryColumn {
  nodes?: SummaryNode[]
}
interface SummarySection {
  title?: string
  columns?: SummaryColumn[]
}

// Generate a summary of the graph for the AI (much smaller than full JSON)
export function generateGraphSummary(graphData: { sections?: SummarySection[] } | null | undefined): string {
  if (!graphData || !graphData.sections) {
    return "No graph data available.";
  }

  let summary = "Graph Summary:\n";
  
  graphData.sections.forEach((section, sectionIndex) => {
    summary += `\nSection ${sectionIndex} (${section.title || 'Untitled'}):\n`;

    section.columns?.forEach((column, columnIndex) => {
      if (column.nodes && column.nodes.length > 0) {
        summary += `  Column ${columnIndex}: ${column.nodes.length} nodes\n`;

        // Extract styling info from existing nodes
        const colors = [...new Set(column.nodes.map((n) => n.color).filter(Boolean))];
        const widths = [...new Set(column.nodes.map((n) => n.width).filter(Boolean))];
        const yPositions = column.nodes
          .map((n) => n.yPosition)
          .filter((y): y is number => y !== undefined);

        if (colors.length > 0) summary += `    Column colors: ${colors.join(', ')}\n`;
        if (widths.length > 0) summary += `    Column widths: ${widths.join(', ')}\n`;
        if (yPositions.length > 0) {
          const maxY = Math.max(...yPositions);
          summary += `    Y-positions: ${yPositions.join(', ')} (max: ${maxY})\n`;
        }

        column.nodes.forEach((node, nodeIndex) => {
          summary += `    - Node ${nodeIndex}: "${node.title}" (id: ${node.id}, y: ${node.yPosition || 'undefined'}, width: ${node.width || 'undefined'}, color: ${node.color || 'undefined'})\n`;
          if (node.connections && node.connections.length > 0) {
            summary += `      Connections:\n`;
            node.connections.forEach((conn, connIndex) => {
              summary += `        ${connIndex}: targetId: "${conn.targetId}", confidence: ${conn.confidence || 'undefined'}, evidence: "${conn.evidence || ''}", assumptions: "${conn.assumptions || ''}"\n`;
            });
          }
        });
      } else {
        summary += `  Column ${columnIndex}: empty\n`;
      }
    });
  });

  return summary;
}

// Parse edit instructions from AI response using JSON delimiters
export function parseEditInstructions(content: string): EditInstruction[] {
  try {
    const startMarker = '[EDIT_INSTRUCTIONS]';
    const endMarker = '[/EDIT_INSTRUCTIONS]';
    
    const startIndex = content.indexOf(startMarker);
    const endIndex = content.indexOf(endMarker);
    
    if (startIndex === -1 || endIndex === -1) {
      return [];
    }
    
    const jsonStr = content.substring(startIndex + startMarker.length, endIndex).trim();
    const editInstructions = JSON.parse(jsonStr) as EditInstruction[];

    if (import.meta.env.DEV) {
      console.log('=== PARSED EDIT INSTRUCTIONS ===');
      console.log(JSON.stringify(editInstructions, null, 2));
      console.log('=== END PARSED EDITS ===');
    }

    return Array.isArray(editInstructions) ? editInstructions : [];
  } catch (error) {
    console.error('Error parsing edit instructions:', error);
    return [];
  }
}

// Clean response content by removing edit instructions and internal context for display
export function cleanResponseContent(content: string): string {
  let cleanContent = content;

  // Remove edit instructions
  const editStartMarker = '[EDIT_INSTRUCTIONS]';
  const editEndMarker = '[/EDIT_INSTRUCTIONS]';

  const editStartIndex = cleanContent.indexOf(editStartMarker);
  const editEndIndex = cleanContent.indexOf(editEndMarker);

  if (editStartIndex !== -1 && editEndIndex !== -1) {
    cleanContent = cleanContent.substring(0, editStartIndex) + cleanContent.substring(editEndIndex + editEndMarker.length);
  }

  // Remove current graph data
  const graphStartMarker = '[CURRENT_GRAPH_DATA]';
  const graphEndMarker = '[/CURRENT_GRAPH_DATA]';

  const graphStartIndex = cleanContent.indexOf(graphStartMarker);
  const graphEndIndex = cleanContent.indexOf(graphEndMarker);

  if (graphStartIndex !== -1 && graphEndIndex !== -1) {
    cleanContent = cleanContent.substring(0, graphStartIndex) + cleanContent.substring(graphEndIndex + graphEndMarker.length);
  }

  // Remove selected nodes context
  const nodesStartMarker = '[SELECTED_NODES]';
  const nodesEndMarker = '[/SELECTED_NODES]';

  const nodesStartIndex = cleanContent.indexOf(nodesStartMarker);
  const nodesEndIndex = cleanContent.indexOf(nodesEndMarker);

  if (nodesStartIndex !== -1 && nodesEndIndex !== -1) {
    cleanContent = cleanContent.substring(0, nodesStartIndex) + cleanContent.substring(nodesEndIndex + nodesEndMarker.length);
  }

  return cleanContent.trim();
}

/**
 * Prepare content for the live streaming bubble. Differs from
 * `cleanResponseContent` in how it handles markers whose closing tag
 * hasn't arrived yet:
 *
 *   - Closed `[EDIT_INSTRUCTIONS]…[/EDIT_INSTRUCTIONS]` blocks: already
 *     stripped upstream by `cleanResponseContent`.
 *   - Open-without-close `[EDIT_INSTRUCTIONS]…` (mid-stream): strip from
 *     the opener to end-of-string AND report `generatingEdits: true` so
 *     the UI can render a "Generating edits…" indicator instead of
 *     leaking the half-built JSON to the user.
 *   - Same strip-without-flag behaviour for hallucinated `[CURRENT_GRAPH_DATA]`
 *     / `[SELECTED_NODES]` openers.
 *
 * Once the closing tag arrives in a subsequent delta, `cleanResponseContent`
 * upstream removes the whole block and this helper is a no-op.
 */
export function prepareStreamingDisplay(content: string): {
  display: string;
  generatingEdits: boolean;
} {
  let display = content;
  let generatingEdits = false;

  const openOnlyStrip = (startMarker: string, endMarker: string): boolean => {
    const startIdx = display.indexOf(startMarker);
    if (startIdx === -1) return false;
    const endIdx = display.indexOf(endMarker, startIdx + startMarker.length);
    if (endIdx !== -1) {
      // A closed pair — cleanResponseContent upstream should have handled
      // it, but strip defensively in case this helper runs against raw
      // content somewhere.
      display = display.substring(0, startIdx) + display.substring(endIdx + endMarker.length);
      return false;
    }
    display = display.substring(0, startIdx);
    return true;
  };

  if (openOnlyStrip('[EDIT_INSTRUCTIONS]', '[/EDIT_INSTRUCTIONS]')) {
    generatingEdits = true;
  }
  openOnlyStrip('[CURRENT_GRAPH_DATA]', '[/CURRENT_GRAPH_DATA]');
  openOnlyStrip('[SELECTED_NODES]', '[/SELECTED_NODES]');

  return { display: display.trim(), generatingEdits };
}