// `useFieldBuffer` keeps the text an editor shows while the user types, and
// follows changes to the underlying value that someone else made.
import { StrictMode } from 'react';
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFieldBuffer } from '../../src/hooks/useFieldBuffer';

interface Props {
  source: string;
  resetKey: string;
  mixed: boolean;
}

function setup(initial: Partial<Props> = {}) {
  let renders = 0;
  const hook = renderHook(
    (props: Props) => {
      renders++;
      return useFieldBuffer(props.source, props.resetKey, props.mixed);
    },
    { initialProps: { source: 'A', resetKey: 'n1', mixed: false, ...initial } },
  );
  return { ...hook, renders: () => renders };
}

describe('useFieldBuffer', () => {
  it('clean_buffer_adopts_new_source', () => {
    const { result, rerender } = setup();
    expect(result.current[0]).toBe('A');

    rerender({ source: 'B', resetKey: 'n1', mixed: false });

    expect(result.current[0]).toBe('B');
  });

  it('typed_buffer_ignores_source_echo', () => {
    const { result, rerender, renders } = setup();

    act(() => result.current[1]('Ab'));
    expect(result.current[0]).toBe('Ab');
    const rendersBeforeEcho = renders();

    // The typed text reaches the source: the one render for the new prop,
    // and no extra render from the buffer.
    rerender({ source: 'Ab', resetKey: 'n1', mixed: false });

    expect(result.current[0]).toBe('Ab');
    expect(renders()).toBe(rendersBeforeEcho + 1);
  });

  it('typed_buffer_keeps_text_when_the_source_is_unchanged_by_a_rerender', () => {
    const { result, rerender } = setup();

    act(() => result.current[1]('Ab'));
    rerender({ source: 'A', resetKey: 'n1', mixed: false });

    expect(result.current[0]).toBe('Ab');
  });

  it('adopts_a_source_that_differs_from_the_typed_text', () => {
    const { result, rerender } = setup();

    act(() => result.current[1]('Ab'));
    rerender({ source: 'Ab', resetKey: 'n1', mixed: false });
    rerender({ source: 'Other', resetKey: 'n1', mixed: false });

    expect(result.current[0]).toBe('Other');
  });

  it('adopts_a_remote_value_that_equals_an_earlier_typed_text', () => {
    const { result, rerender } = setup();

    act(() => result.current[1]('Ab'));
    rerender({ source: 'Ab', resetKey: 'n1', mixed: false });
    rerender({ source: 'Remote', resetKey: 'n1', mixed: false });
    // Someone sets the field back to what this user typed before.
    rerender({ source: 'Ab', resetKey: 'n1', mixed: false });

    expect(result.current[0]).toBe('Ab');
  });

  it('reset_key_reseeds', () => {
    const { result, rerender } = setup();

    act(() => result.current[1]('typed on n1'));
    rerender({ source: 'B text', resetKey: 'n2', mixed: false });

    expect(result.current[0]).toBe('B text');
  });

  it('reset_key_reseeds_even_when_the_source_does_not_change', () => {
    // The chart still holds '' for the first node (the typed text has not
    // reached it), and the next node's value is '' too.
    const { result, rerender } = setup({ source: '' });

    act(() => result.current[1]('typed on n1'));
    rerender({ source: '', resetKey: 'n2', mixed: false });

    expect(result.current[0]).toBe('');
  });

  it('reset_key_reseeds_even_when_the_new_source_equals_text_typed_before', () => {
    const { result, rerender } = setup();

    act(() => result.current[1]('same'));
    rerender({ source: 'same', resetKey: 'n1', mixed: false });
    rerender({ source: 'other', resetKey: 'n2', mixed: false });
    rerender({ source: 'same', resetKey: 'n1', mixed: false });

    expect(result.current[0]).toBe('same');
  });

  it('mixed_selection_never_resyncs', () => {
    const { result, rerender } = setup({ source: '', mixed: true });

    rerender({ source: 'changed elsewhere', resetKey: 'n1', mixed: true });

    expect(result.current[0]).toBe('');
  });

  it('resumes_following_the_source_once_the_values_no_longer_differ', () => {
    const { result, rerender } = setup({ source: '', mixed: true });

    rerender({ source: 'now shared', resetKey: 'n1', mixed: false });

    expect(result.current[0]).toBe('now shared');
  });

  it('behaves the same under StrictMode double-invoked effects', () => {
    const { result, rerender } = renderHook(
      (props: Props) => useFieldBuffer(props.source, props.resetKey, props.mixed),
      { initialProps: { source: 'A', resetKey: 'n1', mixed: false }, wrapper: StrictMode },
    );

    act(() => result.current[1]('Ab'));
    rerender({ source: 'Ab', resetKey: 'n1', mixed: false });
    expect(result.current[0]).toBe('Ab');

    rerender({ source: 'Remote', resetKey: 'n1', mixed: false });
    expect(result.current[0]).toBe('Remote');
  });
});
