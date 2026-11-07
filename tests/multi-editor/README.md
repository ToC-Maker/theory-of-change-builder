# Two-browser acceptance for simultaneous editing

Scenarios that put two real Chrome windows on one chart and make the people in them act at awkward
moments: a remote change landing while someone types, drags, composes text with an input method, or
has an editor open on something that is deleted. jsdom cannot show these. Each scenario ends by
checking that **no edit was lost**: the server's chart and what both pages hold equal what the merge
rules predict, typed text is intact, and focus and caret stayed where they were.

The Worker is replaced by a versioned mock (`lib/mock.mjs`); no database or real Worker is involved.
This is not part of CI or `npm test`: nothing here matches a vitest include glob, and the files are
`.mjs` (plus `lib/probe.js` and `lib/auth-stub.jsx`), which the repo's lint rules do not cover. Run it
by hand when the sync code changes.

## Run the scenarios

1. Have a checkout with `node_modules` (its Vite is used), the `agent-browser` CLI, and free ports.
   Do not use 5173 or 8787: they are the maintainer's dev servers, and the runner refuses them.
   Do not run `npm run dev` or `wrangler dev` for this.
2. Pick an output directory outside the repo for logs and screenshots, and run from the checkout:

   ```bash
   OUT=$(mktemp -d)
   fnm exec --using=24.15.0 -- node tests/multi-editor/run.mjs \
     --root "$PWD" --out "$OUT" --web-port 5311 --mock-port 8911 \
     [--only stale-editor,title-typing-across-landing] [--runs 3]
   ```

3. The scenario `legacy-tab` needs a checkout of the previous client, served read-only. Without
   `--old-root` it is left out when all scenarios run, and an error when named with `--only`:

   ```bash
   ... --old-root /path/to/previous-client-checkout --old-port 5312
   ```

4. To run two processes side by side, give each its own `--session`, `--web-port`, `--mock-port`
   (and `--old-port`, if both run `legacy-tab`).

The process exits 1 if any run lost an edit or errored, and prints the results table (also written to
`$OUT/results.json`). It stops its Vite servers and closes its browsers when it ends.

## Find out why a run failed

1. Open `$OUT/results.json`: each run lists its `lost` messages, `error` and `notes`.
2. Open `$OUT/shots/<scenario>-<case>-<n>-{A,B}-failure.png`, the pages when the run ended.
3. Read the requests of the run in `$OUT/events.ndjson` between the marks
   `<scenario>-<case>-<n> begin` and `... end`. Each `POST-start`, `POST-commit`, `POST-409`, `POLL`
   and `CREATE-end` is there, a `POST-commit` carries the whole stored chart, and the pages' console
   errors and save-pill changes are `probe` events in the same stream.
