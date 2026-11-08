// Timing for "the other person changes the chart while A holds a pointer gesture".
//
//   tick: a poll tick falls inside the hold. Polls are skipped while a drag is in flight, so A
//         should not see B's change until it lets go. The hold lasts a poll interval plus
//         TICK_MARGIN_MS after B's change, so a tick falls in it however the ticks line up.
//   mid:  a slow poll is already in flight when the drag starts; its answer carries B's change and
//         arrives mid-drag. The answer is dropped and fetched again after the release.
import { sleep } from './browser.mjs';
import { docState } from './editors.mjs';

export const SLOW_POLL = { delay: 26_000, readAt: 16_000 };
const TICK_MARGIN_MS = 4500;

/** Call before pressing the pointer: returns once A has just polled (tick) or a slow poll is out (mid). */
export async function armHold(ctx, timing, slow = SLOW_POLL) {
  const { mock } = ctx;
  const from = mock.events.length;
  if (timing === 'mid') {
    mock.next('A', 'pollChart', slow);
    await mock.waitFor(
      () => mock.since(from, (e) => e.kind === 'POLL-start' && e.who === 'A').length,
      {
        what: 'the slow poll to start',
      },
    );
  } else {
    await mock.waitFor(() => mock.since(from, (e) => e.kind === 'POLL' && e.who === 'A').length, {
      what: 'a poll tick',
    });
  }
  await sleep(300);
  return { from };
}

/**
 * Call after B's change is on the server, with A still holding: waits through the part of the hold
 * the timing is about, and returns what A's page showed just before the release.
 */
export async function endHold(ctx, timing, armed, snap, slow = SLOW_POLL) {
  const { mock, token, A } = ctx;
  const bVersion = mock.state(token).version;
  if (timing === 'mid') {
    const answered = await mock.waitFor(
      () =>
        mock.since(
          armed.from,
          (e) => e.kind === 'POLL' && e.who === 'A' && e.delay === slow.delay,
        )[0],
      { timeout: 45_000, what: 'the slow poll to answer' },
    );
    await sleep(1500);
    // The slow answer must carry B's change, or the run did not test what it names.
    if (answered.version !== bVersion) {
      throw new Error(
        `slow poll read version ${answered.version} but B's change is version ${bVersion}`,
      );
    }
  } else {
    await sleep(ctx.pollMs + TICK_MARGIN_MS);
  }
  await assertHoldingBack(ctx);
  return snap(A);
}

/**
 * A drag in flight holds landings back: a tick is skipped, an answer is dropped. If A's document has
 * already taken B's version, the drag was not in flight and the run tests something else.
 */
export async function assertHoldingBack({ mock, token, A }) {
  const held = (await docState(A)).status.serverVersion;
  const server = mock.state(token).version;
  if (held >= server) {
    throw new Error(
      `A took version ${server} during the drag: the drag did not hold landings back`,
    );
  }
}
