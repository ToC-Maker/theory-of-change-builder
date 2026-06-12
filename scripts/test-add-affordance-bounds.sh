#!/usr/bin/env bash
# Add-affordance canvas-bounds regression test (PR #34 feedback #64).
#
# Asserts the always-on add affordances (column gutters, section-padding
# gutters) and the column bodies (double-click-to-add zones) stay inside
# the white canvas card ([data-export-root]) — the chart's visual bounds.
# Before the fix the gutters used a hardcoded `svgSize.height - 124`
# budget that overshot the card bottom (~17px column / ~6px section with
# a chart title; column BODIES overshot ~79px with the title cleared,
# because the edit-mode title placeholder renders even when `data.title`
# is empty while the height budget counted it as 0).
#
# Also asserts coverage: gutters must END at the column-body bottom (the
# canvas content edge), so a "fix" that merely shrinks them would fail.
#
# States covered: default chart (title present) at fit zoom, zoomed in,
# and with the chart title cleared (edit-mode placeholder case).
#
# Usage:
#   bash scripts/test-add-affordance-bounds.sh [BASE_URL]
# Requires: dev server running (default http://localhost:8825), rodney.
set -uo pipefail

BASE_URL="${1:-http://localhost:8825}"
FAIL=0

step() { echo "--- $*"; }
pass() { echo "[PASS] $*"; }
fail() {
  echo "[FAIL] $*"
  FAIL=1
}

rodney status >/dev/null 2>&1 || rodney start --local

step "open $BASE_URL"
rodney open "$BASE_URL" >/dev/null
rodney waitload >/dev/null
rodney sleep 2 >/dev/null

# Dismiss the privacy modal if it's up (fresh profile).
rodney js '(() => {
  const b = Array.from(document.querySelectorAll("button")).find(
    (x) => x.textContent.includes("I Understand"));
  if (b) { b.click(); return "dismissed"; }
  return "absent";
})()' >/dev/null
rodney sleep 1 >/dev/null

# Measure every add affordance + column body against the canvas card.
# All distances are reported UNSCALED (divided by the current zoom
# transform) so thresholds mean the same thing at any zoom level.
measure_bounds() {
  rodney js "(() => {
    const card = document.querySelector('[data-export-root]');
    if (!card) return JSON.stringify({ ok: false, reason: 'no export root' });
    const cb = card.getBoundingClientRect();
    const scale = cb.width / card.offsetWidth;
    const EPS = 2; // unscaled px of forgiveness for subpixel rounding
    const COVER = 6; // gutters must reach within this of the body bottom
    const violations = [];
    const gutters = [...document.querySelectorAll(
      '[data-testid^=add-section], [data-testid^=add-column]')];
    const bodies = [...document.querySelectorAll('[data-column]')];
    if (gutters.length === 0) return JSON.stringify({ ok: false, reason: 'no gutters (not in edit mode?)' });
    const bodyBottom = Math.max(...bodies.map((b) => b.getBoundingClientRect().bottom));
    const u = (d) => Math.round((d / scale) * 10) / 10;
    for (const el of gutters) {
      const r = el.getBoundingClientRect();
      const id = el.dataset.testid;
      if (r.bottom > cb.bottom + EPS * scale)
        violations.push(id + ' spills bottom by ' + u(r.bottom - cb.bottom) + 'px');
      if (r.right > cb.right + EPS * scale)
        violations.push(id + ' spills right by ' + u(r.right - cb.right) + 'px');
      if (r.top < cb.top - EPS * scale)
        violations.push(id + ' spills top by ' + u(cb.top - r.top) + 'px');
      if (r.left < cb.left - EPS * scale)
        violations.push(id + ' spills left by ' + u(cb.left - r.left) + 'px');
      if (r.bottom < bodyBottom - COVER * scale)
        violations.push(id + ' stops ' + u(bodyBottom - r.bottom) + 'px short of the content bottom');
    }
    for (const el of bodies) {
      const r = el.getBoundingClientRect();
      if (r.bottom > cb.bottom + EPS * scale)
        violations.push('column body ' + el.dataset.column + ' spills bottom by ' + u(r.bottom - cb.bottom) + 'px');
      if (r.right > cb.right + EPS * scale)
        violations.push('column body ' + el.dataset.column + ' spills right by ' + u(r.right - cb.right) + 'px');
    }
    return JSON.stringify({ ok: violations.length === 0, gutters: gutters.length, violations });
  })()"
}

assert_bounds() {
  local label="$1"
  local verdict
  verdict="$(measure_bounds)"
  if echo "$verdict" | grep -q '"ok":true'; then
    pass "$label: all add affordances inside the canvas card and reaching the content bottom"
  else
    fail "$label: $verdict"
  fi
}

step "state: default chart (title present), fit zoom"
assert_bounds "default/fit"

step "state: zoomed in (3 clicks)"
rodney click '[title="Zoom in"]' >/dev/null
rodney click '[title="Zoom in"]' >/dev/null
rodney click '[title="Zoom in"]' >/dev/null
rodney sleep 1 >/dev/null
assert_bounds "zoomed-in"
rodney click '[title="Fit to page (Ctrl+0)"]' >/dev/null
rodney sleep 1 >/dev/null

step "state: chart title cleared (edit-mode placeholder)"
rodney click 'h1' >/dev/null
rodney sleep 1 >/dev/null
CLEARED="$(rodney js '(() => {
  const i = document.querySelector("input.tracking-wider");
  if (!i) return "no title input";
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(i, "");
  i.dispatchEvent(new Event("input", { bubbles: true }));
  i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  return "cleared";
})()')"
if [ "$CLEARED" != "cleared" ]; then
  fail "could not clear the chart title ($CLEARED)"
else
  rodney sleep 1 >/dev/null
  assert_bounds "no-title placeholder"
fi

if [ "$FAIL" -ne 0 ]; then
  echo "RESULT: FAIL"
  exit 1
fi
echo "RESULT: PASS"
