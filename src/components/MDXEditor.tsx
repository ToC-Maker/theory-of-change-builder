import { useImperativeHandle, useMemo, useRef } from 'react';
import type { Ref } from 'react';
import {
  MDXEditor,
  headingsPlugin,
  listsPlugin,
  quotePlugin,
  thematicBreakPlugin,
  markdownShortcutPlugin,
  linkPlugin,
  toolbarPlugin,
  UndoRedo,
  BoldItalicUnderlineToggles,
  ListsToggle,
  BlockTypeSelect,
  Separator,
  lexical,
  realmPlugin,
  rootEditor$,
  type MDXEditorMethods,
  type Translation,
} from '@mdxeditor/editor';
import '@mdxeditor/editor/style.css';
import { loggingService } from '../services/loggingService';

// The library's default "Block type" label reads as jargon in the
// toolbar, so the select is called "Text style" instead. Only these
// strings are overridden; every other key keeps the library's default
// text. The library's own default translator isn't exported, so the
// `{{name}}` interpolation it does (e.g. "Heading {{level}}") is
// repeated here.
const TEXT_OVERRIDES = new Map([
  ['toolbar.blockTypeSelect.placeholder', 'Text style'],
  ['toolbar.blockTypeSelect.selectBlockTypeTooltip', 'Select text style'],
]);

const translation: Translation = (key, defaultValue, interpolations = {}) => {
  let value = TEXT_OVERRIDES.get(key) ?? defaultValue;
  for (const [name, replacement] of Object.entries(interpolations)) {
    value = value.replaceAll(`{{${name}}}`, String(replacement));
  }
  return value;
};

// The library calls this when it cannot turn markdown into editor content
// (inline HTML such as `a <b> c`, an unhandled construct). The editor then
// shows truncated or blank text and stops reporting edits, so typing in it
// is lost without a sign; this makes the failure countable. The library's
// payload quotes the markdown, which is user content, so none of it is sent.
function reportMarkdownImportFailure() {
  loggingService.reportError({
    error_name: 'MarkdownImportFailed',
    error_message: 'MDXEditor could not import the markdown it was given',
    request_metadata: { component: 'MDXEditor' },
  });
}

interface MDXEditorComponentProps {
  markdown: string;
  /**
   * `initialMarkdownNormalize` is true when the call only reports the
   * editor's normal form of the `markdown` it was opened with (nothing
   * was typed). Callers that persist the text must ignore those calls.
   */
  onChange?: (markdown: string, initialMarkdownNormalize: boolean) => void;
  /**
   * The library's imperative methods, except that `setMarkdown` also
   * empties the editor's undo history. The library records a
   * `setMarkdown` as an undoable step, and undoing it fires `onChange`
   * with the text from before, which a caller that saves on `onChange`
   * would save over the change it just applied.
   */
  editorRef?: Ref<MDXEditorMethods>;
  placeholder?: string;
  fontFamily?: string;
}

