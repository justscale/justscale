import type { Token } from '../../builder/index.js';
import type { ConfigPartial } from './types.js';

/**
 * Brand for config tokens
 */
declare const CONFIG_TOKEN_BRAND: unique symbol;

/**
 * A config token that can be used with the DI system
 */
export interface ConfigToken<T> extends Token<T> {
  readonly [CONFIG_TOKEN_BRAND]?: T
  readonly description: string
  readonly key: symbol
  resolve(container: { get(key: symbol): T }): T
}

/**
 * Create a DI token for a config partial.
 *
 * The token can be used with container.get() to retrieve the config value.
 * The actual resolution happens in the ConfigService.
 */
export function createToken<T>(
  description: string,
  options: {
    resolve: (container: { get: (key: symbol) => T }) => T
  }
): ConfigToken<T> {
  return {
    description,
    key: Symbol.for(description),
    ...options
  } as ConfigToken<T>;
}

/**
 * Memoize Config.of(partial) so that multiple call-sites receive the same
 * token instance. Required for DI validation, which compares by token
 * identity - different injections of the "same" partial must resolve to one
 * token object.
 */
const configTokenCache = new WeakMap<ConfigPartial<any>, ConfigToken<any>>();

/**
 * Create an injection token for a config partial.
 */
export const Config = {
  of<T>(partial: ConfigPartial<T>): ConfigToken<T> {
    const cached = configTokenCache.get(partial);
    if (cached) return cached as ConfigToken<T>;
    const token = createToken<T>(`Config.of(${partial.name})`, {
      resolve: (container) => container.get(partial.key)
    });
    configTokenCache.set(partial, token);
    return token;
  }
};
