// Wave 1 Critical-class behavioral gaps for the auth-vs-anon dispatch and
// the privacy guarantees baked into the delete-my-data cascade. The tests
// pass a recording `sql` template-tag stub so we can assert exactly which
// tables each transaction touches without standing up a database.
//
// What's load-bearing here:
//   1. Anon callers must NEVER run the BYOK delete branch — even when
//      `tocb_auth_link` resolves to an auth sub. The fresh-JWT-required rule
//      is what protects users from a stale auth-link cookie wiping their
//      BYOK key without a fresh log-in.
//   2. The anon `sql.transaction([...])` array must NOT contain a write to
//      `user_byok_keys`. Auth's separate BYOK transaction does, anon's
//      doesn't. (Two arrays compared structurally.)
//   3. Neither auth nor anon transaction touches `user_api_usage` — that's
//      the LIA §1B carve-out (anti-abuse cap, separate Art 6(1)(f) basis).
//   4. The cookie-clear response keeps `tocb_actor_id` so the anon cap row
//      stays attached to the browser; clears `tocb_anon` + `tocb_auth_link`.
//   5. The audit row binds `user_id = NULL` so the same request's cascade
//      (`DELETE FROM logging_errors WHERE user_id = ${userId}`) doesn't wipe
//      the row that records the cascade itself.
import { describe, expect, it } from 'vitest';
import {
  buildByokDeleteStatements,
  buildCascadeStatements,
  buildClearedCookieHeaders,
  COOKIES_TO_CLEAR_ON_DATA_DELETE,
  COOKIES_TO_PRESERVE_ON_DATA_DELETE,
  insertPendingAuditRow,
  shouldRunByokDelete,
} from '../../worker/api/delete-my-data';

// Recording template-tag stub. The `sql` value here doubles as a tag-call
// recorder and a `.transaction` no-op — but we never invoke .transaction in
// these tests, we just inspect what got bound. Each tag-call returns the
// recorded entry so the helpers' arrays-of-pending-statements have stable
// values for inspection.
type Recorded = { strings: readonly string[]; values: readonly unknown[] };
function makeRecordingSql() {
  const calls: Recorded[] = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const entry: Recorded = { strings: [...strings], values };
    calls.push(entry);
    return entry;
  };
  // The Sql type also has a .transaction method; we never call it in unit
  // tests, but we attach a stub so the cast in the helper signature works.
  (tag as unknown as { transaction: (q: unknown[]) => Promise<unknown[]> }).transaction = async (
    q,
  ) => q;
  return { calls, sql: tag as unknown as Parameters<typeof buildCascadeStatements>[0] };
}

// Compact "what tables are touched" view of a list of recorded tag-calls.
// Lower-cases so we don't depend on capitalization in the SQL fragments.
function tablesTouched(entries: Recorded[]): string[] {
  return entries.map((e) => e.strings.join(' ').toLowerCase());
}

// Predicate: does ANY of the recorded statement strings touch the given
// fully-qualified table reference (e.g. "user_byok_keys", "user_api_usage").
// Looks for either `from <table>` or `update <table>` (lowercased) so we
// don't false-positive on column names that happen to share a prefix.
function statementsTouchTable(entries: Recorded[], table: string): boolean {
  const t = table.toLowerCase();
  return tablesTouched(entries).some((s) => s.includes(`from ${t}`) || s.includes(`update ${t}`));
}

describe('shouldRunByokDelete (auth-vs-anon dispatch — DO NOT trust tocb_auth_link)', () => {
  it('returns true ONLY when authenticated=true (fresh JWT verified)', () => {
    expect(shouldRunByokDelete(true)).toBe(true);
  });

  it('returns false for the anon path even when tocb_auth_link would resolve to an auth sub', () => {
    // The case that motivates this test: resolveAnonActor can return a userId
    // that's actually an Auth0 sub (because tocb_auth_link is signed with the
    // server's HMAC and points at the user's last-known sub). A naïve
    // dispatcher might treat that as "we know who they are, run BYOK delete"
    // — and a stale auth-link cookie would silently wipe the BYOK key. The
    // rule is: resolveIdentity hard-codes authenticated=false on the anon
    // path, full stop, no exceptions.
    expect(shouldRunByokDelete(false)).toBe(false);
  });

  it('signature only takes authenticated:boolean — there is no place for tocb_auth_link to leak in', () => {
    // Structural lock: as long as the parameter is a single boolean, callers
    // can't accidentally widen the predicate (e.g. by OR-ing in a hasAuthLink
    // signal). This test would break if the signature grew, forcing a
    // re-review of the dispatch rule.
    expect(shouldRunByokDelete.length).toBe(1);
  });
});

