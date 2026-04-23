// Types for structured graph edits
export type EditInstruction =
  | { type: "update"; path: string; value: any }
  | { type: "delete"; path: string }
  | { type: "insert"; path: string; value: any }
  | { type: "push"; path: string; value: any }; // For adding to arrays

// Apply structured edits to a graph object
export function applyEdits(graphData: any, edits: EditInstruction[]): any {
  if (!graphData) {
    throw new Error("Graph data is null or undefined");
  }
  
  if (!Array.isArray(edits)) {
    throw new Error("Edit instructions must be an array");
  }
  
  let updated = JSON.parse(JSON.stringify(graphData)); // Deep clone
  const errors: string[] = [];

  const getAtPath = (obj: any, path: string[]): any => {
    return path.reduce((acc, key) => {
      if (acc === null || acc === undefined) return undefined;
      return acc[key];
    }, obj);
  };

  const setAtPath = (obj: any, path: string[], value: any): void => {
    const lastKey = path[path.length - 1];
    const parentPath = path.slice(0, -1);
    
    const target = parentPath.reduce((acc, key) => {
      if (acc[key] === undefined) {
        // If the key is numeric, create an array, otherwise create an object
        acc[key] = /^\d+$/.test(key) ? [] : {};
      }
      return acc[key];
    }, obj);
    
    target[lastKey] = value;
  };

  const insertAtIndex = (obj: any, path: string[], value: any): void => {
    if (path.length === 0) return;
    
    const lastKey = path[path.length - 1];
    const parentPath = path.slice(0, -1);
    const target = getAtPath(obj, parentPath);
    
    if (Array.isArray(target) && /^\d+$/.test(lastKey)) {
      const index = parseInt(lastKey);
      target.splice(index, 0, value); // Insert at index without replacing
    } else if (path.length === 1 && lastKey === 'sections') {
      // Special case: inserting at root sections array
      if (Array.isArray(obj.sections)) {
        obj.sections.splice(0, 0, value); // Insert at beginning
      } else {
        console.error('Cannot insert into sections: not an array');
      }
    } else {
      // For non-arrays or non-numeric keys, just set the value
      setAtPath(obj, path, value);
    }
  };

  const deleteAtPath = (obj: any, path: string[]): void => {
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
        delete target[lastKey];
      }
    }
  };

  const pushToPath = (obj: any, path: string[], value: any): void => {
    const target = getAtPath(obj, path);
    if (Array.isArray(target)) {
      target.push(value);
    } else if (target === undefined) {
      // Path doesn't exist, try to create it
      const lastKey = path[path.length - 1];
      const parentPath = path.slice(0, -1);
      const parent = getAtPath(obj, parentPath);
      
      if (parent && typeof parent === 'object') {
        parent[lastKey] = [value]; // Create new array with the value
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
      let current = updated;

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
          const index = parseInt(segment);
          if (Array.isArray(current) && (index < 0 || index >= current.length)) {
            throw new Error(`Array index ${index} is out of bounds (length: ${current.length})`);
          }
        }

        current = current[segment];
      }

      // For delete operations, check that the final target exists
      if (edit.type === 'delete') {
        const lastSegment = pathArray[pathArray.length - 1];
        if (current === null || current === undefined || !(lastSegment in current)) {
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
      case "insert":
        // Ensure nodes have connections array
        if (edit.value && typeof edit.value === 'object' && 'id' in edit.value && !edit.value.connections) {
          edit.value.connections = [];
        }
        insertAtIndex(updated, path, edit.value);
        break;
      case "delete":
        deleteAtPath(updated, path);
        break;
      case "push":
        // Ensure nodes have connections array
        if (edit.value && typeof edit.value === 'object' && 'id' in edit.value && !edit.value.connections) {
          edit.value.connections = [];
        }
        pushToPath(updated, path, edit.value);
        break;
    }
  });

  return updated;
}

// Generate a summary of the graph for the AI (much smaller than full JSON)
export function generateGraphSummary(graphData: any): string {
  if (!graphData || !graphData.sections) {
    return "No graph data available.";
  }

  let summary = "Graph Summary:\n";
  
  graphData.sections.forEach((section: any, sectionIndex: number) => {
    summary += `\nSection ${sectionIndex} (${section.title || 'Untitled'}):\n`;
    
    section.columns?.forEach((column: any, columnIndex: number) => {
      if (column.nodes && column.nodes.length > 0) {
        summary += `  Column ${columnIndex}: ${column.nodes.length} nodes\n`;
        
        // Extract styling info from existing nodes
        const colors = [...new Set(column.nodes.map((n: any) => n.color).filter(Boolean))];
        const widths = [...new Set(column.nodes.map((n: any) => n.width).filter(Boolean))];
        const yPositions = column.nodes.map((n: any) => n.yPosition).filter(n => n !== undefined);
        
        if (colors.length > 0) summary += `    Column colors: ${colors.join(', ')}\n`;
        if (widths.length > 0) summary += `    Column widths: ${widths.join(', ')}\n`;
        if (yPositions.length > 0) {
          const maxY = Math.max(...yPositions);
          summary += `    Y-positions: ${yPositions.join(', ')} (max: ${maxY})\n`;
        }
        
        column.nodes.forEach((node: any, nodeIndex: number) => {
          summary += `    - Node ${nodeIndex}: "${node.title}" (id: ${node.id}, y: ${node.yPosition || 'undefined'}, width: ${node.width || 'undefined'}, color: ${node.color || 'undefined'})\n`;
          if (node.connections && node.connections.length > 0) {
            summary += `      Connections:\n`;
            node.connections.forEach((conn: any, connIndex: number) => {
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
    
    console.log('=== PARSED EDIT INSTRUCTIONS ===');
    console.log(JSON.stringify(editInstructions, null, 2));
    console.log('=== END PARSED EDITS ===');
    
    return Array.isArray(editInstructions) ? editInstructions : [];
  } catch (error) {
    console.error('Error parsing edit instructions:', error);
    return [];
  }
}

// Clean response content by removing structured blocks that the display
// shouldn't expose (edit instructions, graph data echo, selected-nodes echo).
//
// Handles the mid-stream case: when only the start marker is present (the
// close hasn't arrived yet), strip from the start to end-of-string. Otherwise
// mid-stream responses show raw `[EDIT_INSTRUCTIONS]` + half-formed JSON in
// the chat bubble until the closing tag lands. When the closer eventually
// arrives, subsequent cleanResponseContent calls trim the whole block.
export function cleanResponseContent(content: string): string {
  let cleanContent = content;

  const markerPairs: ReadonlyArray<readonly [string, string]> = [
    ['[EDIT_INSTRUCTIONS]', '[/EDIT_INSTRUCTIONS]'],
    ['[CURRENT_GRAPH_DATA]', '[/CURRENT_GRAPH_DATA]'],
    ['[SELECTED_NODES]', '[/SELECTED_NODES]'],
  ];

  for (const [startMarker, endMarker] of markerPairs) {
    const startIdx = cleanContent.indexOf(startMarker);
    if (startIdx === -1) continue;
    const endIdx = cleanContent.indexOf(endMarker, startIdx + startMarker.length);
    const cutEnd = endIdx !== -1 ? endIdx + endMarker.length : cleanContent.length;
    cleanContent = cleanContent.substring(0, startIdx) + cleanContent.substring(cutEnd);
  }

  return cleanContent.trim();
}