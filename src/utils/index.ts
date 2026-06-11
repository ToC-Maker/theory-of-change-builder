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

/**
 * Confidence at or above this renders as a SOLID stroke. Below it the
 * dash geometry varies continuously (PR #34 feedback 51 — "variable
 * dash size rather than hard stops").
 */
export const CONFIDENCE_SOLID_THRESHOLD = 95;

/**
 * Continuous dash geometry for a confidence value (0-100).
 *
 * Returns `null` for the solid range (≥ CONFIDENCE_SOLID_THRESHOLD).
 * Below it, both channels vary linearly with confidence:
 *
 *   - dash length: 2px at confidence 0 → 14px just under the threshold
 *     (long dashes read as "almost solid");
 *   - gap length:  8px at confidence 0 → 2px just under the threshold
 *     (longer gaps as confidence drops).
 *
 * Both channels are monotonic and rounded to 0.1px so the emitted
 * stroke-dasharray strings stay stable. The c=0 extreme (`2 8`) reads
 * as sparse dots — close to the old "dotted" bucket; c≈50 (`8.3 4.8`)
 * is close to the old "dashed" bucket (`8 6`); just under the
 * threshold (`14 2`) is visually near-solid so crossing into the solid
 * range isn't a jarring jump. Unit-pinned in
 * `tests/frontend/confidenceStroke.test.ts`.
 */
export function computeConfidenceDash(confidence: number): { dash: number; gap: number } | null {
  const c = Math.max(0, Math.min(100, confidence));
  if (c >= CONFIDENCE_SOLID_THRESHOLD) return null;
  const t = c / CONFIDENCE_SOLID_THRESHOLD; // 0..1 across the dashed range
  const round1 = (v: number) => Math.round(v * 10) / 10;
  return {
    dash: round1(2 + t * 12),
    gap: round1(8 - t * 6),
  };
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

  const dash = computeConfidenceDash(clampedConfidence);

  return {
    strokeDasharray: dash === null ? 'none' : `${dash.dash} ${dash.gap}`,
    stroke,
    // Continuous opacity ramp 0.8 → 1.0 (replaces the old 0.8/0.9/1.0
    // bucket opacities; same range, no hard stops).
    opacity: 0.8 + 0.2 * (clampedConfidence / 100),
  };
}