export function MDXEditorComponent({
  markdown,
  onChange,
  editorRef,
  placeholder = 'Enter text...',
  fontFamily,
}: MDXEditorComponentProps) {
  const libraryRef = useRef<MDXEditorMethods>(null);
  const clearHistoryRef = useRef<() => void>(() => {});
  // The ref gives no way to reach the history, so a plugin reads the
  // root Lexical editor from the editor's realm.
  const historyPlugin = useMemo(
    () =>
      realmPlugin({
        init(realm) {
          clearHistoryRef.current = () => {
            realm.getValue(rootEditor$)?.dispatchCommand(lexical.CLEAR_HISTORY_COMMAND, undefined);
          };
        },
      })(),
    [],
  );
  useImperativeHandle(editorRef, () => {
    const library = libraryRef.current!;
    return {
      ...library,
      setMarkdown(next: string) {
        library.setMarkdown(next);
        clearHistoryRef.current();
      },
    };
  }, []);

  return (
    <div
      className="mdx-editor-wrapper"
      style={{ fontFamily }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <MDXEditor
        ref={libraryRef}
        markdown={markdown}
        onChange={onChange}
        onError={reportMarkdownImportFailure}
        placeholder={placeholder}
        translation={translation}
        plugins={[
          historyPlugin,
          headingsPlugin(),
          listsPlugin(),
          quotePlugin(),
          thematicBreakPlugin(),
          linkPlugin(),
          markdownShortcutPlugin(),
          toolbarPlugin({
            // Two explicit rows. The editor mounts inside the 288px
            // NodeEditor panel; the full control set is ~466px laid out
            // in a single row, and MDXEditor's stock toolbar resolves
            // that with `overflow-x: auto` (a horizontal scrollbar —
            // PR 34 feedback #48). Splitting into two balanced rows
            // keeps every control visible with no scrolling. See the
            // `.mdx-toolbar-row` styles below.
            toolbarContents: () => (
              <div className="mdx-toolbar-rows">
                <div className="mdx-toolbar-row">
                  <UndoRedo />
                  <Separator />
                  <BoldItalicUnderlineToggles />
                </div>
                <div className="mdx-toolbar-row">
                  <ListsToggle />
                  <Separator />
                  <BlockTypeSelect />
                </div>
              </div>
            ),
          }),
        ]}
        contentEditableClassName="mdx-editor-content"
      />

      <style>{`
        .mdx-editor-wrapper {
          border: 1px solid #d1d5db;
          border-radius: 0.5rem;
          overflow: hidden;
        }

        .mdx-editor-wrapper:focus-within {
          border-color: #3b82f6;
          box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.1);
        }

        .mdx-editor-content {
          font-size: 14px;
          line-height: 1.5;
          color: #374151;
          padding: 12px;
          min-height: 120px;
          text-align: left !important;
          font-family: inherit !important;
        }

        .mdx-editor-content ul {
          list-style-type: disc;
          padding-left: 1.5rem;
          margin: 0.5rem 0;
        }

        .mdx-editor-content ol {
          list-style-type: decimal;
          padding-left: 1.5rem;
          margin: 0.5rem 0;
        }

        .mdx-editor-content li {
          margin: 0.25rem 0;
        }

        .mdx-editor-content strong {
          font-weight: 600;
        }

        .mdx-editor-content em {
          font-style: italic;
        }

        .mdx-editor-content a {
          color: #2563eb;
          text-decoration: underline;
        }

        .mdx-editor-content blockquote {
          border-left: 4px solid #e5e7eb;
          padding-left: 1rem;
          margin: 1rem 0;
          font-style: italic;
          color: #6b7280;
        }

        .mdx-editor-content h1, .mdx-editor-content h2, .mdx-editor-content h3 {
          font-weight: 600;
          margin: 1rem 0 0.5rem 0;
        }

        .mdx-editor-content p {
          margin: 0.5rem 0;
          text-align: left !important;
        }

        .mdx-editor-content * {
          text-align: left !important;
          font-family: inherit !important;
        }

        /* MDX Editor library overrides */
        .mdx-editor-wrapper [class*="mdxeditor"] {
          font-family: inherit !important;
        }

        /* Popup layering (PR 34 feedback #66). The library portals its
           popups (block-type select dropdown, toolbar tooltips, link
           dialog) into a div.mdxeditor-popup-container appended to
           document.body, shipped with position: relative; z-index: 2.
           That body-level stacking context loses to the NodeEditor
           panel (fixed z-[150], also a body child), so the block-type
           select opened invisibly BEHIND the panel. Raise the container
           via its documented stable class — v4 exposes no z-index var —
           to sit just above the anchored editors (NodeEditor/EdgeEditor
           at 150) and below the full-screen overlays (auth modal /
           tutorial at 9999). Nothing else lives in (150, 9999). This
           selector intentionally has no .mdx-editor-wrapper prefix: the
           container is not a descendant of the wrapper. It wins the
           specificity tie with the library rule by document order
           (this <style> element renders in <body>, after the imported
           stylesheet in <head>). */
        .mdxeditor-popup-container {
          z-index: 160;
        }

        /* Toolbar: two rows, never a horizontal scrollbar.
           The library's _toolbarRoot has overflow-x: auto, which
           shows a scrollbar inside the 288px NodeEditor. With the
           two-row layout the contents fit, so let overflow be
           visible (no scroll affordance at all). */
        .mdx-editor-wrapper [class*="_toolbarRoot"] {
          overflow-x: visible;
        }

        .mdx-editor-wrapper .mdx-toolbar-rows {
          display: flex;
          flex-direction: column;
          width: 100%;
        }

        .mdx-editor-wrapper .mdx-toolbar-row {
          display: flex;
          align-items: center;
          /* Re-create the root toolbar's inter-item gap (the library
             sets it on _toolbarRoot, whose gap doesn't reach into
             these nested rows). */
          gap: var(--spacing-1, 4px);
          /* Safety valve: if a row ever outgrows the editor (wide
             custom node fonts, future controls), wrap rather than
             overflow. */
          flex-wrap: wrap;
        }

        /* The block-type select trigger is pinned to 144px
           (width: var(--spacing-36)) by the library — over half the
           editor's width. Let it shrink to its content ("Paragraph"
           + chevron ≈ 95px) so the second row fits. min-width keeps
           it recognizable as a select when the cursor sits in a
           context with no block-type value (e.g. a list item), where
           the label renders empty and the trigger would otherwise
           collapse to a bare chevron. */
        .mdx-editor-wrapper [class*="_selectTrigger"] {
          width: auto;
          min-width: 4rem;
        }

        .mdx-editor-wrapper [class*="_contentEditable"] {
          font-family: inherit !important;
        }
      `}</style>
    </div>
  );
}
