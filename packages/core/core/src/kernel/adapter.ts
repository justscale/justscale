import type { AnyToken } from '../builder/types.js';
import type { App } from '../app.js';

export interface Adapter {
  readonly name: string;
  readonly requires: readonly AnyToken[];
  start(app: App, ...resolved: unknown[]): Promise<void> | void;
  stop?(): Promise<void> | void;
}
