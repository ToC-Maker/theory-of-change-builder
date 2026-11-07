// Mounts the canvas, or just a chart document, the way the app does: on a
// `ChartDocument` that has a server version, so a test can land a remote chart
// with `land`. `onCommit` records every chart the document commits (what the
// save hook would send), the way the canvas's old `onDataChange` did.
import type { ComponentProps } from 'react';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { ToC } from '../../../src/components/TheoryOfChangeGraph';
import { ChartDocument } from '../../../src/sync/ChartDocument';
import { normalizeChart, type ChartInput, type ToCData } from '../../../shared/chart-model';
import { edit } from '../../shared/chart-fixtures';
import { deepFreeze } from './deepFreeze';

export type ToCTestProps = Omit<ComponentProps<typeof ToC>, 'store'>;

export interface TestDoc {
  doc: ChartDocument;
  /** Called with the committed chart each time the document commits. */
  onCommit: ReturnType<typeof vi.fn<(chart: ToCData) => void>>;
  /** Lands a remote chart: the server's current chart with `mutate` applied, one version up. */
  land: (mutate: (draft: ToCData) => void) => void;
}

/** A document on `chart` (normalised and frozen, so an updater that writes into its input throws). */
export function makeDoc(chart: ChartInput): TestDoc {
  let server = deepFreeze(normalizeChart(chart));
  let version = 1;
  const doc = new ChartDocument({
    chart: server,
    editToken: 'test-token',
    server: { version, chart: server },
  });
  const onCommit = vi.fn<(chart: ToCData) => void>();
  let seen = doc.getCommitCount();
  doc.subscribe(() => {
    if (doc.getCommitCount() === seen) return;
    seen = doc.getCommitCount();
    onCommit(doc.getCommitted());
  });
  const land = (mutate: (draft: ToCData) => void) => {
    server = deepFreeze(edit(server, mutate));
    doc.receiveRemote({ version: ++version, chart: server });
  };
  return { doc, onCommit, land };
}

/** Renders `<ToC>` over a document on `chart`. */
export function renderToC(chart: ChartInput, props: ToCTestProps = {}) {
  const testDoc = makeDoc(chart);
  const rendered = render(<ToC store={testDoc.doc} showEditButton {...props} />);
  const rerenderToC = (next: ToCTestProps = props) =>
    rendered.rerender(<ToC store={testDoc.doc} showEditButton {...next} />);
  return { ...rendered, ...testDoc, rerenderToC };
}
