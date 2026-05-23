import { AsyncLocalStorage } from 'node:async_hooks';
import type { Adapter } from '../kernel/adapter.js';

export interface BuildContext {
  installAdapter(a: Adapter): void;
}

export const _buildContext = new AsyncLocalStorage<BuildContext>();

export const currentBuilder = (): BuildContext | undefined => _buildContext.getStore();
