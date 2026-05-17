// Presentational gutter affordance — the always-on "+ Section" or
// "+ Column" click target rendered between sections/columns in edit
// mode. Lifted from TheoryOfChangeGraph where the same 24-line JSX
// block was repeated four times with shared magic numbers (svgSize-
// based height, section marginTop, etc).
//
// Pure JSX (no hooks, no subscriptions): the parent owns the click
// handler and computes the gutter height once (the literal '740px'
// initial-render fallback used to be repeated four times — now once
// at the caller).
//
// Variants:
//   - kind="section" — green tint, "+ Section" label, 68px top
//     margin so the gutter aligns with column bodies (not the
//     section title).
//   - kind="column" — blue tint, "+ Column" label, no top margin.

interface GutterAffordanceProps {
  kind: 'section' | 'column';
  /** Width of the gutter strip in pixels. */
  width: number;
  /** Pre-computed gutter height (CSS length string). */
  height: string;
  onClick: () => void;
  testId: string;
}

export function GutterAffordance({ kind, width, height, onClick, testId }: GutterAffordanceProps) {
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
        height,
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
