/**
 * Extends Zod with z.ref() for type-safe Ref<T> validation.
 *
 * Usage:
 * ```typescript
 * import { z } from '@justscale/core/models'
 *
 * const EventSchema = z.object({
 *   user: z.ref(User),
 * })
 * ```
 */
import { z as _z } from 'zod';
import { isReference } from './reference/reference.js';
import { isPersistent, isLocked, type Ref } from './types.js';

function ref<T>(_model: { new (...args: any[]): T; ref(id: string): unknown }): _z.ZodType<Ref<T>> {
  return _z.union([
    // String ID from JSON body → coerce to Reference<T>
    _z.string().transform((id) => _model.ref(id) as Ref<T>),
    // Already a Reference / Persistent / Lock - pass through
    _z.custom<Ref<T>>(
      (val) => isReference(val) || isPersistent(val) || isLocked(val),
      { message: 'Expected a string id, Reference, Persistent entity, or locked entity' },
    ),
  ]) as unknown as _z.ZodType<Ref<T>>;
}

/**
 * Extended Zod with z.ref() for JustScale Ref<T> validation.
 * Drop-in replacement for `import { z } from 'zod'`.
 */
export const z: typeof _z & { ref: typeof ref } = { ..._z, ref } as any;

/** Standalone export for direct usage */
export { ref as zRef };

/**
 * Module augmentation - makes z.ref() visible in TypeScript
 * even when importing from 'zod' directly. At runtime, only
 * the z exported from '@justscale/core/models' has .ref().
 */
declare module 'zod' {
  namespace z {
    /**
     * Create a Zod schema that validates a Ref<T>.
     * Accepts Reference<T>, Persistent<T>, or Lock<Persistent<T>>.
     *
     * Note: import z from '@justscale/core/models' for runtime support.
     */
    export function ref<T>(_model: { new (...args: any[]): T }): _z.ZodType<Ref<T>>;
  }
}
