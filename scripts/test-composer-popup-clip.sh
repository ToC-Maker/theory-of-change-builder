#!/usr/bin/env bash
# Composer options popup clipping regression test (PR #34 feedback #60).
#
# Asserts that the composer ⚙ options popup (Web search + Effort level),
# and the Effort picker menu that opens inside it, render fully visible:
# inside the viewport AND inside every overflow-clipping ancestor (the
# chat panel's `overflow-hidden` content wrapper is the one that bit us —
# round-1 commit 4c3f484 anchored the popup `left-0` assuming it could
# "extend rightward into the canvas", but the popup lives inside an
# `overflow-hidden` box, so it was clipped at the panel's right edge).
#
# Runs the assertion at multiple panel widths. Headless Chrome via rodney
# can't resize the viewport, so the non-default widths are produced by
# pinning the panel root's width inline — geometrically equivalent for
# this bug (the clipping rect IS the panel's; assertions measure real
# ancestor rects rather than assuming bounds).
#
# Usage:
#   bash scripts/test-composer-popup-clip.sh [BASE_URL]
# Requires: dev server running (default http://localhost:8819), rodney.
set -uo pipefail

BASE_URL="${1:-http://localhost:8819}"
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

# Dismiss the privacy modal if it's up (fresh profile).
rodney js '(() => {
  const b = Array.from(document.querySelectorAll("button")).find(
    (x) => x.textContent.includes("I Understand"));
  if (b) { b.click(); return "dismissed"; }
  return "absent";
})()' >/dev/null

step "wait for composer (Turnstile gate)"
COG_OK=0
for _ in $(seq 1 30); do
  if [ "$(rodney count '[aria-label="Composer options"]' 2>/dev/null)" -ge 1 ]; then
    COG_OK=1
    break
  fi
  rodney sleep 1 >/dev/null
done
if [ "$COG_OK" -ne 1 ]; then
  fail "composer cog never appeared (Turnstile gate not cleared?)"
  exit 1
fi

# Measure the popup (and optionally another overlay element) against the
# viewport and every overflow-clipping ancestor. Returns a JSON verdict.
measure_within_clips() {
  local selector="$1"
  rodney js "(() => {
    const el = document.querySelector('$selector');
    if (!el) return JSON.stringify({ ok: false, reason: 'element not found: $selector' });
    const r = el.getBoundingClientRect();
    const EPS = 0.5;
    const violations = [];
    if (r.left < -EPS || r.right > window.innerWidth + EPS ||
        r.top < -EPS || r.bottom > window.innerHeight + EPS) {
      violations.push({ by: 'viewport', rect: { l: r.left, r: r.right, t: r.top, b: r.bottom },
                        bounds: { l: 0, r: window.innerWidth, t: 0, b: window.innerHeight } });
    }
    for (let a = el.parentElement; a; a = a.parentElement) {
      const cs = getComputedStyle(a);
      const clipsX = cs.overflowX !== 'visible';
      const clipsY = cs.overflowY !== 'visible';
      if (!clipsX && !clipsY) continue;
      const ar = a.getBoundingClientRect();
      const xBad = clipsX && (r.left < ar.left - EPS || r.right > ar.right + EPS);
      const yBad = clipsY && (r.top < ar.top - EPS || r.bottom > ar.bottom + EPS);
      if (xBad || yBad) {
        violations.push({ by: (a.className || a.tagName).toString().slice(0, 60),
                          rect: { l: r.left, r: r.right, t: r.top, b: r.bottom },
                          bounds: { l: ar.left, r: ar.right, t: ar.top, b: ar.bottom } });
      }
    }
    return JSON.stringify({ ok: violations.length === 0, width: r.width, violations });
  })()"
}

set_panel_width() {
  local width="$1"
  rodney js "(() => {
    const panel = document.querySelector('div.fixed.left-0.z-40');
    if (!panel) return 'panel not found';
    if ('$width' === 'default') {
      panel.style.width = ''; panel.style.minWidth = ''; panel.style.maxWidth = '';
    } else {
      panel.style.width = '$width'; panel.style.minWidth = '$width'; panel.style.maxWidth = '$width';
    }
    return 'set';
  })()" >/dev/null
}

close_popup() {
  # Click the canvas area (outside the panel) to dismiss any open popup.
  rodney js '(() => {
    document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 900, clientY: 400 }));
    document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 900, clientY: 400 }));
    return "closed";
  })()' >/dev/null
  rodney sleep 1 >/dev/null
}

run_width_case() {
  local label="$1" width="$2"
  step "panel width: $label"
  set_panel_width "$width"
  rodney sleep 1 >/dev/null

  close_popup
  rodney click '[aria-label="Composer options"]' >/dev/null
  rodney sleep 1 >/dev/null
  if [ "$(rodney count '[role="menu"]')" -lt 1 ]; then
    fail "$label: popup did not open"
    return
  fi

  local verdict
  verdict="$(measure_within_clips '[role="menu"]')"
  if echo "$verdict" | grep -q '"ok":true'; then
    pass "$label: options popup fully visible (viewport + clip ancestors)"
  else
    fail "$label: options popup clipped: $verdict"
  fi

  # The Effort picker opens its own menu INSIDE the popup — same bug class
  # (static left-0 anchor inside the overflow-hidden panel). Assert it too.
  rodney js '(() => {
    const t = document.querySelector("[role=menu] [title^=\"Effort\"]");
    if (!t) return "no effort trigger";
    t.click();
    return "opened";
  })()' >/dev/null
  rodney sleep 1 >/dev/null
  verdict="$(measure_within_clips '[role="menu"] .shadow-lg')"
  if echo "$verdict" | grep -q '"ok":true'; then
    pass "$label: effort menu fully visible (viewport + clip ancestors)"
  else
    fail "$label: effort menu clipped: $verdict"
  fi

  close_popup
}

# Width cases: the default responsive width (viewport/4 clamped to
# [280, 400]), the minimum (280px), and the maximum (400px).
run_width_case "default (responsive)" "default"
run_width_case "narrow (min 280px)" "280px"
run_width_case "wide (max 400px)" "400px"

set_panel_width "default"

if [ "$FAIL" -ne 0 ]; then
  echo "RESULT: FAIL"
  exit 1
fi
echo "RESULT: PASS"
