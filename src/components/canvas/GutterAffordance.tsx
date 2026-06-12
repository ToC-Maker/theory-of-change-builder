// Presentational gutter affordance — the always-on "+ Section" or
// "+ Column" click target rendered between sections/columns in edit
// mode. Lifted from TheoryOfChangeGraph where the same 24-line JSX
// block was repeated four times with shared magic numbers.
//
// Pure JSX (no hooks, no subscriptions): the parent owns the click
// handler.
//
// Height (PR #34 fb4 issue 64): the gutter carries NO explicit height.
// It is a flex item and relies on the default `align-items: stretch`
// of its flex row, so its hover zone + tint end exactly where the row's
// sizing sibling ends:
//   - kind="column" — sits in the columns row next to the column
//     bodies, whose explicit height defines the row. The gutter
//     stretches to match the bodies (the canvas content edge).
//   - kind="section" — sits in the outer canvas flex row next to the
//     section wrappers (title bar + columns row), which define that
//     row's height. The 68px top margin keeps the gutter aligned with
//     column bodies (not the section title); stretch subtracts the
//     margin automatically.
// The previous `svgSize.height - 124` explicit height overshot the
// canvas card's bottom edge (~17px column / ~6px section with a chart
// title) because the budget ignored the rendered title-block height.
//
// Variants:
//   - kind="section" — green tint, "+ Section" label, 68px top margin.
//   - kind="column" — blue tint, "+ Column" label, no top margin.

interface GutterAffordanceProps {
  kind: 'section' | 'column';
  /** Width of the gutter strip in pixels. */
  width: number;
  onClick: () => void;
  testId: string;
}

export function GutterAffordance({ kind, width, onClick, testId }: GutterAffordanceProps) {
  const isSection = kind === 'section';
  const tint = isSection ? 'hover:bg-green-500/20' : 'hover:bg-blue-500/20';
  const labelColor = isSection ? 'text-green-600' : 'text-blue-600';
  const label = isSection ? '+ Section' : '+ Column';
  const title = isSection ? 'Click to add section' : 'Click to add column';

  return (
    <div
      className={`group flex items-center justify-center cursor-pointer rounded-lg transition-colors ${tint}`}
      style={{
        width: `${width}px`,
        ...(isSection ? { marginTop: '68px' } : {}),
      }}
      onClick={onClick}
      title={title}
      data-testid={testId}
    >
      <span
        className={`${labelColor} text-xs font-medium rotate-90 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity`}
      >
        {label}
      </span>
    </div>
  );
}
