#!/usr/bin/env node
// CI security gate: fail on high/critical vulns ONLY when the fix is
// actually installable under our supply-chain cooldown.
//
// Why this exists: `npm audit --audit-level=high` reports a vuln as
// "fix available" the moment any patched version is published — but our
// `.npmrc` `min-release-age=7` (mirrored from .github/dependabot.yml)
// refuses to INSTALL anything younger than 7 days, as supply-chain
// defense against compromised fresh releases. The two disagree: audit
// demands a fix that `npm install` won't take yet, wedging CI red on a
// version we deliberately won't pull. npm has no audit-side cooldown
// flag (confirmed against the npm v11 docs: min-release-age and before
// govern installation/resolution only, never audit reporting).
//
// This gate reconciles them. A high/critical FAILS the job when its fix
// is installable now:
//   - the fix is a named version published >= COOLDOWN_DAYS ago, or
//   - the fix is in-range (`npm audit fix` with no version change), or
//   - there is no fix at all (a real, unaddressed high).
// A high whose ONLY fix is a release younger than the cooldown is
// reported but not failed; it re-arms automatically once that fix ages
// past the window. Severity scope otherwise matches the previous
// `npm audit --audit-level=high` gate (full tree, dev + prod).

import { execFileSync } from 'node:child_process';

const COOLDOWN_DAYS = 7; // keep in sync with .npmrc `min-release-age`
const GATE_SEVERITIES = new Set(['high', 'critical']);
const MS_PER_DAY = 86_400_000;

function npm(args) {
  return execFileSync('npm', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// `npm audit` exits non-zero whenever vulns exist; that is expected, so
// capture stdout from the thrown error too.
let auditRaw;
try {
  auditRaw = npm(['audit', '--json']);
} catch (err) {
  auditRaw = err.stdout ? err.stdout.toString() : '';
}
if (!auditRaw) {
  console.error('audit-cooldown: `npm audit --json` produced no output');
  process.exit(2);
}

const vulnerabilities = JSON.parse(auditRaw).vulnerabilities ?? {};

const timeCache = new Map();
function publishedAt(name, version) {
  if (!timeCache.has(name)) {
    try {
      timeCache.set(name, JSON.parse(npm(['view', name, 'time', '--json'])));
    } catch {
      timeCache.set(name, {});
    }
  }
  const stamp = timeCache.get(name)[version];
  return stamp ? new Date(stamp) : null;
}

const blocking = [];
const deferred = [];

for (const [name, vuln] of Object.entries(vulnerabilities)) {
  if (!GATE_SEVERITIES.has(vuln.severity)) continue;
  const fix = vuln.fixAvailable;

  if (fix === false) {
    blocking.push(`${name} [${vuln.severity}] — no fix available`);
  } else if (fix === true) {
    blocking.push(`${name} [${vuln.severity}] — in-range fix (run \`npm audit fix\`)`);
  } else if (fix && typeof fix === 'object') {
    const date = publishedAt(fix.name, fix.version);
    if (!date) {
      blocking.push(
        `${name} [${vuln.severity}] — fix ${fix.name}@${fix.version} (publish date unknown; treating as actionable)`,
      );
      continue;
    }
    const ageDays = (Date.now() - date.getTime()) / MS_PER_DAY;
    if (ageDays >= COOLDOWN_DAYS) {
      blocking.push(
        `${name} [${vuln.severity}] — fix ${fix.name}@${fix.version} published ${ageDays.toFixed(1)}d ago (installable now)`,
      );
    } else {
      deferred.push(
        `${name} [${vuln.severity}] — only fix ${fix.name}@${fix.version} is ${ageDays.toFixed(1)}d old (< ${COOLDOWN_DAYS}d cooldown)`,
      );
    }
  }
}

if (deferred.length) {
  console.log(
    `Deferred — fix blocked by the ${COOLDOWN_DAYS}-day cooldown, re-arms once it ages out:`,
  );
  for (const line of deferred) console.log(`  · ${line}`);
}

if (blocking.length) {
  console.error(`\n✖ ${blocking.length} high/critical vuln(s) with an installable fix:`);
  for (const line of blocking) console.error(`  ✗ ${line}`);
  console.error('\nResolve with `npm audit fix`, or take the named fix version.');
  process.exit(1);
}

console.log(
  `✓ No high/critical vulns with an installable fix` +
    (deferred.length ? ` (${deferred.length} deferred by cooldown).` : '.'),
);
