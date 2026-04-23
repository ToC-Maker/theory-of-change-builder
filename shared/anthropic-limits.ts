// Anthropic API-imposed limits that are NOT per-model. Consolidated so a
// limit change touches one place rather than a dozen magic numbers scattered
// across worker and frontend code.
//
// Sources (all verified against the Claude docs at time of writing):
//   https://platform.claude.com/docs/en/api/getting-started        (request sizes)
//   https://platform.claude.com/docs/en/build-with-claude/files    (file upload ceiling)
//   https://platform.claude.com/docs/en/build-with-claude/token-counting (count_tokens RPM)
//   https://platform.claude.com/docs/en/api/rate-limits           (tier ladder)

/** Messages API request body ceiling per Anthropic. 413 above this. */
export const ANTHROPIC_MESSAGES_REQUEST_BODY_BYTES = 32 * 1024 * 1024; // 32 MB

/** Files API per-upload ceiling per Anthropic. 413 above this. */
export const ANTHROPIC_FILE_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MB

/**
 * Per-document PDF page cap. Enforced by both /v1/messages and
 * count_tokens — a PDF with more pages will 400 with
 * "A maximum of 600 PDF pages may be provided." The Files API upload
 * itself does NOT enforce this, so a too-large PDF can sit on Anthropic
 * as an unusable orphan unless we reject it ourselves.
 *
 * Source: https://platform.claude.com/docs/en/build-with-claude/pdf-support
 */
export const ANTHROPIC_PDF_PAGE_LIMIT = 600;

/**
 * count_tokens dedicated rate limits (requests per minute), indexed by
 * Anthropic usage tier. Separate from Messages API limits: using one does
 * not count toward the other's budget.
 *
 * Source: https://platform.claude.com/docs/en/build-with-claude/token-counting#pricing-and-rate-limits
 */
export const COUNT_TOKENS_RPM_BY_TIER: Record<1 | 2 | 3 | 4, number> = {
  1: 100,
  2: 2_000,
  3: 4_000,
  4: 8_000,
};

/** Our current tier — update when we move up. Drives client-side debounce budgeting. */
export const CURRENT_ANTHROPIC_TIER = 1 as const;
