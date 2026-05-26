// Cap-overspend tolerance shared by both preflight gates and the mid-stream
// kill switch. Anything that compares cumulative usage against the displayed
// lifetime cap multiplies the cap by (1 + this fraction). Keeps client and
// worker in sync without bouncing the constant through the usage payload.
//
// User-visible UI always shows the un-buffered cap (LIFETIME_CAP_USD) — the
// tolerance is only ever in the user's favor.
export const CAP_OVERSPEND_TOLERANCE_FRACTION = 0.05;
