// Fake Neon HTTP endpoint + Auth0 JWKS for the chart-save and chart-poll
// tests. The real handlers run against a replacement `globalThis.fetch`
// that plays the `/sql` endpoint of @neondatabase/serverless (it POSTs
// {query, params} with `neon-array-mode`, expects text rows plus `fields`
// metadata whose `dataTypeID` tells it how to parse each column) and the
// tenant's JWKS.
//
// Statements are matched by their text, and the fake keeps one `charts`
// row that behaves like the migrated table: `version` starts wherever the
// test puts it and is bumped by the `BEFORE UPDATE OF chart_data` trigger
// whenever a write changes `chart_data`. A compare-and-swap UPDATE whose
// `version` predicate no longer matches returns zero rows, as Postgres
// does after re-checking the WHERE of a blocked UPDATE. Every statement is
// recorded so tests can assert what ran (and what never did).
import { SignJWT, generateKeyPair, exportJWK, type JWK } from 'jose';
import type { Env } from '../../../worker/_shared/types';

export const AUTH0_DOMAIN = 'test-tenant.auth0.example';
export const DOWN_AUTH0_DOMAIN = 'down-tenant.auth0.example';
const AUTH0_CLIENT_ID = 'client-id-test';

export const env = {
  DATABASE_URL: 'postgresql://user:pass@db.test.neon.tech/neondb',
  VITE_AUTH0_DOMAIN: AUTH0_DOMAIN,
  VITE_AUTH0_CLIENT_ID: AUTH0_CLIENT_ID,
} as unknown as Env;

/** Same Worker env, but its Auth0 tenant's JWKS endpoint answers 503. */
export const envWithJwksOutage = { ...env, VITE_AUTH0_DOMAIN: DOWN_AUTH0_DOMAIN } as unknown as Env;

export interface ChartRow {
  id: string;
  edit_token: string;
  user_id: string | null;
  link_sharing_level: string | null;
  version: number;
  chart_data: unknown;
  chart_title?: string;
}

export interface Statement {
  query: string;
  params: unknown[];
}

// Postgres type OIDs the driver uses to parse raw text values.
const TEXT = 25;
const INT4 = 23;
const JSONB = 3802;

function neonResult(command: string, fields: [string, number][], rows: unknown[][]) {
  return {
    command,
    rowCount: rows.length,
    fields: fields.map(([name, dataTypeID]) => ({ name, dataTypeID })),
    rows,
  };
}

/** The statement text on one line, so patterns don't depend on how a template literal is wrapped. */
const flat = (query: string) => query.replace(/\s+/g, ' ').trim();

/** A write returns its row only when the statement asks for it with `RETURNING version`, as Postgres does. */
function returningVersion(q: string, version: number) {
  return neonResult(
    'UPDATE',
    /\bRETURNING version\b/i.test(q) ? [['version', INT4]] : [],
    /\bRETURNING version\b/i.test(q) ? [[String(version)]] : [],
  );
}

/** The value bound to the `$n` that follows `pattern` in the statement text. */
function paramAfter(s: Statement, pattern: RegExp): unknown {
  const m = pattern.exec(flat(s.query));
  if (!m) throw new Error(`Statement has no ${pattern}: ${s.query}`);
  return s.params[Number(m[1]) - 1];
}

export class ChartFake {
  statements: Statement[] = [];
  chart: ChartRow | null = null;
  /** chart_permissions.status by user_id; a missing key means no row. */
  permissions = new Map<string, string>();
  /** Rows inserted into chart_permissions, by user_id. */
  insertedPermissions: string[] = [];
  /** Make the chart disappear right after the gate's lookup (a concurrent delete). */
  vanishAfterGate = false;

  private privateKey!: CryptoKey;
  private roguePrivateKey!: CryptoKey;
  private publicJwk!: JWK;
  private originalFetch = globalThis.fetch;

