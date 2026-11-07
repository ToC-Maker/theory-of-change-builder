// Tests for `MDXEditorComponent`'s popup layering (PR 34 feedback #66).
//
// MDXEditor renders its popups (the block-type select dropdown, toolbar
// tooltips, the link dialog) into a library-created `div.mdxeditor-popup-
// container` appended to `document.body` — NOT into the editor wrapper.
// The library ships `position: relative; z-index: 2` on that container,
// which makes it a body-level stacking context at z=2. The NodeEditor
// panel hosting the editor is ALSO a body-level stacking context, at
// z-[150] (`src/components/node-editor/NodeEditor.tsx`). 150 > 2, so
// every mdxeditor popup painted BEHIND the panel: the block-type select
// opened invisibly underneath it.
//
// The fix raises the popup container above the anchored editors via the
// library's documented theming hook (the stable public class name):
// `.mdxeditor-popup-container { z-index: 160; }` in MDXEditorComponent's
// style block. 160 sits directly above NodeEditor/EdgeEditor (150) and
// below the full-screen overlays (AuthButton modal / GraphTutorial at
// 9999) — nothing else in the app lives in (150, 9999).
//
// jsdom can't paint, so the geometric "popup is visible above the panel"
// assertion lives in a browser check (rodney) run during review. What
// this test pins: the override rule exists, parses, and computes on the
// real library-created container element — a regression to the library
// default (z=2, i.e. behind the z-150 panel) fails here.
//
// Note: vitest resolves the library's CSS import to an empty module, so
// the computed style below comes from the component's own <style> block
// only. Pre-fix this computes '' (no rule at all), post-fix '160'.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MDXEditorComponent } from '../../src/components/MDXEditor';

afterEach(() => {
  cleanup();
});

describe('MDXEditorComponent popup layering', () => {
  it('lifts the body-level popup container above the z-150 anchored editors', async () => {
    render(<MDXEditorComponent markdown="Hello" />);

    // The popup container is created by an effect on editor mount; the
    // toolbar appearing means the editor (and the effect) committed.
    await screen.findByRole('toolbar');

    const popupContainer = document.querySelector('.mdxeditor-popup-container');
    expect(popupContainer).not.toBeNull();

    // Must beat NodeEditor/EdgeEditor's z-[150] so the block-type
    // select (and tooltips / the link dialog) paint above the panel
    // that hosts the editor.
    const zIndex = getComputedStyle(popupContainer as Element).zIndex;
    expect(Number(zIndex)).toBeGreaterThan(150);
  });
});
