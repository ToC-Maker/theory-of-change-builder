// PR 5 Task 5.3: hover-revealed delete affordance for columns and
// sections.
//
// Replaces the layoutMode red-state "click to delete" path from
// before PR 5. The delete button:
//   - Sits in the top-right corner of the column / section.
//   - Is hidden by default, revealed when the surrounding column /
//     section is hovered (CSS `:group-hover` — no JS hover tracking).
//   - Click opens a `ConfirmModal` describing what will be deleted,
//     including the affected node count for non-empty targets.
//   - Confirm → fires `onDelete()`. Cancel → modal closes, no-op.
//
// PR 7 round-2 feedback (issue 54): the glyph is a bare trash/bin icon
// (clearer "delete" semantics than ×) with NO background, border, or
// shadow in any state — reviewer: "the delete icons shouldn't have a
// background and outline, just the cross, and maybe we should just use
// a bin". The padded hit area stays generous (28×28px) but is fully
// transparent. Tone is scope-dependent for contrast: the section
// button lives on the dark title bar (white icon, matching the title
// text), the column button on the light canvas (gray, hover-to-red).
// Keyboard focus keeps a visible indicator via `focus-visible:ring-2`
// + `focus-visible:opacity-100` — a focus ring is not the resting
// outline the reviewer objected to.
//
// `window.confirm()` is intentionally not used (red-team L4) — the
// React modal keeps the event loop responsive, gives screen-reader
// announcements, and is keyboard-navigable.
//
// PR 7 feedback (task 8): use Tailwind *named* groups (`group/column`,
// `group/section` with `group-hover/column:` / `group-hover/section:`)
// instead of the anonymous `group` / `group-hover:` selector. The
// anonymous version matches when ANY ancestor with `.group` is
// hovered, so hovering a column also fires the section's delete
// button (the section wraps the columns and carries its own `.group`)
// and every sibling column's (their `.group` is descended from the
// same section). Named groups scope hover-reveal to the specific
// level the affordance belongs to.

import { useState } from 'react';
import { TrashIcon } from '@heroicons/react/24/outline';
import { ConfirmModal } from '../ConfirmModal';

export interface ColumnDeleteAffordanceProps {
  /** Number of nodes the column / section currently contains. */
  nodeCount: number;
  /** Label noun used in the modal copy. `"column"` or `"section"`. */
  scope: 'column' | 'section';
  /**
   * Called when the user confirms the deletion. Implementations should
   * write through `useGraphMutation.mutate` so the delete is a single
   * undo entry.
   */
  onDelete: () => void;
  /**
   * Optional data-testid suffix to disambiguate multiple affordances
   * in tests (e.g. `column-0-1`, `section-2`).
   */
  testIdSuffix?: string;
}

export function ColumnDeleteAffordance({
  nodeCount,
  scope,
  onDelete,
  testIdSuffix,
}: ColumnDeleteAffordanceProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  const body =
    nodeCount === 0
      ? `Delete this empty ${scope}? You can undo this with Ctrl+Z.`
      : `This ${scope} contains ${nodeCount} node${nodeCount === 1 ? '' : 's'}. Deleting it will remove ${nodeCount === 1 ? 'that node' : 'all of them'}. You can undo with Ctrl+Z.`;

  const testIdBase = testIdSuffix ? `${scope}-delete-${testIdSuffix}` : `${scope}-delete`;

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmOpen(true);
  };

  return (
    <>
      <button
        type="button"
        // The delete button is hidden by default and revealed via the
        // surrounding column/section's *named* group class. The
        // parent must carry the matching `group/<scope>` for this to
        // work (`group/column` for `scope='column'`, `group/section`
        // for `scope='section'`). See header comment for why named
        // groups (not anonymous `group`) are required.
        //
        // Visual contract (issue 54, pinned by
        // ColumnDeleteAffordance.test.tsx): bare glyph only — never
        // add bg-*/border-*/shadow-* here. `p-1.5` keeps a 28×28px
        // hit target around the 16px icon; `top-0.5 right-0.5`
        // compensates for the larger box so the glyph sits where the
        // old 24px chip's glyph did. Section tone is light because
        // the title bar behind it is dark (`data.color`, default
        // #374151) — same contrast assumption as the white title
        // text next to it.
        className={`opacity-0 ${
          scope === 'column' ? 'group-hover/column:opacity-100' : 'group-hover/section:opacity-100'
        } focus-visible:opacity-100 transition absolute top-0.5 right-0.5 z-30 flex items-center justify-center p-1.5 rounded ${
          scope === 'section'
            ? 'text-white/70 hover:text-white focus-visible:ring-white/60'
            : 'text-gray-400 hover:text-red-500 focus-visible:ring-gray-300'
        } focus:outline-none focus-visible:ring-2`}
        aria-label={`Delete ${scope}`}
        title={`Delete ${scope}`}
        onClick={handleClick}
        data-testid={testIdBase}
      >
        {/* K10: the column glyph sits over whatever node color the
            user drags under the column's top-right corner; gray-400
            strokes disappear on near-black fills. A white drop-shadow
            halo on the ICON keeps the strokes legible on dark fills
            and is invisible on light ones (white on white). It's a
            filter following the glyph shape — NOT the bg/outline chip
            issue 54 removed (that contract is pinned on the BUTTON's
            classes, which stay bare). Two stacked shadows: a tight
            near-opaque rim plus a wider soft glow. Written as an
            arbitrary `[filter:...]` property because Tailwind v4.3's
            `drop-shadow-[a,b]` arbitrary VALUE emits both shadows
            inside one drop-shadow() function, which is invalid CSS —
            Chrome computes `filter: none` (verified empirically; the
            two-function form below computes correctly). Section scope
            keeps its plain white-on-dark tone (matches the title
            text's contrast assumption). */}
        <TrashIcon
          className={`w-4 h-4 ${
            scope === 'column'
              ? '[filter:drop-shadow(0_0_1px_rgba(255,255,255,0.95))_drop-shadow(0_0_3px_rgba(255,255,255,0.7))]'
              : ''
          }`}
        />
      </button>
      <ConfirmModal
        open={confirmOpen}
        title={`Delete ${scope}?`}
        body={body}
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={() => {
          onDelete();
          setConfirmOpen(false);
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
