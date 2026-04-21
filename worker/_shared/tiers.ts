// Cost-control tier constants.
//
// NOTE: this file is a minimal stub provided by the U4 (api-files) unit to keep
// imports resolvable while U2 (helpers) lands in parallel. U2 owns the real
// definition; when the integration merge happens, U2's version (which likely
// includes additional tier helpers such as per-user cap logic and BYOK tier
// policy) replaces this one. The exported constants below match the contract
// documented in the cost-controls plan.

/** Per-file upload limit, in bytes. 500 MB — Anthropic's own Files API ceiling. */
export const FILE_UPLOAD_LIMIT_BYTES = 524_288_000;

/** Per-PDF page ceiling. Enforced client-side in src/utils/fileParser.ts. */
export const PDF_PAGE_LIMIT = 100;

/** Max number of PDFs that can be attached to a single chat conversation. */
export const PDFS_PER_CHAT_LIMIT = 5;

/** Max cumulative file bytes across all files in a single chat conversation. */
export const TOTAL_CHAT_FILE_BYTES_LIMIT = 52_428_800;