describe('buildByokDeleteStatements (BYOK transaction structure by identity)', () => {
  it('returns [] for anon — sql.transaction([]) is a no-op, the anon path never wipes BYOK', () => {
    const { sql, calls } = makeRecordingSql();
    const stmts = buildByokDeleteStatements(sql, false, 'anon-uuid-here');
    expect(stmts).toEqual([]);
    // Tagged-template recorder should also have nothing — buildByokDeleteStatements
    // for anon must not even formulate the strings, let alone bind them.
    expect(calls).toEqual([]);
  });

  it('returns the zeroize+DELETE pair for auth, in that exact order', () => {
    const { sql, calls } = makeRecordingSql();
    const stmts = buildByokDeleteStatements(sql, true, 'auth0|abc123');
    expect(stmts).toHaveLength(2);
    // Order matters: zeroize first so a partial failure between the two
    // statements leaves an unreadable blob rather than the original key.
    expect(calls).toHaveLength(2);
    expect(tablesTouched(calls)[0]).toMatch(/update user_byok_keys/);
    expect(tablesTouched(calls)[1]).toMatch(/delete from user_byok_keys/);
    // Bound user_id appears as a value in both statements, NOT inlined into
    // the SQL strings (parameterization protects against SQL-injection-style
    // tampering of the cascade scope).
    expect(calls[0].values).toContain('auth0|abc123');
    expect(calls[1].values).toContain('auth0|abc123');
  });

  it('compares structurally: auth has user_byok_keys writes, anon has none', () => {
    // Direct restatement of the load-bearing privacy guarantee. If a future
    // refactor accidentally moved the BYOK delete into the anon branch, this
    // assertion would break first.
    const r1 = makeRecordingSql();
    buildByokDeleteStatements(r1.sql, true, 'sub-x');
    expect(statementsTouchTable(r1.calls, 'user_byok_keys')).toBe(true);

    const r2 = makeRecordingSql();
    buildByokDeleteStatements(r2.sql, false, 'sub-x');
    expect(statementsTouchTable(r2.calls, 'user_byok_keys')).toBe(false);
  });
});

