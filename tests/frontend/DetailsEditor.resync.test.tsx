// The details editor follows a remote change to its text without ever
// touching text the user is typing, and opening a node writes nothing.
//
// Two layers:
//   - `DetailsEditor` against a stand-in editor injected through the
//     `lazyFactory` seam, to see which path a remote change takes.
//   - The real `@mdxeditor/editor` (jsdom) for the library behaviour the
//     resync relies on, which a real browser showed too: `setMarkdown`
//     keeps focus, fires no `onChange`, does nothing for text equal after
//     trimming, and is undoable (undo fires `onChange` with the old text)
//     unless the history is cleared. Those tests guard `^4.0.0` floating
//     to a release that changes any of it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { createRef, lazy, useEffect, useImperativeHandle, type Ref } from 'react';
import type { MDXEditorMethods } from '@mdxeditor/editor';
import { DetailsEditor } from '../../src/components/node-editor/DetailsEditor';
import { MDXEditorComponent } from '../../src/components/MDXEditor';

afterEach(() => {
  cleanup();
});

interface EditorProps {
  markdown: string;
  onChange?: (markdown: string, initialMarkdownNormalize: boolean) => void;
  editorRef?: Ref<MDXEditorMethods>;
}

// A stand-in for the lazy MDXEditor chunk that records how it is driven.
function makeStandInEditor() {
  const seen = {
    mounts: [] as string[],
    unmounts: 0,
    setMarkdown: vi.fn<(markdown: string) => void>(),
    emit: null as null | ((markdown: string, normalize: boolean) => void),
  };
  function StandIn({ markdown, onChange, editorRef }: EditorProps) {
    useEffect(() => {
      seen.mounts.push(markdown);
      seen.emit = (md, normalize) => onChange?.(md, normalize);
      return () => {
        seen.unmounts++;
      };
      // Mount only: the stand-in, like MDXEditor, reads `markdown` once.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    useImperativeHandle(editorRef, () => ({ setMarkdown: seen.setMarkdown }) as MDXEditorMethods);
    return <textarea aria-label="stand-in editor" defaultValue={markdown} />;
  }
  const lazyFactory = () => lazy(() => Promise.resolve({ default: StandIn }));
  return { seen, lazyFactory };
}

async function renderWithStandIn(markdown: string) {
  const standIn = makeStandInEditor();
  const onChange = vi.fn<(markdown: string) => void>();
  const utils = render(
    <DetailsEditor markdown={markdown} onChange={onChange} lazyFactory={standIn.lazyFactory} />,
  );
  const editor = await screen.findByLabelText('stand-in editor');
  return {
    ...standIn,
    onChange,
    editor,
    rerender: (next: string) =>
      utils.rerender(
        <DetailsEditor markdown={next} onChange={onChange} lazyFactory={standIn.lazyFactory} />,
      ),
  };
}

describe('DetailsEditor following remote changes', () => {
  it('remote_details_change_replaces_an_unfocused_editor_with_a_fresh_one', async () => {
    const t = await renderWithStandIn('old text');
    expect(t.seen.mounts).toEqual(['old text']);

    t.rerender('text from someone else');

    // A new editor instance holds the new text; its history starts empty, so
    // Undo cannot bring the old text back. The old instance is gone.
    await waitFor(() => expect(t.seen.mounts).toEqual(['old text', 'text from someone else']));
    expect(t.seen.unmounts).toBe(1);
    expect(t.seen.setMarkdown).not.toHaveBeenCalled();
    expect(t.onChange).not.toHaveBeenCalled();
  });

  it('remote_details_change_reaches_a_focused_editor_through_setMarkdown', async () => {
    const t = await renderWithStandIn('old text');
    act(() => t.editor.focus());
    expect(document.activeElement).toBe(t.editor);

    t.rerender('text from someone else');

    expect(t.seen.setMarkdown).toHaveBeenCalledTimes(1);
    expect(t.seen.setMarkdown).toHaveBeenCalledWith('text from someone else');
    // The same instance keeps focus: no remount.
    expect(t.seen.mounts).toEqual(['old text']);
    expect(t.seen.unmounts).toBe(0);
    expect(document.activeElement).toBe(t.editor);
    expect(t.onChange).not.toHaveBeenCalled();
  });

  it('user_typing_is_not_overwritten_by_own_echo', async () => {
    const t = await renderWithStandIn('old text');
    act(() => t.editor.focus());

    act(() => t.seen.emit!('x', false));
    expect(t.onChange).toHaveBeenCalledWith('x');
    t.rerender('x');

    expect(t.seen.setMarkdown).not.toHaveBeenCalled();
    expect(t.seen.mounts).toEqual(['old text']);
  });

  it('user_typing_is_not_overwritten_by_own_echo_while_unfocused', async () => {
    const t = await renderWithStandIn('old text');

    // e.g. a toolbar button applied bold, then focus moved on.
    act(() => t.seen.emit!('**old** text', false));
    t.rerender('**old** text');

    expect(t.seen.setMarkdown).not.toHaveBeenCalled();
    expect(t.seen.mounts).toEqual(['old text']);
    expect(t.seen.unmounts).toBe(0);
  });

  it('a remote change after the user typed still reaches the editor', async () => {
    const t = await renderWithStandIn('old text');
    act(() => t.editor.focus());

    act(() => t.seen.emit!('x', false));
    t.rerender('x');
    t.rerender('x then someone else');

    expect(t.seen.setMarkdown).toHaveBeenCalledTimes(1);
    expect(t.seen.setMarkdown).toHaveBeenCalledWith('x then someone else');
  });

  it('the same text arriving twice is applied once', async () => {
    const t = await renderWithStandIn('old text');
    act(() => t.editor.focus());

    t.rerender('text from someone else');
    t.rerender('text from someone else');

    expect(t.seen.setMarkdown).toHaveBeenCalledTimes(1);
  });

  it('a remote change while a toolbar button holds focus updates the real editor in place', async () => {
    const onChange = vi.fn<(markdown: string) => void>();
    const { container, rerender } = render(
      <DetailsEditor markdown="local text" onChange={onChange} />,
    );
    const content = await waitFor(
      () => {
        const el = container.querySelector<HTMLElement>('[contenteditable="true"]');
        expect(el).not.toBeNull();
        return el!;
      },
      { timeout: 10000 },
    );
    const bold = await waitFor(() => {
      const el = container.querySelector<HTMLButtonElement>('button[aria-label^="Bold"]');
      expect(el).not.toBeNull();
      return el!;
    });
    act(() => bold.focus());
    expect(document.activeElement).toBe(bold);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    rerender(<DetailsEditor markdown="text from someone else" onChange={onChange} />);

    // Focus is inside the editor (on its toolbar), so the same editor is
    // updated and keeps that focus; a remount would drop it.
    await waitFor(() => expect(content.textContent).toBe('text from someone else'));
    expect(container.querySelector('[contenteditable="true"]')).toBe(content);
    expect(document.activeElement).toBe(bold);
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLButtonElement>('button[aria-label^="Undo"]')!.disabled).toBe(
      true,
    );
  }, 20000);

  it('opening_a_node_does_not_write_text', async () => {
    const t = await renderWithStandIn('- a\n- b  ');

    // MDXEditor reports its normalised form of stored text on mount.
    act(() => t.seen.emit!('* a\n* b', true));

    expect(t.onChange).not.toHaveBeenCalled();
  });

  it('opening_a_node_does_not_write_text (real editor)', async () => {
    const raw: [string, boolean][] = [];
    const onChange = vi.fn<(markdown: string) => void>();
    const lazyFactory = () =>
      lazy(async () => {
        const { MDXEditorComponent: Real } = await import('../../src/components/MDXEditor');
        function Recording(props: EditorProps) {
          return (
            <Real
              {...props}
              onChange={(md, normalize) => {
                raw.push([md, normalize]);
                props.onChange?.(md, normalize);
              }}
            />
          );
        }
        return { default: Recording };
      });

    render(<DetailsEditor markdown={'- a\n- b  '} onChange={onChange} lazyFactory={lazyFactory} />);

    // The library did report the normalised text, and the editor swallowed it.
    await waitFor(() => expect(raw.length).toBeGreaterThan(0), { timeout: 10000 });
    expect(raw.every(([, normalize]) => normalize)).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  }, 20000);
});

describe('MDXEditor behaviour the resync relies on (real editor)', () => {
  async function mountReal(markdown: string) {
    const ref = createRef<MDXEditorMethods>();
    const onChange = vi.fn<(markdown: string, normalize: boolean) => void>();
    const utils = render(
      <MDXEditorComponent markdown={markdown} onChange={onChange} editorRef={ref} />,
    );
    const content = await waitFor(
      () => {
        const el = utils.container.querySelector<HTMLElement>('[contenteditable="true"]');
        expect(el).not.toBeNull();
        return el!;
      },
      { timeout: 10000 },
    );
    // Let mount-time onChange calls (normalisation) settle, then forget them.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    return { ref, onChange, content, ...utils };
  }

  const undoButton = () =>
    waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>('button[aria-label^="Undo"]');
      expect(button).not.toBeNull();
      return button!;
    });

  it('mdxeditor_contract: text not in normal form is reported once opened, flagged as normalisation', async () => {
    const onChange = vi.fn<(markdown: string, normalize: boolean) => void>();
    render(<MDXEditorComponent markdown={'- a\n- b  '} onChange={onChange} />);

    await waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 10000 });

    for (const [md, normalize] of onChange.mock.calls) {
      expect(md).toBe('* a\n* b');
      expect(normalize).toBe(true);
    }
  }, 20000);

  it('mdxeditor_contract: setMarkdown while focused shows the text, keeps focus and reports nothing', async () => {
    const { ref, onChange, content } = await mountReal('local text');
    act(() => content.focus());
    expect(document.activeElement).toBe(content);
    onChange.mockClear();

    await act(async () => {
      ref.current!.setMarkdown('new text');
      await new Promise((r) => setTimeout(r, 100));
    });

    expect(ref.current!.getMarkdown()).toBe('new text');
    expect(content.textContent).toBe('new text');
    expect(document.activeElement).toBe(content);
    expect(onChange).not.toHaveBeenCalled();
  }, 20000);

  it('mdxeditor_contract: setMarkdown with text equal after trimming changes nothing', async () => {
    const { ref, onChange } = await mountReal('local text');
    onChange.mockClear();

    await act(async () => {
      ref.current!.setMarkdown('  local text\n');
      await new Promise((r) => setTimeout(r, 100));
    });

    expect(ref.current!.getMarkdown()).toBe('local text');
    expect(onChange).not.toHaveBeenCalled();
    expect(await undoButton()).toBeDisabled();
  }, 20000);

  it('a text set through the editor handle cannot be undone', async () => {
    const { ref, onChange, content } = await mountReal('local text');
    act(() => content.focus());
    onChange.mockClear();

    await act(async () => {
      ref.current!.setMarkdown('new text');
      await new Promise((r) => setTimeout(r, 100));
    });

    // Undo would revert to 'local text', fire onChange and save over the
    // remote change.
    expect(await undoButton()).toBeDisabled();
    fireEvent.keyDown(content, { key: 'z', ctrlKey: true });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(ref.current!.getMarkdown()).toBe('new text');
    expect(onChange).not.toHaveBeenCalled();
  }, 20000);

  it('the editor handle still exposes the library methods', async () => {
    const { ref } = await mountReal('local text');

    expect(ref.current!.getMarkdown()).toBe('local text');
    expect(typeof ref.current!.insertMarkdown).toBe('function');
    expect(typeof ref.current!.focus).toBe('function');
  }, 20000);
});
