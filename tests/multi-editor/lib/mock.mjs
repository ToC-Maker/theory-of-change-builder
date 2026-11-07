// A versioned stand-in for the Worker's chart API (anonymous charts: the edit token is the only gate),
// plus a streaming AI endpoint. It mirrors worker/api/{getChart,createChart,updateChart,pollChart}.ts:
//
//   - every chart has an integer `version`; a write that changes the stored chart bumps it, an
//     identical write leaves it (the database trigger's rule)
//   - updateChart with `baseVersion`: compare-and-swap at the commit point (after the simulated
//     latency) -> 200 {success, version} or 409 {error:'conflict', version, chartData}
//   - updateChart without it: the legacy last-write-wins path of tabs on the previous client,
//     logged as `updateChart.legacy`
//   - pollChart {editToken, knownVersion} -> {version} or {version, chartData}
//
// Which editor made a request is read from the page URL's `?who=` (the Referer header).
//
// Every event is appended to the log file as one JSON line and kept in `mock.events`. Raw request
// bodies are not logged except where a scenario reads them: the full stored chart is in each
// `POST-commit`, which is what the oracles replay.
import fs from 'node:fs';
import http from 'node:http';
import { seedChart, summary } from './chart.mjs';

// Postgres jsonb stores object keys shorter-first, then bytewise. Reproducing that keeps the chart
// the pages read back in the same key order production returns.
const byJsonbKeyOrder = (a, b) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length - y.length || Buffer.compare(x, y);
};
const jsonb = (value) =>
  Array.isArray(value)
    ? value.map(jsonb)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort(byJsonbKeyOrder)
            .map((key) => [key, jsonb(value[key])]),
        )
      : value;
const store = (chart) => jsonb(JSON.parse(JSON.stringify(chart)));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const whoOf = (req) => {
  try {
    return new URL(req.headers.referer).searchParams.get('who') ?? '?';
  } catch {
    return '?';
  }
};

/** The AI reply used when a scenario does not queue one: retitle Foxtrot after 12 s. */
const DEFAULT_AI = {
  ms: 12_000,
  edits: [{ type: 'update', path: 'sections.1.columns.1.nodes.1.title', value: 'Foxtrot +AI' }],
};

