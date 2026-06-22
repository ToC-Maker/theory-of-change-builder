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
 * Below it, with t = c / 95 ∈ [0, 1):
 *
 *   - dash length: 2 + 46·t³ px  (2px dots at c=0 → ~46.6px at c=94);
 *   - gap length:  8 − 6.5·t px  (8px sparse gaps → ~1.6px at c=94).
 *
 * The dash channel is deliberately CUBIC (PR #34 round-7 feedback 79:
 * "it looks too visually different between 94 and 100"). The previous
 * linear ramp (dash 2→14, gap 8→2) left a 94-confidence stroke ~87%
 * ink — visibly dashed against the solid 95 — so the threshold read as
 * a cliff. With the cubic ramp the approach to solid is asymptotic:
 * at 94 the stroke is ~97% ink (hairline 1.6px breaks every ~46px),
 * so crossing 95 is imperceptible, while the low end keeps sparse
 * dots (c≤20 → dash ≤ 2.4 against gaps ≥ 6.6) and the middle still
 * clearly reads dashed (c=50 → `8.7 4.6`, close to the previous
 * linear map's `8.3 4.8` and the old "dashed" bucket's `8 6`).
 *
 * Both channels are monotonic and rounded to 0.1px so the emitted
 * stroke-dasharray strings stay stable. Unit-pinned in
 * `tests/frontend/confidenceStroke.test.ts`.
 */
export function computeConfidenceDash(confidence: number): { dash: number; gap: number } | null {
  const c = Math.max(0, Math.min(100, confidence));
  if (c >= CONFIDENCE_SOLID_THRESHOLD) return null;
  const t = c / CONFIDENCE_SOLID_THRESHOLD; // 0..1 across the dashed range
  const round1 = (v: number) => Math.round(v * 10) / 10;
  return {
    dash: round1(2 + 46 * t * t * t),
    gap: round1(8 - 6.5 * t),
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
