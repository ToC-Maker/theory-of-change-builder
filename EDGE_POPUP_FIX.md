# Edge Popup Modal Fix

## Problem Description

When users clicked on edges (connections between nodes) in the Theory of Change graph, a modal popup would appear to show connection details. However, there were two critical issues when the graph was scrolled horizontally:

1. **Incomplete backdrop coverage**: The greyed out background only covered the original viewport area, not the entire visible screen when scrolled
2. **Incorrect modal positioning**: The modal appeared in the wrong location relative to the current viewport

## Root Cause

The modal was using CSS `fixed` positioning with `inset-0` class, which positions elements relative to the viewport. However, when content is horizontally scrolled, this approach had limitations:

```css
/* Original problematic approach */
.fixed.inset-0 {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
}
```

The `inset-0` class only covers the original viewport bounds, not accounting for the full visible area when content extends beyond the initial viewport width.

## Solution

Modified the modal container and backdrop to use explicit viewport dimensions instead of relying on the `inset-0` utility:

### Before (Problematic Code)
```jsx
{edgePopup && (
  <div 
    className="fixed inset-0 z-50 flex items-center justify-center transition-all duration-150 ease-out"
    style={{
      animation: 'fadeIn 0.15s ease-out'
    }}
  >
    {/* Backdrop with blur */}
    <div 
      className="absolute inset-0 bg-black bg-opacity-50 backdrop-blur-sm"
      onClick={() => setEdgePopup(null)}
    />
    {/* Modal content... */}
  </div>
)}
```

### After (Fixed Code)
```jsx
{edgePopup && (
  <div 
    className="fixed z-50 flex items-center justify-center transition-all duration-150 ease-out"
    style={{
      top: 0,
      left: 0,
      width: '100vw',
      height: '100vh',
      animation: 'fadeIn 0.15s ease-out'
    }}
  >
    {/* Backdrop with blur */}
    <div 
      className="absolute bg-black bg-opacity-50 backdrop-blur-sm"
      style={{
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh'
      }}
      onClick={() => setEdgePopup(null)}
    />
    {/* Modal content... */}
  </div>
)}
```

## Key Changes

1. **Explicit viewport dimensions**: Replaced `inset-0` with explicit `width: '100vw', height: '100vh'`
2. **Consistent backdrop sizing**: Applied the same viewport dimensions to the backdrop overlay
3. **Fixed positioning anchor**: Used explicit `top: 0, left: 0` to anchor the modal to the viewport

## Technical Details

- **`100vw`**: Viewport width unit ensures the modal covers the full visible width regardless of horizontal scroll
- **`100vh`**: Viewport height unit ensures the modal covers the full visible height
- **Fixed positioning**: Maintains positioning relative to the viewport, not the scrolled content
- **Z-index**: Ensures modal appears above all other content

## Result

✅ **Backdrop coverage**: Now properly greys out the entire visible screen area  
✅ **Modal positioning**: Modal appears centered in the current viewport regardless of scroll position  
✅ **Consistent behavior**: Works reliably whether user is scrolled left, right, or at the original position  

## Files Modified

- `src/stories/ToC.tsx` - Updated modal positioning logic in the `Connections` component

## Testing

The fix was validated by:
1. Scrolling horizontally to different positions in the graph
2. Clicking on various edges to open the modal
3. Verifying that the backdrop covers the entire visible area
4. Confirming the modal appears centered in the current viewport