describe('buildCascadeStatements (anon cascade does NOT touch user_byok_keys, NEITHER touches user_api_usage)', () => {
  it('anon cascade does not include a write to user_byok_keys', () => {
    // The anon main-cascade transaction. BYOK is supposed to be handled by
    // a separate Phase-2c transaction (which buildByokDeleteStatements skips
    // for anon), so the main cascade for anon should also be byok-free.
    const { sql, calls } = makeRecordingSql();
    buildCascadeStatements(sql, false, 'anon-uuid', [], []);
    expect(statementsTouchTable(calls, 'user_byok_keys')).toBe(false);
  });

  it('auth cascade also does not include a write to user_byok_keys (BYOK is a separate transaction)', () => {
    // Even the auth main cascade does not touch user_byok_keys: the BYOK
    // delete is an explicit second transaction so we can RETURNING to know
    // whether a row actually existed. If a refactor folded BYOK into the
    // main cascade we'd lose that signal — this test would catch it.
    const { sql, calls } = makeRecordingSql();
    buildCascadeStatements(sql, true, 'auth0|abc', [], []);
    expect(statementsTouchTable(calls, 'user_byok_keys')).toBe(false);
  });

  it('NEITHER auth nor anon cascade touches user_api_usage (LIA §1B cap-preservation)', () => {
    // The cap row in user_api_usage is preserved under a separate Art 6(1)(f)
    // anti-abuse basis; the GDPR Art. 17 "delete my data" entry point must
    // not wipe it. Removing this assertion would silently regress the
    // cap-preservation guarantee documented in CLAUDE.md and the LIA.
    const auth = makeRecordingSql();
    buildCascadeStatements(auth.sql, true, 'auth0|abc', ['c1'], ['c2']);
    expect(statementsTouchTable(auth.calls, 'user_api_usage')).toBe(false);

    const anon = makeRecordingSql();
    buildCascadeStatements(anon.sql, false, 'anon-uuid', ['c1'], ['c2']);
    expect(statementsTouchTable(anon.calls, 'user_api_usage')).toBe(false);
  });

  it('auth cascade has exactly one extra statement compared to anon (DELETE FROM logging_preferences)', () => {
    // Locks the structural difference: auth wipes logging_preferences (keyed
    // on Auth0 sub), anon doesn't (no anon row exists). If a future refactor
    // accidentally added a second auth-only statement (or removed this one),
    // the count delta would break.
    const auth = makeRecordingSql();
    buildCascadeStatements(auth.sql, true, 'auth0|abc', [], []);
    const anon = makeRecordingSql();
    buildCascadeStatements(anon.sql, false, 'anon-uuid', [], []);
    expect(auth.calls.length - anon.calls.length).toBe(1);
    // The only auth-extra statement is logging_preferences.
    const extra = tablesTouched(auth.calls).filter(
      (s) => !tablesTouched(anon.calls).some((a) => a === s),
    );
    expect(extra).toHaveLength(1);
    expect(extra[0]).toMatch(/delete from logging_preferences/);
  });

  it('uses parameterized userId binding in every per-user statement (no SQL-string interpolation)', () => {
    // Cross-cutting invariant: userId always rides on the values side of
    // the tagged template, never on the strings side. A regression here
    // would mean Postgres sees `userId` literal-pasted into the SQL — which
    // is both an injection vector and a query-plan-cache pollution issue.
    const { sql, calls } = makeRecordingSql();
    const userId = 'auth0|TEST_BIND';
    buildCascadeStatements(sql, true, userId, ['c1'], ['c2']);
    for (const c of calls) {
      // userId must NOT be inside the SQL string template; it should only
      // appear in the `values` array on the per-statement binding side.
      expect(c.strings.join(' ')).not.toContain(userId);
    }
    // And it must appear at least once in the values across the cascade.
    const allValues = calls.flatMap((c) => c.values);
    expect(allValues).toContain(userId);
  });
});

describe('buildClearedCookieHeaders (cookie-clear response shape)', () => {
  it('clears tocb_anon and tocb_auth_link, both via Max-Age=0 + Expires-in-the-past', () => {
    const headers = buildClearedCookieHeaders();
    // One Set-Cookie header per cookie cleared; constants list captures the
    // shape so we can iterate without hard-coding names twice.
    expect(headers).toHaveLength(COOKIES_TO_CLEAR_ON_DATA_DELETE.length);
    for (const name of COOKIES_TO_CLEAR_ON_DATA_DELETE) {
      const matching = headers.find((h) => h.startsWith(`${name}=`));
      expect(matching).toBeDefined();
      // Both deletion mechanisms in one header (RFC 6265 §3.1) — Max-Age=0
      // for modern browsers, Expires-1970 for old ones. Belt + braces.
      expect(matching).toContain('Max-Age=0');
      expect(matching).toContain('1970');
    }
  });

  it('does NOT clear tocb_actor_id — anon cap stays attached to the browser', () => {
    // The privacy boundary: clearing tocb_actor_id would silently mint a
    // fresh anon cap on every "delete my data" press, defeating LIA §1B.
    // This assertion mirrors delete-my-data-helpers.test.ts but lives here
    // too because it's the single most-load-bearing rule in the response
    // shape.
    const headers = buildClearedCookieHeaders();
    expect(headers.every((h) => !h.startsWith('tocb_actor_id='))).toBe(true);
  });

  it('lists tocb_actor_id in the preserved set (counterpart of the no-clear assertion)', () => {
    // Restate the rule from the data side: "preserve" is the documented
    // promise; the test expresses it as a positive assertion. The two
    // constants stay in sync only as long as both the "clears" and
    // "preserves" lists hold the right entries.
    expect(COOKIES_TO_PRESERVE_ON_DATA_DELETE).toContain('tocb_actor_id');
    expect(COOKIES_TO_PRESERVE_ON_DATA_DELETE).not.toContain('tocb_anon');
    expect(COOKIES_TO_PRESERVE_ON_DATA_DELETE).not.toContain('tocb_auth_link');
  });
});

