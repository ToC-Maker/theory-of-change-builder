/**
 * Thin re-export shim for the µUSD cost math.
 *
 * The real implementation lives in `shared/cost.ts` so the React client and
 * the Cloudflare Worker compute prices identically (BigInt symmetry on the
 * wire). This file exists so existing worker imports
 * (`from '../_shared/cost'`) keep resolving without churn.
 */

export {
  computeCostMicroUsd,
  parseAnthropicUsage,
  RATES_MICRO_USD_PER_TOKEN,
  WEB_SEARCH_MICRO_USD_PER_USE,
} from '../../shared/cost';

export type { AnthropicUsage } from '../../shared/cost';