export function startMock({ port, logFile }) {
  const events = [];
  const log = (event) => {
    const entry = { ts: Date.now(), ...event };
    events.push(entry);
    fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
  };

  /** token -> { id, data, version, writes } */
  const charts = new Map();
  const config = {
    latency: { getChart: 150, updateChart: 250, pollChart: 60, createChart: 200, upload: 150 },
    /** per[who][kind] overrides latency for one editor */
    per: {},
  };
  /** One-shot behaviours for the next request of a kind by an editor: { delay?, status? } */
  const queued = {};
  const aiQueue = [];
  const counters = { createChart: 0, uploadFile: 0 };
  let requestId = 0;
  let createdCount = 0;

  const latencyOf = (who, kind) => {
    const one = queued[`${who}:${kind}`]?.shift();
    return {
      delay: one?.delay ?? config.per[who]?.[kind] ?? config.latency[kind],
      status: one?.status,
      readAt: one?.readAt,
    };
  };

  const handlers = {
    async getChart(req, res, url, who) {
      const token = url.searchParams.get('editToken');
      const chartId = url.searchParams.get('chartId');
      if (!token && !chartId)
        return sendJson(res, 400, { error: 'Chart ID or edit token is required' });
      const id = ++requestId;
      log({ kind: 'GET-start', id, who });
      const { delay } = latencyOf(who, 'getChart');
      // The Worker reads the row about half way through its round trip.
      await sleep(delay / 2);
      const chart = token ? charts.get(token) : [...charts.values()].find((c) => c.id === chartId);
      if (!chart) return sendJson(res, 404, { error: 'Chart not found' });
      const body = JSON.stringify({
        chartData: chart.data,
        chartId: chart.id,
        version: chart.version,
        canEdit: !!token,
        isOwner: false,
      });
      await sleep(delay / 2);
      log({ kind: 'GET-end', id, who, delay, version: chart.version });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    },

    async createChart(req, res, url, who) {
      const { chartData } = JSON.parse((await readBody(req)).toString());
      const id = ++requestId;
      counters.createChart++;
      log({ kind: 'CREATE-start', id, who });
      await sleep(latencyOf(who, 'createChart').delay);
      createdCount++;
      const token = `mk-${createdCount}-${Math.random().toString(36).slice(2, 8)}`;
      const chart = { id: `cid-${createdCount}`, data: store(chartData), version: 1, writes: 0 };
      charts.set(token, chart);
      const origin = `http://${req.headers.host}`;
      log({ kind: 'CREATE-end', id, who, token, chartId: chart.id, chart: chart.data });
      sendJson(res, 200, {
        chartId: chart.id,
        editToken: token,
        viewUrl: `${origin}/chart/${chart.id}`,
        editUrl: `${origin}/edit/${token}`,
        version: 1,
      });
    },

    async updateChart(req, res, url, who) {
      let body;
      try {
        body = JSON.parse((await readBody(req)).toString());
      } catch {
        return sendJson(res, 400, { error: 'Invalid JSON in request body' });
      }
      const { editToken, chartData, baseVersion } = body;
      if (!editToken || !chartData) {
        return sendJson(res, 400, { error: 'Edit token and chart data are required' });
      }
      const id = ++requestId;
      log({ kind: 'POST-start', id, who, baseVersion, sent: summary(chartData) });
      const { delay, status } = latencyOf(who, 'updateChart');
      // The UPDATE commits late in the handler.
      await sleep(delay * 0.8);
      const chart = charts.get(editToken);
      if (!chart) return sendJson(res, 404, { error: 'Chart not found or invalid edit token' });
      if (status >= 400) {
        await sleep(delay * 0.2);
        log({ kind: 'POST-end', id, who, status });
        return sendJson(res, status, { error: 'Failed to update chart' });
      }
      // From here to the write there is no await: the check and the write are one atomic step,
      // as the single UPDATE ... WHERE version = $n is in Postgres.
      if (baseVersion !== undefined && baseVersion !== chart.version) {
        log({ kind: 'POST-409', id, who, baseVersion, version: chart.version });
        await sleep(delay * 0.2);
        log({ kind: 'POST-end', id, who, status: 409 });
        return sendJson(res, 409, {
          error: 'conflict',
          version: chart.version,
          chartData: chart.data,
        });
      }
      if (baseVersion === undefined) log({ kind: 'updateChart.legacy', id, who });
      const next = store(chartData);
      const changed = JSON.stringify(next) !== JSON.stringify(chart.data);
      if (changed) {
        chart.data = next;
        chart.version++;
      }
      chart.writes++;
      log({
        kind: 'POST-commit',
        id,
        who,
        baseVersion,
        version: chart.version,
        changed,
        chart: chart.data,
      });
      await sleep(delay * 0.2);
      log({ kind: 'POST-end', id, who, status: 200 });
      sendJson(res, 200, { success: true, version: chart.version });
    },

    async pollChart(req, res, url, who) {
      const { editToken, knownVersion } = JSON.parse((await readBody(req)).toString());
      const { delay, status, readAt = delay / 2 } = latencyOf(who, 'pollChart');
      log({ kind: 'POLL-start', who, knownVersion });
      await sleep(readAt);
      const chart = charts.get(editToken);
      if (!chart) return sendJson(res, 404, { error: 'Chart not found or invalid edit token' });
      if (status >= 400) return sendJson(res, status, { error: 'Failed to poll chart' });
      const changed = chart.version !== knownVersion;
      const payload = changed
        ? { version: chart.version, chartData: chart.data }
        : { version: chart.version };
      await sleep(delay - readAt);
      log({ kind: 'POLL', who, knownVersion, version: chart.version, changed, delay });
      sendJson(res, 200, payload);
    },

    async 'upload-file'(req, res, url, who) {
      const raw = (await readBody(req)).toString('latin1');
      const chartId = /name="chart_id"\r\n\r\n([^\r]*)\r\n/.exec(raw)?.[1];
      const filename = /filename="([^"]*)"/.exec(raw)?.[1] ?? 'upload.pdf';
      const n = ++counters.uploadFile;
      log({ kind: 'UPLOAD', who, chartId, filename, editToken: req.headers['x-edit-token'] });
      await sleep(config.latency.upload);
      sendJson(res, 200, {
        file_id: `file-${n}`,
        filename,
        mime_type: 'application/pdf',
        size_bytes: raw.length,
      });
    },

    async 'anthropic-stream'(req, res, url, who) {
      await readBody(req);
      const { ms, edits, text } = aiQueue.shift() ?? DEFAULT_AI;
      log({ kind: 'AI-start', who, ms });
      const reply =
        '[EDIT_INSTRUCTIONS]\n' +
        JSON.stringify(edits ?? []) +
        '\n[/EDIT_INSTRUCTIONS]\n' +
        (text ?? 'Done.');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      send({
        type: 'message_start',
        message: { id: 'm', usage: { input_tokens: 10, output_tokens: 1 } },
      });
      send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      send({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Thinking... ' },
      });
      await sleep(ms);
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } });
      send({ type: 'content_block_stop', index: 0 });
      send({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 20 },
      });
      send({ type: 'message_stop' });
      log({ kind: 'AI-end', who });
      res.end();
    },
  };

  const small = {
    'verify-turnstile': (req) => (req.method === 'GET' ? { valid: true } : { ok: true }),
    'count-tokens-estimate': () => ({ input_tokens: 10, estimated_cost_usd: 0.001 }),
    usage: () => ({ used_usd: 0, byok_used_usd: 0, limit_usd: 5, tier: 'anon', byok_last4: null }),
    'logging-preference': () => ({ success: true, optOut: true }),
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const who = whoOf(req);
    const name = url.pathname.replace(/^\/api\//, '');
    try {
      if (url.pathname === '/api/__probe') {
        const o = JSON.parse((await readBody(req)).toString());
        log({ kind: 'probe', who: o.who, pk: o.kind, detail: o.detail, at: o.t });
        res.writeHead(204);
        return res.end();
      }
      if (handlers[name]) return await handlers[name](req, res, url, who);
      if (small[name]) {
        await readBody(req);
        return sendJson(res, 200, small[name](req));
      }
      if (name.startsWith('logging-')) {
        await readBody(req);
        return sendJson(res, 200, { success: true, sessionId: 'mock', optOut: true });
      }
      if (name.startsWith('files/') || name === 'chart-files' || name === 'reconcile-cost') {
        await readBody(req);
        return sendJson(res, 200, { success: true });
      }
      log({ kind: 'unhandled', path: url.pathname, method: req.method, who });
      sendJson(res, 404, { error: 'not mocked' });
    } catch (error) {
      log({ kind: 'mock-error', path: url.pathname, error: String(error?.stack ?? error) });
      if (!res.headersSent) sendJson(res, 500, { error: 'mock failure' });
    }
  });

  const ready = new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () => {
      log({ kind: 'boot', port });
      resolve();
    }),
  );

  const stateOf = (token) => charts.get(token);
  const waitFor = async (predicate, { timeout = 15_000, every = 50, what = 'condition' } = {}) => {
    const t0 = Date.now();
    for (;;) {
      const value = predicate();
      if (value) return value;
      if (Date.now() - t0 > timeout)
        throw new Error(`timed out after ${timeout} ms waiting for ${what}`);
      await sleep(every);
    }
  };

  return {
    ready,
    port,
    events,
    config,
    counters,
    log,
    mark: (label) => log({ kind: 'mark', label }),
    /** Creates a chart with the given edit token, replacing any chart already there. */
    newChart(token, { ids }) {
      charts.set(token, {
        id: `c-${token}`,
        data: store(seedChart({ ids })),
        version: 1,
        writes: 0,
      });
    },
    /** `{ version, writes, chart }` of a chart as stored (a copy). */
    state(token) {
      const chart = stateOf(token);
      return chart && { version: chart.version, writes: chart.writes, chart: store(chart.data) };
    },
    /** Writes a chart as a third party would (no request, no latency): bumps the version if it changed. */
    writeDirect(token, chart) {
      const stored = charts.get(token);
      const next = store(chart);
      if (JSON.stringify(next) !== JSON.stringify(stored.data)) {
        stored.data = next;
        stored.version++;
      }
      stored.writes++;
      log({ kind: 'direct-write', token, version: stored.version, chart: stored.data });
    },
    /**
     * The next request of `kind` by `who` takes `delay` ms and/or answers `status`. A poll reads the
     * chart `readAt` ms in (default: half way), so a slow poll can be made to carry a change made
     * while it is in flight.
     */
    next(who, kind, options) {
      (queued[`${who}:${kind}`] ??= []).push(options);
    },
    /** The next AI reply streams for `ms` and ends with these edit instructions. */
    nextAi(options) {
      aiQueue.push(options);
    },
    waitFor,
    /** Events recorded after index `from` that match. */
    since: (from, predicate) => events.slice(from).filter(predicate),
    async stop() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
