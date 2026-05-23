/**
 * Global type augmentation for the Processable protocol.
 *
 * Adds `Symbol.process` and `Processable<T>` to the global scope,
 * following the same pattern as `Symbol.dispose` / `Disposable`.
 *
 * Any project that depends on @justscale/core gets these types
 * globally — no imports needed.
 */

declare global {
  interface SymbolConstructor {
    /**
     * Symbol used to define process serialization on a type.
     * Types with `[Symbol.process]` get automatic serialization
     * in durable processes, channels, signals, and cluster transport.
     */
    readonly process: unique symbol
  }

  /**
   * Describes how a type is serialized/deserialized for durable processes.
   */
  interface ProcessDescriptor<T = unknown> {
    /** Stable unique name — used as type registry key for deserialization lookup */
    readonly name: string
    /** Serialize a value to a storable form (binary or plain object) */
    serialize(value: T): Uint8Array | object
    /** Deserialize from stored form back to the original type */
    deserialize(data: Uint8Array | object): T
    /**
     * Optional shape validation for the raw payload before deserialize is called.
     * When present, decode rejects payloads that fail validation with a clear error.
     * Prevents type-confusion from a mismatched or forged __$p tag.
     *
     * Return true if the payload is valid for this descriptor.
     */
    validate?(payload: unknown): boolean
  }

  /**
   * A type that can be serialized in durable processes.
   *
   * Implement this on a class or schema to enable automatic serialization:
   *
   * ```typescript
   * class MoneyAmount implements Processable<MoneyAmount> {
   *   static [Symbol.process] = {
   *     name: 'myapp.MoneyAmount',
   *     serialize: (v) => ({ cents: v.cents, currency: v.currency }),
   *     deserialize: (d) => new MoneyAmount(d.cents, d.currency),
   *   }
   * }
   * ```
   *
   * The compiler detects Processable types via the `__processable` brand
   * property, which exists at the type level only (phantom brand).
   */
  interface Processable<T = unknown> {
    [Symbol.process]: ProcessDescriptor<T>
  }
}

export {};
