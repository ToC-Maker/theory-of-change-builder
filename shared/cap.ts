// Cap-overspend tolerance. Anything that compares cumulative usage against
// the lifetime cap multiplies the cap by (1 + this fraction). Shared so
// client and worker stay in lockstep without bouncing the constant through
// the usage payload.
export const CAP_OVERSPEND_TOLERANCE_FRACTION = 0.05;
