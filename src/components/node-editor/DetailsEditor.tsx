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
// preview renders the raw markdown via a plain `<div>` (not the editor)
// so the collapsed path doesn't pay the chunk-download cost.
//
// Commit semantics: the parent's `onCommit` callback fires when the
// accordion collapses OR when `NodeEditor` unmounts. Live typing is
// streamed via `onChange` (buffered by `useNodeProperties` →
// `mutateDebounced`).
//
// ---------------------------------------------------------------------------
// Lazy-load failure containment
// ---------------------------------------------------------------------------
//
// The dynamic `import('../MDXEditor')` can reject in production — chunk
// hashes rotate on every deploy, so a tab open across a deploy will
// 404 the old chunk URL; CDN hiccups also surface as rejected promises.
// React's <Suspense> handles thrown PROMISES (pending), not rejected
// ones — a rejected lazy promise re-throws past <Suspense> to the
// nearest error boundary. Without a local boundary, that's the root
// boundary in `main.tsx`, which renders a full-screen "Please refresh."
// UI and loses the user's in-progress typing in the rest of NodeEditor.
//
// We wrap the lazy chunk in a local `<ErrorBoundary>` with an inline
// fallback (retry button + plain-text preview) so the surrounding
// NodeEditor stays functional.
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentType, LazyExoticComponent } from 'react';
import { ErrorBoundary } from '../ErrorBoundary';
import { loggingService } from '../../services/loggingService';

// Subset of `MDXEditorComponent`'s prop signature that DetailsEditor
// actually passes. Kept structural (not `typeof MDXEditorComponent`) so
// the lazy-factory escape hatch doesn't drag in the heavy
// `@mdxeditor/editor` types and force them into this file's chunk.
interface MDXEditorPropsShape {
  markdown: string;
  onChange?: (markdown: string) => void;
  placeholder?: string;
  fontFamily?: string;
}

interface DetailsEditorProps {
  markdown: string;
  /** Streaming write — called on every keystroke. */
  onChange: (markdown: string) => void;
  /** Called when the accordion collapses; the caller flushes the buffer. */
  onCommit: () => void;
  /** Placeholder for the empty state. */
  placeholder?: string;
  fontFamily?: string;
  /**
   * Test-only seam: builds the lazy MDXEditor. Override in unit tests
   * to inject a rejecting promise (verifies the local ErrorBoundary).
   * Production callers should always use the default.
   */
  lazyFactory?: () => LazyExoticComponent<ComponentType<MDXEditorPropsShape>>;
}

// Lazy import — defers the lexical / mdast / mdxeditor chunk (~600 KB
// minified) until the user actually clicks to edit. Empty graphs that
// never open a node skip the cost entirely.
//
// Returned as a factory so Retry can rebuild a fresh lazy component
// (React.lazy caches rejected promises — re-using the same instance
// after a chunk-load failure would re-throw the cached rejection).
function buildLazyMDXEditor(): LazyExoticComponent<ComponentType<MDXEditorPropsShape>> {
  return lazy(() =>
    import('../MDXEditor').then((m) => ({
      default: m.MDXEditorComponent as ComponentType<MDXEditorPropsShape>,
    })),
  );
}

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
  lazyFactory = buildLazyMDXEditor,
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

  // `loadAttempt` is bumped on Retry; we rebuild the lazy component so
  // a previously-rejected import promise can be retried (React.lazy
  // caches rejections per-component). useState lazy-init is used so we
  // only allocate one lazy component per attempt.
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [LazyMDXEditor, setLazyMDXEditor] = useState(() => lazyFactory());
  const retry = useCallback(() => {
    preloadMDXEditor();
    setLazyMDXEditor(() => lazyFactory());
    setLoadAttempt((n) => n + 1);
  }, [lazyFactory]);

  const togglerLabel = expanded ? 'Hide details' : markdown ? 'Edit details' : 'Add details';

  const errorFallback = useCallback(
    ({ error, reset }: { error: Error; reset: () => void }) => {
      // Local fallback: never the full-screen reload UI. The rest of
      // NodeEditor (title input, width, color, delete) stays usable.
      void error;
      return (
        <div
          role="alert"
          className="details-editor__error text-xs text-red-600 mt-1 p-2 border border-red-200 rounded bg-red-50"
          style={{ fontFamily }}
        >
          Editor failed to load.{' '}
          <button
            type="button"
            className="underline"
            onClick={() => {
              reset();
              retry();
            }}
          >
            Retry
          </button>
          {markdown ? (
            // Fall back to raw markdown so the user can still read the
            // existing content while the editor is unavailable.
            <div className="mt-2 whitespace-pre-wrap text-gray-700">{markdown}</div>
          ) : null}
        </div>
      );
    },
    [fontFamily, markdown, retry],
  );

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
        <ErrorBoundary
          // `key` resets the boundary state when Retry rebuilds the lazy
          // factory, so a fresh attempt isn't blocked by the stuck error
          // state from the previous one.
          key={loadAttempt}
          fallback={errorFallback}
          onCatch={(error, info) => {
            loggingService.reportError({
              error_name: error.name || 'Error',
              error_message: error.message || String(error),
              stack_trace: error.stack,
              request_metadata: {
                component: 'DetailsEditor',
                componentStack: info.componentStack,
              },
            });
          }}
        >
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
        </ErrorBoundary>
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
