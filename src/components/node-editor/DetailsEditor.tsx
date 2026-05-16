// `DetailsEditor` — lazy MDXEditor accordion inside `NodeEditor`.
//
// Collapsed state renders a non-interactive markdown preview (so the
// node's existing details are visible immediately, even on slow
// connections where the MDXEditor chunk hasn't downloaded yet). Click
// to expand triggers two things in parallel:
//   1. `setExpanded(true)` so the accordion opens
//   2. an eager preload via the dynamic import promise (so the chunk
//      starts downloading even if React hasn't fully committed yet).
//
// Once expanded, we render the full `MDXEditorComponent`. The collapsed
// preview uses the same `MDXEditorComponent` in `readOnly` mode (which
// renders the same lexical tree, just without the toolbar / contentEditable),
// so the visual layout doesn't jump between modes.
//
// Commit semantics: the parent's `onCommit` callback fires when the
// accordion collapses OR when `NodeEditor` unmounts. Live typing is
// streamed via `onChange` (buffered by `useNodeProperties` →
// `mutateDebounced`).
import { Suspense, lazy, useEffect, useRef, useState } from 'react';

interface DetailsEditorProps {
  markdown: string;
  /** Streaming write — called on every keystroke. */
  onChange: (markdown: string) => void;
  /** Called when the accordion collapses; the caller flushes the buffer. */
  onCommit: () => void;
  /** Placeholder for the empty state. */
  placeholder?: string;
  fontFamily?: string;
}

// Lazy import — defers the lexical / mdast / mdxeditor chunk (~600 KB
// minified) until the user actually clicks to edit. Empty graphs that
// never open a node skip the cost entirely.
const LazyMDXEditor = lazy(() =>
  import('../MDXEditor').then((m) => ({ default: m.MDXEditorComponent })),
);

// Eager preload: kicked off by the click-to-edit handler so the chunk
// is fetched in parallel with React's expand-state commit. Idempotent
// across calls (Vite's import cache de-dupes).
function preloadMDXEditor() {
  void import('../MDXEditor');
}

export function DetailsEditor({
  markdown,
  onChange,
  onCommit,
  placeholder = 'Add details (markdown supported)...',
  fontFamily,
}: DetailsEditorProps) {
  const [expanded, setExpanded] = useState(false);
  const wasExpandedRef = useRef(false);

  // Track the collapse edge so `onCommit` fires once per close.
  useEffect(() => {
    if (wasExpandedRef.current && !expanded) {
      onCommit();
    }
    wasExpandedRef.current = expanded;
  }, [expanded, onCommit]);

  const togglerLabel = expanded ? 'Hide details' : markdown ? 'Edit details' : 'Add details';

  return (
    <div className="details-editor">
      <button
        type="button"
        className="details-editor__toggle text-xs text-blue-600 hover:underline"
        onClick={() => {
          // Preload BEFORE the React state update so the network request
          // starts on the same tick as the click. The Suspense fallback
          // below then almost-certainly hides under the React 18 paint.
          if (!expanded) preloadMDXEditor();
          setExpanded((v) => !v);
        }}
        onMouseEnter={() => {
          // Pre-warm on hover so the click feels instant.
          if (!expanded) preloadMDXEditor();
        }}
      >
        {togglerLabel}
      </button>

      {expanded ? (
        <Suspense
          fallback={
            <div
              className="details-editor__loading text-xs text-gray-400 italic px-2 py-1"
              style={{ fontFamily }}
            >
              Loading editor…
            </div>
          }
        >
          <div className="mt-1">
            <LazyMDXEditor
              markdown={markdown}
              onChange={onChange}
              placeholder={placeholder}
              fontFamily={fontFamily}
            />
          </div>
        </Suspense>
      ) : markdown ? (
        // Collapsed-but-has-content: render a compact text-only preview.
        // We deliberately avoid loading MDXEditor here so the collapsed
        // path stays fast. A future enhancement can render the markdown
        // via a tiny offline renderer (e.g. marked) if richer preview is
        // useful; today the raw markdown is good enough as a hint.
        <div
          className="details-editor__preview text-xs text-gray-500 mt-1 whitespace-pre-wrap line-clamp-3"
          style={{ fontFamily }}
        >
          {markdown}
        </div>
      ) : null}
    </div>
  );
}
