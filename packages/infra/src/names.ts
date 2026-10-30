// Stack and product naming with no Pulumi SDK import, so the `pebble-infra` CLI shares it with `Stage` without
// loading the engine.
import { StageError } from './errors.js';
import type { StageEnv, StageKind } from './stage.js';

/** One DNS label. A hyphen would let `*-<product>.*` match another product that ends in `-<product>`. */
export const LABEL = /^[a-z][a-z0-9]{1,}$/;
const PREVIEW = /^pr-([1-9][0-9]*)$/;

/** Throws StageError unless `product` is one DNS label outside the reserved `pebble` prefix. */
export function assertProduct(product: string): void {
  if (!LABEL.test(product)) {
    throw new StageError(
      `product id "${product}" must be one DNS label: lowercase letters and digits, no hyphen, at least two characters`
    );
  }
  // `staging` or `pr` as the whole id would let one product's names fall inside another's `<product>-<env>-*` scope.
  if (['pr', 'staging', 'prod', 'shared'].includes(product)) {
    throw new StageError(`product id "${product}" is an env word (pr, staging, prod, shared)`);
  }
  if (product.startsWith('pebble')) {
    throw new StageError(`product id "${product}" starts with "pebble", which is reserved for shared infrastructure`);
  }
}

export function parseEnv(stack: string): { env: StageEnv; kind: StageKind; pr?: number } {
  if (stack === 'staging' || stack === 'prod' || stack === 'shared') return { env: stack, kind: stack };
  const preview = PREVIEW.exec(stack);
  if (preview) return { env: stack as StageEnv, kind: 'preview', pr: Number(preview[1]) };
  throw new StageError(`stack "${stack}" is not one of pr-<n>, staging, prod or shared`);
}

/** Which stage a stack name deploys: `preview` for every `pr-<n>`. Throws StageError for any other name. */
export function stackKind(stack: string): StageKind {
  return parseEnv(stack).kind;
}

/**
 * Postgres database name for a product stack: `<product>_stg`, `<product>_prd` or `<product>_pr_<n>`, dashes as
 * underscores. `Stage.databaseName()` and the CLI's preview reset both read it.
 */
export function databaseName(product: string, stack: string): string {
  const { kind, pr } = parseEnv(stack);
  if (kind === 'shared') throw new StageError('the shared stack has no database');
  const suffix = kind === 'prod' ? 'prd' : kind === 'staging' ? 'stg' : `pr_${pr}`;
  return `${product.replaceAll('-', '_')}_${suffix}`;
}
