import type { z } from 'zod';
import { SECRET_PARTIAL, type SecretPartial } from './types.js';

/**
 * Define a secret partial with a Zod schema.
 *
 * Secret partials describe the shape of a secret slice (e.g. Postgres
 * connection string, JWT signing key). The value is provided at boot by a
 * SecretProvider that reads from a vault.
 *
 * @example
 * const PostgresSecrets = defineSecretPartial('postgres', z.object({
 *   connectionString: z.string(),
 * }))
 */
export function defineSecretPartial<T extends z.ZodType>(
  name: string,
  schema: T,
): SecretPartial<z.infer<T>> {
  return {
    [SECRET_PARTIAL]: true,
    // Plain Symbol(): each defineSecretPartial() call produces a fresh
    // token even when two features reuse the same human-readable name.
    // Consumers import the partial object from its declaring module and
    // inject it directly, so no global string-keyed lookup exists.
    key: Symbol(`secret:${name}`),
    name,
    schema: schema as z.ZodType<z.infer<T>>,
  };
}
