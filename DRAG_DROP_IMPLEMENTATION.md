# Drag and Drop Implementation Guide

## Overview
This document describes how drag-and-drop functionality was implemented for the Theory of Change (ToC) graph component, allowing users to move nodes between sections and columns dynamically.

## Key Components

### 1. State Management
Added new state variables to the main `ToC` component:

```typescript
const [data, setData] = useState<ToCData>(initialData)
const [draggedNode, setDraggedNode] = useState<Node | null>(null)
const [dragOverLocation, setDragOverLocation] = useState<{
  sectionIndex: number
  columnIndex: number
} | null>(null)
```

### 2. Drag Event Handlers

#### `handleDragStart(node: Node)`
- Sets the currently dragged node
- Called when user starts dragging a node

#### `handleDragEnd()`
- Clears drag state
- Called when drag operation completes

#### `handleDragOver(sectionIndex: number, columnIndex: number)`
- Updates visual feedback for drop zones
- Shows which column is being hovered over

#### `handleDrop(targetSectionIndex: number, targetColumnIndex: number)`
- Finds current location of dragged node
- Removes node from source location
- Adds node to target location
- Updates the data structure

### 3. Drop Zone Implementation

Each column container includes drag-and-drop event handlers:

```typescript
<div 
  className={clsx(
    "flex-1 min-h-96 p-2 rounded-lg border-2 border-dashed transition-colors",
    dragOverLocation?.sectionIndex === sectionIndex && dragOverLocation?.columnIndex === colIndex
      ? "border-blue-400 bg-blue-50"
      : "border-transparent"
  )}
  onDragOver={(e) => {
    e.preventDefault()
    handleDragOver(sectionIndex, colIndex)
  }}
  onDrop={(e) => {
    e.preventDefault()
    handleDrop(sectionIndex, colIndex)
  }}
>
```

### 4. Node Drag Implementation

Updated the `Node` component to support dragging:

```typescript
<div
  draggable
  onDragStart={(e) => {
    onDragStart(node)
    e.dataTransfer.effectAllowed = "move"
  }}
  onDragEnd={onDragEnd}
  className={clsx(
    "flex border rounded-lg cursor-pointer transition-all",
    isDragging && "opacity-50 scale-95 shadow-lg"
  )}
>
```

## Visual Feedback

### Drop Zones
- **Invisible by default**: `border-transparent`
- **Highlighted on hover**: Blue border and background (`border-blue-400 bg-blue-50`)
- **Minimum height**: `min-h-96` ensures drop zones are always visible

### Dragged Nodes
- **Semi-transparent**: `opacity-50`
- **Scaled down**: `scale-95`
- **Shadow effect**: `shadow-lg`
- **Smooth transitions**: `transition-all`

## Data Structure Updates

The drag-and-drop system preserves the existing data structure while enabling real-time updates:

1. **Find source location**: Loop through sections and columns to locate the dragged node
2. **Remove from source**: Filter out the dragged node from its current location
3. **Add to target**: Push the node to the target column
4. **Update state**: Set the new data structure to trigger re-render

## Key Features

- **Real-time updates**: Changes are immediately reflected in the UI
- **Visual feedback**: Clear indication of drag state and drop zones
- **Preserves connections**: Node relationships remain intact after moving
- **Prevents invalid drops**: Same-location drops are ignored
- **Smooth animations**: CSS transitions provide polished user experience

## Browser Compatibility

Uses standard HTML5 drag-and-drop API:
- `draggable` attribute
- `onDragStart`, `onDragEnd`, `onDragOver`, `onDrop` events
- `e.dataTransfer.effectAllowed` for cursor feedback
- `e.preventDefault()` to enable drop zones

## Future Enhancements

Potential improvements:
- Add keyboard accessibility (arrow keys + space/enter)
- Implement undo/redo functionality
- Add validation rules for node placement
- Export/import modified graph structures
- Multi-select drag operations