describe('insertPendingAuditRow (audit row survives the cascade self-DELETE)', () => {
  it('binds user_id = NULL on the audit row (NOT the userId argument)', async () => {
    // The cascade does `DELETE FROM logging_errors WHERE user_id = ${userId}`,
    // which would wipe the audit row if it carried that userId. Binding NULL
    // is what saves it. The userId still needs to be queryable for ops, so
    // it lives in request_metadata JSON instead.
    const { sql, calls } = makeRecordingSql();
    await insertPendingAuditRow(sql, 'incident-123', 'auth0|user-x', ['file_a', 'file_b']);
    expect(calls).toHaveLength(1);
    const c = calls[0];
    // The user_id column gets the literal `null` value; the userId string
    // does NOT appear as a top-level binding on its own.
    expect(c.values).toContain(null);
    // The userId is preserved in request_metadata JSON for ops queries.
    const metadataValue = c.values.find(
      (v) => typeof v === 'string' && v.startsWith('{') && v.includes('"user_id"'),
    );
    expect(metadataValue).toBeDefined();
    expect(metadataValue).toContain('"user_id":"auth0|user-x"');
    expect(metadataValue).toContain('"status":"pending"');
  });

  it('binds the file_ids on the audit row so the retry job can replay Anthropic DELETEs', async () => {
    // The whole point of this row is to keep an external-side TODO list. If
    // the file_ids drift out of request_metadata, the retry job has nothing
    // to act on and orphan files at Anthropic stay forever.
    const { sql, calls } = makeRecordingSql();
    await insertPendingAuditRow(sql, 'incident-456', 'auth0|user-y', ['file_x', 'file_y']);
    const metadataValue = calls[0].values.find(
      (v) => typeof v === 'string' && v.startsWith('{') && v.includes('"file_ids"'),
    ) as string | undefined;
    expect(metadataValue).toBeDefined();
    const parsed = JSON.parse(metadataValue!);
    expect(parsed.file_ids).toEqual(['file_x', 'file_y']);
  });

  it('binds errorId so a future caller can update the same row to "partial" or "failed"', async () => {
    const { sql, calls } = makeRecordingSql();
    await insertPendingAuditRow(sql, 'incident-789', 'auth0|user-z', []);
    // errorId is the operator-quotable handle; finalizeAuditRow / record-
    // CascadeFailure look the row up by it.
    expect(calls[0].values).toContain('incident-789');
  });

  it('does NOT bind userId at the same SQL position as user_id (no foot-gun re-use)', async () => {
    // Defensive: ensure the function isn't using the user_id placeholder for
    // the userId argument by accident. The order of values in the binding
    // array must be: errorId, error_name, message, NULL, request_metadata.
    const { sql, calls } = makeRecordingSql();
    await insertPendingAuditRow(sql, 'incident-bind', 'auth0|user-bind', []);
    const values = calls[0].values;
    // errorId is first; user_id placeholder (index 3 in the existing schema)
    // is NULL; request_metadata is last and contains the userId in JSON.
    expect(values[0]).toBe('incident-bind');
    // The NULL must actually be a top-level value bind, not the userId.
    const nullIndex = values.indexOf(null);
    expect(nullIndex).toBeGreaterThanOrEqual(0);
    // userId is NEVER a top-level bind; it's only inside the JSON metadata.
    expect(values).not.toContain('auth0|user-bind');
  });
});
