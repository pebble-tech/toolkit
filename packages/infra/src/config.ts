import { stackKind } from './names.js';
import type { StageKind } from './stage.js';

/**
 * One stack config value a product's program reads, and the variable it comes from. A product's entries module lists
 * every one; `pebble-infra configure` writes them and the program's `readInputs` imports the same list.
 */
export interface Entry {
  /** Stack config key, in the product's namespace unless it names its own (`aws:region`). */
  key: string;
  /** Variable the value comes from: `PEBBLE_INFRA_VALUES` first when it is set, then the environment. */
  env: string;
  /** Stored as a Pulumi secret. */
  secret: boolean;
  /** A stack that reads it refuses to configure without it. */
  required: boolean;
  /** The stages that read it. */
  stacks: readonly StageKind[];
}

/** Variable name to value, as the environment holds them. */
export type ConfigValues = Readonly<Record<string, string | undefined>>;

/** What `pebble-infra configure --entries <module>` imports from the product's compiled module. */
export interface EntriesModule {
  entries: readonly Entry[];
  /**
   * Values computed from the given ones, by variable name, such as a role name parsed from a connection URL. An entry
   * reads them like any other variable; a derived value replaces a given one of the same name.
   */
  derive?: (values: ConfigValues, stack: string) => ConfigValues;
  /** Namespace for keys that name none; defaults to the product id. */
  namespace?: string;
  /**
   * `true` when the program creates a `Database` on `pr-<n>` stacks. `pebble-infra` then drops a database an earlier
   * run left (`<product>_pr_<n>`) before it creates the stack, checks before `up` that `PG_ADMIN_URL`'s admin could drop
   * it, and drops it on `remove`. Left out, the CLI never reaches Postgres and needs no `PG_ADMIN_URL`.
   */
  previewDatabase?: boolean;
}

export interface ConfigWrite {
  /** Namespaced key: `<namespace>:<key>`, or the entry's own namespace. */
  key: string;
  value: string;
  secret: boolean;
}

/**
 * The config writes for `stack`: every entry the stack reads that has a value, as `set`, and every one with none as
 * `remove`, so a value from an earlier run cannot linger. Throws naming every missing required variable at once.
 */
export function configWrites(
  module: EntriesModule,
  stack: string,
  given: ConfigValues,
  product: string
): { set: ConfigWrite[]; remove: string[] } {
  const kind = stackKind(stack);
  const values = { ...given, ...module.derive?.(given, stack) };
  const namespace = module.namespace ?? product;
  const qualified = (key: string) => (key.includes(':') ? key : `${namespace}:${key}`);
  const entries = module.entries.filter((entry) => entry.stacks.includes(kind));
  const value = (entry: Entry) => values[entry.env]?.trim() ?? '';
  const missing = entries.filter((entry) => entry.required && !value(entry)).map((entry) => entry.env);
  if (missing.length > 0) throw new Error(`stack ${stack} needs ${missing.join(', ')}`);

  const set: ConfigWrite[] = [];
  const remove: string[] = [];
  for (const entry of entries) {
    if (value(entry)) set.push({ key: qualified(entry.key), value: value(entry), secret: entry.secret });
    else remove.push(qualified(entry.key));
  }
  return { set, remove };
}
