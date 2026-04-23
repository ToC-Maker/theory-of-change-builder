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
  readOnly?: boolean;
  simple?: boolean; // For title fields - no toolbar, minimal plugins
  fontFamily?: string;
}

export function MDXEditorComponent({
  markdown,
  onChange,
  placeholder = 'Enter text...',
  readOnly = false,
  simple = false,
  fontFamily,
}: MDXEditorComponentProps) {
  return (
    <div
      className={`mdx-editor-wrapper ${simple ? 'simple' : ''}`}
      data-readonly={readOnly}
      style={{ fontFamily }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <MDXEditor
        markdown={markdown}
        onChange={onChange}
        placeholder={placeholder}
        readOnly={readOnly}
        plugins={[
          // Simple mode for titles - minimal plugins
          ...(simple
            ? []
            : [
                headingsPlugin(),
                listsPlugin(),
                quotePlugin(),
                thematicBreakPlugin(),
                linkPlugin(),
              ]),
          ...(readOnly || simple ? [] : [markdownShortcutPlugin()]),

          // Toolbar with basic formatting (only if not read-only and not simple)
          ...(readOnly || simple
            ? []
            : [
                toolbarPlugin({
                  toolbarContents: () => (
                    <>
                      <UndoRedo />
                      <Separator />
                      <BoldItalicUnderlineToggles />
                      <Separator />
                      <ListsToggle />
                      <Separator />
                      <BlockTypeSelect />
                    </>
                  ),
                }),
              ]),
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

        .mdx-editor-wrapper.simple .mdx-editor-content {
          min-height: 40px;
          font-size: 18px;
          font-weight: 700;
          color: #111827;
          padding: 8px 12px;
        }

        /* Remove min-height for read-only mode - content should size naturally */
        .mdx-editor-wrapper[data-readonly="true"] .mdx-editor-content {
          min-height: auto;
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

        .mdx-editor-wrapper [class*="_contentEditable"] {
          font-family: inherit !important;
        }
      `}</style>
    </div>
  );
}
