import type { z } from 'zod';
import type { Token } from '../../builder/index.js';

/**
 * Symbol for identifying config partials
 */
export const CONFIG_PARTIAL = Symbol('config:partial');

/**
 * A config partial token - defines shape and validation
 */
export interface ConfigPartial<T> {
  readonly [CONFIG_PARTIAL]: true
  readonly key: symbol
  readonly name: string
  readonly schema: z.ZodType<T>
}

/**
 * Check if something is a ConfigPartial
 */
export function isConfigPartial(value: unknown): value is ConfigPartial<unknown> {
  return typeof value === 'object' && value !== null && CONFIG_PARTIAL in value;
}

/**
 * Component returned by createConfig()
 * Builder processes this at init time.
 *
 * @typeParam P - Tuple of provided ConfigPartials. Preserved at the type
 *                level so `ProvidesOf<ConfigComponent<P>>` can expose the
 *                corresponding ConfigTokens to DI validation.
 */
export interface ConfigComponent<P extends readonly ConfigPartial<any>[] = readonly ConfigPartial<any>[]> {
  readonly __configComponent: true
  readonly provides: P
  readonly inject: Record<string, Token<any>>
  readonly factory: (deps: Record<string, any>) => Record<symbol, any> | Promise<Record<symbol, any>>
}

/**
 * Check if something is a ConfigComponent
 */
export function isConfigComponent(value: unknown): value is ConfigComponent {
  return typeof value === 'object' && value !== null && '__configComponent' in value;
}
