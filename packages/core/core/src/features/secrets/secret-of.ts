import type { Token } from '../../builder/index.js';
import type { SecretPartial } from './types.js';

declare const SECRET_TOKEN_BRAND: unique symbol;

/**
 * A secret token for DI. Services inject via Secret.of(partial).
 */
export interface SecretToken<T> extends Token<T> {
  readonly [SECRET_TOKEN_BRAND]?: T
  readonly description: string
  readonly key: symbol
  resolve(container: { get(key: symbol): T }): T
}

/**
 * Memoize per-partial to preserve token identity across call-sites -
 * required so DI validation matches the token a service injects against
 * the token a SecretProvider declares in `provides`.
 */
const secretTokenCache = new WeakMap<SecretPartial<any>, SecretToken<any>>();

export const Secret = {
  of<T>(partial: SecretPartial<T>): SecretToken<T> {
    const cached = secretTokenCache.get(partial);
    if (cached) return cached as SecretToken<T>;
    const token: SecretToken<T> = {
      description: `Secret.of(${partial.name})`,
      key: partial.key,
      resolve: (container: { get: (key: symbol) => T }) => container.get(partial.key),
    } as SecretToken<T>;
    secretTokenCache.set(partial, token);
    return token;
  },
};
