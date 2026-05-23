import type { App } from '../app.js';
import type { Adapter } from './adapter.js';
import { Lifecycle } from '../core/lifecycle.js';
import type { LifecycleImpl } from '../core/lifecycle-impl.js';
import { AbstractLockProvider } from '../features/lock/lock-service.js';
import { AbstractChannelBackend } from '../features/channel/backend.js';
import type { ServiceToken } from '../core/service.js';
import { runContainerReadyHooks } from '../core/container-hooks.js';

export interface KernelOptions {
  app: App;
  signals?: boolean;
  logger?: Pick<Console, 'warn' | 'error' | 'log' | 'info'>;
}

export interface Kernel {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly running: boolean;
  readonly startedAdapters: readonly Adapter[];
}

export function createKernel(opts: KernelOptions): Kernel {
  const { app, signals = true, logger = console } = opts;
  let running = false;
  let stopping: Promise<void> | null = null;
  let signalCleanup: (() => void) | null = null;
  const startedAdapters: Adapter[] = [];

  async function stop(): Promise<void> {
    if (stopping) return stopping;
    if (!running && startedAdapters.length === 0) return;

    stopping = (async () => {
      signalCleanup?.();
      signalCleanup = null;

      // Order matters: close abstract services FIRST while their underlying
      // adapter (e.g. postgres pool) is still alive, then stop adapters last.
      // The previous order (adapters first) caused TableLockProvider.release()
      // to fire pg_notify against an already-closed pool, surfacing as
      // CONNECTION_CLOSED unhandled rejections during teardown.

      let lifecycle: LifecycleImpl | null = null;
      try {
        lifecycle = (await app.container.resolve(Lifecycle)) as LifecycleImpl;
      } catch {
        // Lifecycle not registered - skip stop hooks
      }
      if (lifecycle) {
        try {
          await lifecycle.runHook('stop');
        } catch (err) {
          logger.error?.("Kernel: lifecycle 'stop' hook failed:", err);
        }
      }

      let lockProvider: { close?: () => Promise<void> } | null = null;
      try {
        lockProvider = await app.container.resolve(AbstractLockProvider);
      } catch {
        // Lock provider not registered - nothing to close
      }
      if (lockProvider && typeof lockProvider.close === 'function') {
        try {
          await lockProvider.close();
        } catch (err) {
          logger.error?.('Kernel: lock provider close failed:', err);
        }
      }

      let channelBackend: { close?: () => Promise<void> } | null = null;
      try {
        channelBackend = await app.container.resolve(AbstractChannelBackend);
      } catch {
        // Channel backend not registered - nothing to close
      }
      if (channelBackend && typeof channelBackend.close === 'function') {
        try {
          await channelBackend.close();
        } catch (err) {
          logger.error?.('Kernel: channel backend close failed:', err);
        }
      }

      for (let i = startedAdapters.length - 1; i >= 0; i--) {
        const adapter = startedAdapters[i]!;
        if (!adapter.stop) continue;
        try {
          await adapter.stop();
        } catch (err) {
          logger.error?.(`Kernel: adapter '${adapter.name}' stop failed:`, err);
        }
      }
      startedAdapters.length = 0;

      running = false;
    })();

    return stopping;
  }

  async function start(): Promise<void> {
    if (running) throw new Error('Kernel already running');
    await app.ready;

    const byName = new Map<string, Adapter>();
    for (const a of app.adapters) {
      const prev = byName.get(a.name);
      if (prev && prev !== a) {
        logger.warn?.(`Kernel: two adapters registered under '${a.name}' with different refs; using first.`);
        continue;
      }
      if (!prev) byName.set(a.name, a);
    }

    for (const adapter of byName.values()) {
      const resolved = await Promise.all(
        adapter.requires.map((token) =>
          app.container.resolve(token as ServiceToken<unknown>),
        ),
      );
      await adapter.start(app, ...resolved);
      startedAdapters.push(adapter);
    }

    running = true;

    try {
      await runContainerReadyHooks(app.container);
    } catch (err) {
      logger.warn?.('Kernel: a container-ready hook threw:', err);
    }

    if (signals) {
      const handler = () => {
        void stop().finally(() => process.exit(0));
      };
      process.once('SIGINT', handler);
      process.once('SIGTERM', handler);
      signalCleanup = () => {
        process.off('SIGINT', handler);
        process.off('SIGTERM', handler);
      };
    }
  }

  return {
    start,
    stop,
    get running() {
      return running;
    },
    get startedAdapters() {
      return startedAdapters;
    },
  };
}
