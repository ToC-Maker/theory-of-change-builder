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
} from '@mdxeditor/editor';
import '@mdxeditor/editor/style.css';

interface MDXEditorComponentProps {
  markdown: string;
  onChange?: (markdown: string) => void;
  placeholder?: string;
  fontFamily?: string;
}

export function MDXEditorComponent({
  markdown,
  onChange,
  placeholder = 'Enter text...',
  fontFamily,
}: MDXEditorComponentProps) {
  return (
    <div
      className="mdx-editor-wrapper"
      style={{ fontFamily }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <MDXEditor
        markdown={markdown}
        onChange={onChange}
        placeholder={placeholder}
        plugins={[
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
