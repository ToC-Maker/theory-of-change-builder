export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  // Remove # if present
  hex = hex.replace('#', '');

  if (hex.length === 3) {
    // Convert 3-digit hex to 6-digit
    hex = hex
      .split('')
      .map((char) => char + char)
      .join('');
  }

  const result = /^([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : null;
}

export function isColorDark(hexColor: string): boolean {
  const rgb = hexToRgb(hexColor);
  if (!rgb) return false;

  // Calculate relative luminance using WCAG formula
  const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;

  // Return true if color is dark (luminance < 0.5)
  return luminance < 0.5;
}

export function getContrastTextColor(backgroundColor: string): string {
  return isColorDark(backgroundColor) ? '#ffffff' : '#000000';
}

export function getConfidenceStrokeStyle(confidence: number): {
  strokeDasharray: string;
  stroke: string;
  opacity: number;
} {
  // Clamp confidence to 0-100 range
  const clampedConfidence = Math.max(0, Math.min(100, confidence));

  // Use black color for all connections
  const stroke = '#000000'; // black

  if (clampedConfidence >= 66) {
    // High confidence (66-100%): solid line
    return {
      strokeDasharray: 'none',
      stroke,
      opacity: 1.0,
    };
  } else if (clampedConfidence >= 33) {
    // Medium confidence (33-66%): dashed line
    return {
      strokeDasharray: '8 6', // 8px dash, 6px gap
      stroke,
      opacity: 0.9,
    };
  } else {
    // Low confidence (0-33%): dotted line
    return {
      strokeDasharray: '2 6', // 2px dot, 6px gap
      stroke,
      opacity: 0.8,
    };
  }
}
