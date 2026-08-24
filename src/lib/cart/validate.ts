import "server-only";

/**
 * Production entry point — the actual logic lives in validate-core.ts
 * (no `server-only` import there) so it stays directly unit-testable.
 * Every production caller (src/lib/cart/actions.ts) imports from here,
 * unchanged.
 */
export {
  validateAndPriceSelection,
  type PricedSelection,
  type ValidationResult,
} from "./validate-core";
