// Collects what a run got wrong. A scenario's result is its `lost` list: empty means no edit was lost.
import { isDeepStrictEqual } from 'node:util';

export class Checks {
  constructor() {
    this.lost = [];
    this.notes = [];
  }

  /** Records `label` as a loss unless `actual` deep-equals `expected`. */
  eq(label, actual, expected) {
    if (!isDeepStrictEqual(actual, expected)) {
      this.lost.push(
        `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      );
    }
  }

  /** Records `label` as a loss unless `condition` is true. */
  ok(label, condition, detail = '') {
    if (!condition) this.lost.push(detail ? `${label} (${detail})` : label);
  }

  /** A fact worth reporting that is not a loss. */
  note(text) {
    this.notes.push(text);
  }
}
