// `DetailsEditor` — always-on lazy MDXEditor inside `NodeEditor`.
//
// Pre-feedback-editor, the details block was a click-to-expand
// accordion ("Edit details" / "Hide details" toggle) so the
// expensive `@mdxeditor/editor` chunk wasn't paid for on every node
// click. User feedback (PR 7) called this out as a two-step that
// hurts the editing flow ("the node editor shouldn't be in two
// parts"). We now mount the editor inline as soon as the NodeEditor
// opens, with a Suspense skeleton covering the chunk download.
//
// Performance: the lazy chunk still defers the ~600 KB MDXEditor
// bundle until the first node-open. Subsequent node-opens reuse the
// cached chunk (Vite's import cache de-dupes). Effectively: first
// node-open pays the chunk cost once per session, every later click
// is instant. Compared with the old toggle, we just moved the load
// trigger earlier (on NodeEditor mount, not on accordion-open),
// which is when the user has already signaled "I want to edit this
// node".
//
// We also fire an eager preload as soon as this module is imported,
// so the chunk download can overlap with the parent React render.
//
// Commit semantics: live typing streams via `onChange` (buffered by
// `useNodeProperties` → `mutateDebounced`). The buffered details are
// flushed on NodeEditor close via NodeEditor's cleanup effect; this
// component does not own the close-edge commit.
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
import { Suspense, lazy, useCallback, useState } from 'react';
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
// minified) until the user actually opens a node editor. Empty graphs
// that never open a node skip the cost entirely.
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

// Eager module-load: kicks off the chunk download as soon as this
// module is imported (which happens when NodeEditor mounts, since
// NodeEditor imports DetailsEditor directly). The promise is fire-
// and-forget; Vite's import cache de-dupes with the lazy() call
// below.
void import('../MDXEditor');

export function DetailsEditor({
  markdown,
  onChange,
  placeholder = 'Add details (markdown supported)...',
  fontFamily,
  lazyFactory = buildLazyMDXEditor,
}: DetailsEditorProps) {
  // `loadAttempt` is bumped on Retry; we rebuild the lazy component so
  // a previously-rejected import promise can be retried (React.lazy
  // caches rejections per-component). useState lazy-init is used so we
  // only allocate one lazy component per attempt.
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [LazyMDXEditor, setLazyMDXEditor] = useState(() => lazyFactory());
  const retry = useCallback(() => {
    void import('../MDXEditor');
    setLazyMDXEditor(() => lazyFactory());
    setLoadAttempt((n) => n + 1);
  }, [lazyFactory]);

  // Local fallback for the ErrorBoundary: never the full-screen reload
  // UI. The rest of NodeEditor (title input, width, color, delete)
  // stays usable while the user retries the editor chunk.
  const errorFallback = useCallback(
    ({ reset }: { error: Error; reset: () => void }) => (
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
    ),
    [fontFamily, markdown, retry],
  );

  return (
    <div className="details-editor">
      <span className="text-xs text-gray-600 mb-1 block">Details</span>
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
            // Skeleton matches the rough height of the MDXEditor toolbar +
            // an empty body so the panel doesn't jump when the chunk
            // commits. Includes a label so screen readers / debug callers
            // know the editor is loading rather than blank.
            <div
              className="details-editor__loading mt-1 rounded border border-gray-200 bg-gray-50 px-2 py-3 text-xs text-gray-400 italic"
              style={{ fontFamily, minHeight: '6rem' }}
              aria-busy="true"
              aria-label="Loading editor"
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
    </div>
  );
}
