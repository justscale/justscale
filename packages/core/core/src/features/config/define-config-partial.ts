import type { z } from 'zod';
import { CONFIG_PARTIAL, type ConfigPartial } from './types.js';

/**
 * Define a config partial with a Zod schema.
 *
 * The returned object carries a fresh `Symbol('config:<name>')` on `.key`.
 * Plain `Symbol()` (not `Symbol.for`) so two features that happen to pick
 * the same name get distinct tokens and do not silently share a container
 * slot. Consumers import the token object from the declaring module and
 * inject it directly; no string-keyed lookup is involved.
 */
export function defineConfigPartial<T extends z.ZodType>(
  name: string,
  schema: T
): ConfigPartial<z.infer<T>> {
  return {
    [CONFIG_PARTIAL]: true,
    key: Symbol(`config:${name}`),
    name,
    schema: schema as z.ZodType<z.infer<T>>,
  };
}
