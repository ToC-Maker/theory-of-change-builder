// Smoke test: confirms the jsdom project boots, RTL renders, and
// `@testing-library/jest-dom`'s matchers are extended onto vitest's expect.
// Will be removed (or absorbed into a real test) once PR 0's hook tests
// land; kept here for now as the only signal that the jsdom project's
// setupFiles wiring is alive.
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

describe('jsdom project smoke', () => {
  it('renders into the DOM and matches DOM matchers', () => {
    render(<button type="button">Hello</button>);
    expect(screen.getByRole('button', { name: 'Hello' })).toBeInTheDocument();
  });
});
