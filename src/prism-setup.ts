// Vite 8 (rolldown) reorders module initialization in a way that
// breaks @lexical/code's expectation that `window.Prism` is set before
// its bundled language-plugin IIFEs run. The plugins reference `Prism`
// as a bare identifier and fail with `ReferenceError: Prism is not
// defined` (see https://github.com/vitejs/vite/issues/21948,
// https://github.com/mdx-editor/editor/issues/491).
//
// Importing prismjs here and attaching it to window forces the global
// to exist before any main-bundle code that depends on it runs. This
// file must be imported FIRST in main.tsx so its module body runs
// before MDXEditor / @lexical/code in the dependency graph.

import Prism from 'prismjs';

if (typeof window !== 'undefined') {
  (window as unknown as { Prism: typeof Prism }).Prism = Prism;
}
