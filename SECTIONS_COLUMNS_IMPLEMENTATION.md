# Sections with Columns Implementation Guide

## Overview
This document describes how the original single-column structure was transformed into a flexible sections-with-columns architecture, allowing nodes within the same logical section to be placed side-by-side.

## Original Structure vs New Structure

### Before: Simple Columns
```typescript
interface ToCData {
  columns: {
    title: string
    nodes: Node[]
  }[]
}
```

### After: Sections with Nested Columns
```typescript
interface ToCData {
  sections: {
    title: string
    columns: {
      nodes: Node[]
    }[]
  }[]
}
```

## Key Changes

### 1. Data Structure Transformation

**Original**: Linear column structure
- Each column had a title and nodes
- No grouping mechanism for related concepts

**New**: Hierarchical section structure
- Sections represent logical groupings (e.g., "Early Changes", "Outcomes")
- Each section contains multiple columns for side-by-side placement
- Columns within a section share the same logical phase

### 2. Rendering Logic Updates

#### Original Rendering
```typescript
{data.columns.map((column, columnIndex) => (
  <div key={columnIndex} className="flex-1">
    <h2>{column.title}</h2>
    <div className="flex flex-col gap-2">
      {column.nodes.map((node) => (
        <Node key={node.id} node={node} />
      ))}
    </div>
  </div>
))}
```

#### New Rendering
```typescript
{data.sections.map((section, sectionIndex) => (
  <div key={sectionIndex} className="flex-1">
    <h2>{section.title}</h2>
    <div className="flex gap-8">
      {section.columns.map((column, colIndex) => (
        <div key={colIndex} className="flex-1">
          <div className="flex flex-col gap-4">
            {column.nodes.map((node) => (
              <Node key={node.id} node={node} />
            ))}
          </div>
        </div>
      ))}
    </div>
  </div>
))}
```

### 3. Connection Logic Updates

#### Original Connection Finding
```typescript
const nodeColumnIndex = data.columns.findIndex((col) =>
  col.nodes.some((n) => n.id === nodeId)
)
```

#### New Connection Finding
```typescript
const findNodeLocation = (nodeId: string) => {
  for (let sectionIndex = 0; sectionIndex < data.sections.length; sectionIndex++) {
    for (let columnIndex = 0; columnIndex < data.sections[sectionIndex].columns.length; columnIndex++) {
      const node = data.sections[sectionIndex].columns[columnIndex].nodes.find((n) => n.id === nodeId)
      if (node) {
        return { sectionIndex, columnIndex, node }
      }
    }
  }
  return null
}
```

### 4. Edge Routing Updates

#### Original Edge Positioning
```typescript
const startX = (sourceColumnIndex < targetColumnIndex ? startRect.right : startRect.left)
const endX = (targetColumnIndex > sourceColumnIndex ? endRect.left : endRect.right)
```

#### New Edge Positioning
```typescript
// Always consistent left-to-right flow
const startX = startRect.right  // Always right side of source
const endX = endRect.left       // Always left side of target
```

## Layout Architecture

### Section-Level Layout
- **Horizontal arrangement**: Sections flow left to right
- **Equal width**: Each section takes equal space (`flex-1`)
- **Increased spacing**: `gap-32` (128px) between sections

### Column-Level Layout  
- **Horizontal arrangement**: Columns within sections flow left to right
- **Equal width**: Each column takes equal space within its section
- **Moderate spacing**: `gap-8` (32px) between columns

### Node-Level Layout
- **Vertical arrangement**: Nodes stack vertically within columns
- **Even distribution**: `justify-evenly` spreads nodes across available height
- **Consistent spacing**: `gap-4` (16px) between nodes

## Benefits of New Structure

### 1. Logical Grouping
- Related concepts can be grouped in the same section
- Clear visual separation between different phases/stages

### 2. Side-by-Side Placement
- Multiple pathways within the same logical phase
- Better representation of parallel processes
- Reduced visual clutter

### 3. Improved Flow Control
- Prevents backward edges within sections
- Ensures left-to-right progression
- Better adherence to causal relationships

### 4. Flexible Layout
- Variable number of columns per section
- Sections can have different column counts
- Accommodates different content densities

## Data Migration Process

### 1. Restructure Existing Data
Convert from flat column structure to nested sections:

```typescript
// Original data
const originalData = {
  columns: [
    { title: "Approaches", nodes: [...] },
    { title: "Early Changes", nodes: [...] },
    { title: "Outcomes", nodes: [...] }
  ]
}

// Migrated data
const newData = {
  sections: [
    { 
      title: "Approaches", 
      columns: [{ nodes: [...] }] 
    },
    { 
      title: "Early Changes", 
      columns: [
        { nodes: [supply-side nodes] },
        { nodes: [demand-side nodes] },
        { nodes: [welfare nodes] }
      ] 
    },
    { 
      title: "Outcomes", 
      columns: [{ nodes: [...] }] 
    }
  ]
}
```

### 2. Update Component Props
Change component interface to accept sections instead of columns:

```typescript
// Before
export function ToC({ data }: { data: { columns: Column[] } })

// After  
export function ToC({ data }: { data: { sections: Section[] } })
```

### 3. Update All References
- Connection finding algorithms
- Highlighting logic
- Hover detection
- Edge rendering

## Edge Flow Improvements

### Backward Edge Prevention
The new structure enables better control of edge direction:

1. **Within sections**: Edges flow left-to-right between columns
2. **Between sections**: Edges always flow to later sections
3. **Consistent routing**: All edges use right-to-left connection points

### Example Fix
**Problem**: "Plant-based norms" → "Increased alternatives" created backward flow

**Solution**: Move nodes to proper columns to ensure left-to-right flow:
- "Increased alternatives" (Column 2) → "Plant-based norms" (Column 3)

## Future Enhancements

### Potential Improvements
- **Dynamic column creation**: Add/remove columns within sections
- **Section reordering**: Drag sections to reorder them
- **Column width control**: Adjust relative column widths
- **Nested sections**: Support for sub-sections within sections
- **Validation rules**: Enforce flow direction constraints