4. An `ERROR` is not a loss. It means a scenario threw: a gesture did not register, a timing it needs
   did not happen (for example a slow poll that did not carry the other person's change), or the tab
   stopped answering. The table counts errors separately from lost edits.

## Reference

### Options of `run.mjs`

| Option                                    | Meaning                                                                             |
| ----------------------------------------- | ----------------------------------------------------------------------------------- |
| `--root`                                  | Checkout under test. Vite runs with it as the working directory.                    |
| `--old-root`                              | Checkout of the previous client, for `legacy-tab`.                                  |
| `--out`                                   | Directory for `events.ndjson`, `shots/`, `results.json` and Vite logs.              |
| `--only`                                  | Comma-separated scenario names. Default: all.                                       |
| `--runs`                                  | Runs per case, replacing each scenario's own count. A positive integer.             |
| `--web-port`, `--mock-port`, `--old-port` | Ports for the client, the mock and the previous client (defaults 5311, 8911, 5312). |
| `--session`                               | Prefix of the `agent-browser` session names (`<prefix>-A`, `-B`, `-old`).           |

### Files

| Path               | Contents                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `run.mjs`          | Starts the mock, Vite and the browsers; runs each scenario case `runs` times; prints the table.                |
| `serve-client.mjs` | Vite on a checkout with Auth0 stubbed and `/api` proxied to the mock. Writes nothing into the checkout.        |
| `lib/mock.mjs`     | The versioned Worker stand-in (below).                                                                         |
| `lib/browser.mjs`  | One Chrome per `agent-browser` session, driven over DevTools: pointer, keys, IME, file choosers, page scripts. |
| `lib/probe.js`     | Injected before the app: reports console errors, pill and title changes; exposes the app's chart document.     |
| `lib/editors.mjs`  | What a person does on the canvas, what a page shows, and `settle` (pages and server agree).                    |
| `lib/remote.mjs`   | What the other person does mid-gesture (retitle, move, delete).                                                |
| `lib/holds.mjs`    | Timing of a gesture held across a poll tick or a slow poll answer.                                             |
| `lib/oracle.mjs`   | The checks every scenario ends with.                                                                           |
| `lib/chart.mjs`    | Seed chart and helpers over the chart wire shape.                                                              |
| `scenarios/*.mjs`  | One file per behaviour. Each exports `name` and `run(ctx, case)`, and optionally `cases`, `runs`, `needs`.     |

### The mock

Mirrors `worker/api/{getChart,createChart,updateChart,pollChart}.ts`:

- `charts.version` is an integer per chart, bumped by a write that changes the stored chart (key order
  ignored, as jsonb does); an identical write leaves it.
- `updateChart` with `baseVersion` is compare-and-swap at the commit point, after the simulated
  latency: 200 `{success, version}`, or 409 `{error: 'conflict', version, chartData}`.
- `updateChart` without `baseVersion` is the legacy last-write-wins path, logged as
  `updateChart.legacy`.
- `pollChart {editToken, knownVersion}` answers `{version}`, plus `chartData` when the versions differ.
- Also served: `getChart`, `createChart`, `upload-file`, a streaming `anthropic-stream` whose reply
  (edit instructions and duration) the scenario queues, and stubs for the endpoints the app calls on
  load. An endpoint it does not know is logged as `unhandled` and answers 404.
- A scenario can delay a given editor's next request of a kind, and make a poll read the chart late.

Which editor made a request is read from the page URL's `?who=`.

Charts start from a seed with six nodes in two sections (`lib/chart.mjs`). Odd runs of a case start
from a chart whose sections and columns have stored ids, even runs from one that has none.

### Scenarios

| Scenario | What happens | Cases |
| --- | --- | --- |
| `stale-editor` | A saves an edit; B, which has not polled yet, edits another node and saves. | one |
| `node-drag-vs-remote-change` | A holds a node drag for several seconds; B retitles another node, moves the same node elsewhere, or deletes it. | `tick` (a poll tick falls inside the hold) or `mid` (a slow answer carrying B's change arrives mid-drag) x `other`, `move`, `delete` |
| `connection-drag-vs-remote-change` | A holds a new connection n1 to n4 over n4; B retitles another node, deletes n1 or n4, or moves n4. | `tick` or `mid` x `other`, `delete-source`, `delete-target`, `move-target` |
| `bend-drag-vs-remote-change` | A drags the midpoint handle of n1 to n3 (adding a bend); B retitles another node or deletes the connection. | `tick`, `mid`, or `sweep` (the pointer never rests across the answer) x `other`, `delete-connection` |
| `title-typing-across-landing` | A types into a node title while B's change to another node lands. | keys 300, 250 or 120 ms before the answer, or the last key inside its response handler |
| `details-typing-across-landing` | A types into the rich-text details editor inside the response handler of a poll carrying B's change. | one |
| `title-focus-through-landing` | A's title input has focus with the caret inside the text when B's change lands. | `typed-then-409`, `idle-poll`, `idle-poll-same-field` |
| `continuous-typing-across-landings` | A types without pausing for 16 s while B retitles n6 three times. | one |
| `details-remote-rewrite` | B rewrites the details A has open and focused; A then presses the toolbar Undo and Ctrl+Z. | one |
| `ime-composition-during-landing` | A is mid-composition with an input method in the title when a change to another field lands. | `other-node`, `same-node-other-fields` |
| `open-editor-vs-remote-delete` | A has an editor open on something B deletes. | `edge-editor`, `node-editor-idle`, `node-editor-typed-before-landing`, `node-editor-typed-across-landing` |
| `ai-reply-merges` | A chat reply streams for 14 s while people edit. | `edits-elsewhere`, `yields-on-same-field`, `edit-of-deleted-node`, `column-insert-during-drag` |
| `connection-drags-while-other-saves` | A draws 15 connections one after another while B saves about every 2 s. | one |
| `create-chart-races` | Two things on the start page need a chart on the server at once. | `two-pdfs-one-pick`, `two-pdfs-two-picks`, `chat-and-share-at-once` |
| `legacy-tab` | A tab on the previous client saves without a version while a current tab edits. Needs `--old-root`. | `old-saves-while-new-is-stale`, `old-saves-while-new-types`, `old-tab-overwrites-newer-edit` |

A run counts as lost an edit when the server's chart or a page differs from the outcome the merge
rules predict (in `shared/chart-merge.ts`), typed text is missing or reordered, a page does not
settle on the server's chart, or focus or caret moved. Every run ends by waiting for both pages and
the server to agree (`settle`): saved pill, no unsaved change, the server's version, the same chart.

`legacy-tab` / `old-tab-overwrites-newer-edit` is expected behaviour, not a loss: an old tab can
overwrite a collaborator, as before versions. The scenario checks that it happens that way and that
the current tab then follows the server.

### Clients known to lose edits

The scenarios were also run against two clients that lose edits, to see that the checks fail:

| Client | Scenario | Result |
| --- | --- | --- |
| The previous client (`--root` its checkout) | `stale-editor` | A's edit is erased by B's whole-chart save: 3 of 3 runs lost. |
| A copy of the current client whose `ChartDocument.adopt` drops the preview layer on every landing | `title-typing-across-landing` | Typed text lost in all 12 runs (3 per case). |
| The same copy | `continuous-typing-across-landings` | 3 of 3 runs lost typed text and moved the caret (4 caret jumps counted). |
| The same copy | `details-typing-across-landing` | Not flagged (0 of 3 runs): that scenario's keystroke has not always been pending when the landing arrives. |

### Results

Last full run: 226 runs of 48 cases, 0 lost edits, 0 caret jumps (counted in
`continuous-typing-across-landings`; the other scenarios check the caret per sample and report a move
as a lost edit), 3 errors. The errors are runs in which `agent-browser` replaced a tab that had
stopped answering under memory pressure ("the tab was closed or replaced", or a call with no answer
after 60 s); each such case was run again, which is why those rows show more runs than their
scenario's count. `runs` counts every run, errored ones included.

| scenario | case | runs | lost edits | caret jumps | errors | notes |
|---|---|---|---|---|---|---|
| continuous-typing-across-landings | default | 6 | 0 | 0 | 0 | 16 s of typing mid-text across three landings; caret one place right of the last key after every key |
| details-remote-rewrite | default | 5 | 0 | 0 | 0 | caret moves to the start of the details editor (by design), editor keeps focus; toolbar Undo is disabled after the landing; Undo and Ctrl+Z (twice each) keep B's text and A saves nothing |
| details-typing-across-landing | default | 8 | 0 | 0 | 0 | key typed inside the response handler; focus kept, text on the server |
| ime-composition-during-landing | other-node | 5 | 0 | 0 | 0 | composition not interrupted (one compositionstart, ends at the commit), same input element |
| ime-composition-during-landing | same-node-other-fields | 5 | 0 | 0 | 0 | as above; the collaborator's details, width and colour kept |
| legacy-tab | old-saves-while-new-is-stale | 4 | 0 | 0 | 0 | old tab's legacy save applied; current tab answered 409 and merged |
| legacy-tab | old-saves-while-new-types | 4 | 0 | 0 | 0 | typed text and the old tab's change both on the server |
| legacy-tab | old-tab-overwrites-newer-edit | 4 | 0 | 0 | 0 | documented transition behaviour: the old tab's whole-chart save reverts the current tab's edit; the current tab then follows the server |
| open-editor-vs-remote-delete | edge-editor | 5 | 0 | 0 | 0 | edge editor closes; connection stays deleted, nothing re-created |
| open-editor-vs-remote-delete | node-editor-idle | 5 | 0 | 0 | 0 | node editor closes; node stays deleted |
| open-editor-vs-remote-delete | node-editor-typed-before-landing | 5 | 0 | 0 | 0 | node stays with the typed title (409 merge) |
| open-editor-vs-remote-delete | node-editor-typed-across-landing | 9 | 0 | 0 | 1 | node stays with the typed title |
| stale-editor | default | 6 | 0 | 0 | 0 | B's stale save answered 409 and merged; both edits on server and both pages |
| title-focus-through-landing | typed-then-409 | 6 | 0 | 0 | 0 | caret and focus kept through a 409 merge; the next key lands at the caret |
| title-focus-through-landing | idle-poll | 6 | 0 | 0 | 0 | caret and focus kept through an idle poll landing |
| title-focus-through-landing | idle-poll-same-field | 6 | 0 | 0 | 0 | B rewrote the focused title: input follows B's text, keeps focus, caret moves to the end |
| title-typing-across-landing | keys-300-190-80 | 8 | 0 | 0 | 0 | typed text kept, focus and caret kept; which keys ran before the landing varies run to run |
| title-typing-across-landing | keys-250-150-60 | 8 | 0 | 0 | 0 | as above |
| title-typing-across-landing | keys-120-80-40 | 8 | 0 | 0 | 0 | as above |
| title-typing-across-landing | last-key-in-response-handler | 8 | 0 | 0 | 0 | last key typed inside the poll's response handler |
| ai-reply-merges | edits-elsewhere | 4 | 0 | 0 | 0 | B's edit, A's hand edit and the reply's edit all kept |
| ai-reply-merges | yields-on-same-field | 4 | 0 | 0 | 0 | B's title wins over the reply's on the same field; the reply's other edit applied |
| ai-reply-merges | edit-of-deleted-node | 4 | 0 | 0 | 0 | node B deleted stays deleted |
| ai-reply-merges | column-insert-during-drag | 4 | 0 | 0 | 0 | reply inserts a column while A holds a node drag; the node lands in the column under the pointer |
| bend-drag-vs-remote-change | tick-other | 3 | 0 | 0 | 0 | A's bend on n1->n3 and B's retitle kept |
| bend-drag-vs-remote-change | tick-delete-connection | 3 | 0 | 0 | 0 | connection stays deleted; both ends remain |
| bend-drag-vs-remote-change | mid-other | 3 | 0 | 0 | 0 | A's bend on n1->n3 and B's retitle kept |
| bend-drag-vs-remote-change | mid-delete-connection | 3 | 0 | 0 | 0 | connection stays deleted; both ends remain |
| bend-drag-vs-remote-change | sweep-other | 3 | 0 | 0 | 0 | A's bend on n1->n3 and B's retitle kept (the pointer never rests across the answer) |
| bend-drag-vs-remote-change | sweep-delete-connection | 7 | 0 | 0 | 1 | connection stays deleted; both ends remain (the pointer never rests across the answer) |
| connection-drag-vs-remote-change | tick-other | 3 | 0 | 0 | 0 | new connection n1->n4 and B's retitle kept |
| connection-drag-vs-remote-change | tick-delete-source | 3 | 0 | 0 | 0 | n1 stays deleted; no connection created |
| connection-drag-vs-remote-change | tick-delete-target | 3 | 0 | 0 | 0 | n4 stays deleted; no dangling connection |
| connection-drag-vs-remote-change | tick-move-target | 3 | 0 | 0 | 0 | connection to n4 kept; n4 where B put it |
| connection-drag-vs-remote-change | mid-other | 3 | 0 | 0 | 0 | new connection n1->n4 and B's retitle kept |
| connection-drag-vs-remote-change | mid-delete-source | 3 | 0 | 0 | 0 | n1 stays deleted; no connection created |
| connection-drag-vs-remote-change | mid-delete-target | 3 | 0 | 0 | 0 | n4 stays deleted; no dangling connection |
| connection-drag-vs-remote-change | mid-move-target | 3 | 0 | 0 | 0 | connection to n4 kept; n4 where B put it |
| connection-drags-while-other-saves | default | 3 | 0 | 0 | 0 | 15 drags per run; all 15 new connections on the server; B saved about every 2 s |
| create-chart-races | two-pdfs-one-pick | 4 | 0 | 0 | 0 | one create, two uploads to it, URL and document on it |
| create-chart-races | two-pdfs-two-picks | 4 | 0 | 0 | 0 | as above |
| create-chart-races | chat-and-share-at-once | 4 | 0 | 0 | 0 | two charts created, the URL, document and Share dialog follow one; the other is unused (by design) |
| node-drag-vs-remote-change | tick-other | 8 | 0 | 0 | 1 | B's retitle kept; n1 in the column A dropped it on |
| node-drag-vs-remote-change | tick-move | 4 | 0 | 0 | 0 | n1 once, in A's drop column (A's save lands last) |
| node-drag-vs-remote-change | tick-delete | 4 | 0 | 0 | 0 | n1 deleted: a move loses to a delete; not resurrected |
| node-drag-vs-remote-change | mid-other | 4 | 0 | 0 | 0 | B's retitle kept; n1 in the column A dropped it on |
| node-drag-vs-remote-change | mid-move | 4 | 0 | 0 | 0 | n1 once, in A's drop column (A's save lands last) |
| node-drag-vs-remote-change | mid-delete | 4 | 0 | 0 | 0 | n1 deleted: a move loses to a delete; not resurrected |
| **total** | | **226** | **0** | **0** | **3** | |

## Timing in this environment

On the machine these results come from (React in development mode, headless Chrome, memory
pressure), one keystroke into the title input costs the page 0.5 to 0.9 s from event to the second
frame, measured with a long-task observer and the probe off; the previous client costs the same.
Scenarios that type "just before a landing" therefore cannot choose which side of the landing a key
falls on to within milliseconds. They type from in-page timers and from the poll's response handler,
let the interleaving vary from run to run, and describe the expected outcome for every ordering
(typed text is the base plus the keys in the order they ran).

Under memory pressure `agent-browser` sometimes replaces a tab that stopped answering. The runner
times out calls, reopens a tab that does not answer, and reopens all browsers after a run that
threw; such a run is an error in the table.