  async install() {
    const real = await generateKeyPair('RS256');
    this.privateKey = real.privateKey;
    this.publicJwk = {
      ...(await exportJWK(real.publicKey)),
      kid: 'test-key',
      alg: 'RS256',
      use: 'sig',
    };
    this.roguePrivateKey = (await generateKeyPair('RS256')).privateKey;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      if (url.pathname === '/.well-known/jwks.json') {
        if (url.hostname === AUTH0_DOMAIN) return Response.json({ keys: [this.publicJwk] });
        if (url.hostname === DOWN_AUTH0_DOMAIN) return new Response('down', { status: 503 });
      }
      // The driver rewrites the connection string's host label (db.… →
      // api.…), so match the /sql path instead.
      if (url.pathname === '/sql' && req.method === 'POST') {
        const statement = (await req.json()) as Statement;
        this.statements.push(statement);
        return Response.json(this.handle(statement));
      }
      throw new Error(`Unexpected outbound fetch in test: ${req.method} ${req.url}`);
    }) as typeof fetch;
  }

  uninstall() {
    globalThis.fetch = this.originalFetch;
  }

  reset(chart: ChartRow | null) {
    this.statements = [];
    this.chart = chart;
    this.permissions = new Map();
    this.insertedPermissions = [];
    this.vanishAfterGate = false;
  }

  /** Statements that wrote anything. */
  writes(): Statement[] {
    return this.statements.filter((s) => /^(UPDATE|INSERT|DELETE)\b/i.test(flat(s.query)));
  }

  /** The chart UPDATEs (not view_count or permissions inserts). */
  chartUpdates(): Statement[] {
    return this.statements.filter((s) => /^UPDATE charts SET chart_data/i.test(flat(s.query)));
  }

  async signToken(
    { sub = 'auth0|owner', expiresIn = '1h' }: { sub?: string; expiresIn?: string | number } = {},
    { rogue = false, domain = AUTH0_DOMAIN } = {},
  ): Promise<string> {
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setSubject(sub)
      .setIssuer(`https://${domain}/`)
      .setAudience(AUTH0_CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime(expiresIn)
      .sign(rogue ? this.roguePrivateKey : this.privateKey);
  }

  private handle(s: Statement) {
    const q = flat(s.query);
    const chart = this.chart;

    if (/^SELECT status FROM chart_permissions/i.test(q)) {
      const status = this.permissions.get(String(paramAfter(s, /user_id = \$(\d+)/)));
      return neonResult('SELECT', [['status', TEXT]], status ? [[status]] : []);
    }
    if (/^INSERT INTO chart_permissions/i.test(q)) {
      this.insertedPermissions.push(String(s.params[1]));
      return neonResult('INSERT', [], []);
    }
    if (/^INSERT INTO charts/i.test(q)) {
      return returningVersion(q, 1);
    }

    const tokenMatches = (c: ChartRow | null): c is ChartRow =>
      c !== null && c.edit_token === paramAfter(s, /edit_token = \$(\d+)/);

    // The gate's lookup.
    if (/^SELECT id, user_id, link_sharing_level FROM charts/i.test(q)) {
      const rows = tokenMatches(chart) ? [[chart.id, chart.user_id, chart.link_sharing_level]] : [];
      if (this.vanishAfterGate) this.chart = null;
      return neonResult(
        'SELECT',
        [
          ['id', TEXT],
          ['user_id', TEXT],
          ['link_sharing_level', TEXT],
        ],
        rows,
      );
    }
    // The poll's lookup: chart_data only when the version differs.
    if (/^SELECT version, CASE WHEN version <>/i.test(q)) {
      const known = Number(paramAfter(s, /version <> \$(\d+)/));
      const rows = tokenMatches(chart)
        ? [
            [
              String(chart.version),
              chart.version !== known ? JSON.stringify(chart.chart_data) : null,
            ],
          ]
        : [];
      return neonResult(
        'SELECT',
        [
          ['version', INT4],
          ['chart_data', JSONB],
        ],
        rows,
      );
    }
    // The conflict read after a compare-and-swap miss.
    if (/^SELECT version, chart_data FROM charts/i.test(q)) {
      const rows = tokenMatches(chart)
        ? [[String(chart.version), JSON.stringify(chart.chart_data)]]
        : [];
      return neonResult(
        'SELECT',
        [
          ['version', INT4],
          ['chart_data', JSONB],
        ],
        rows,
      );
    }
    // The save: compare-and-swap when the statement has a version predicate.
    if (/^UPDATE charts SET chart_data/i.test(q)) {
      const hasBase = /AND version = \$\d+/i.test(q);
      const matches =
        tokenMatches(chart) &&
        (!hasBase || chart.version === Number(paramAfter(s, /AND version = \$(\d+)/i)));
      if (!matches || !chart) return neonResult('UPDATE', [], []);
      const next = JSON.parse(String(paramAfter(s, /chart_data = \$(\d+)/)));
      // BEFORE UPDATE OF chart_data trigger: bump only when the data changed.
      if (JSON.stringify(next) !== JSON.stringify(chart.chart_data)) chart.version += 1;
      chart.chart_data = next;
      chart.chart_title = String(paramAfter(s, /chart_title = \$(\d+)/));
      return returningVersion(q, chart.version);
    }

    throw new Error(`Unexpected SQL in test: ${q}`);
  }
}
