import type { Adapter } from '@justscale/core';
import { Config, Lifecycle, Logger } from '@justscale/core';
import type { z } from 'zod';
import { HttpConfig } from './config.js';
import { AbstractHttpAdapter } from './service.js';
import { listen } from './server.js';

type HttpConfigValue = z.infer<typeof HttpConfig.schema>;
type LoggerLike = InstanceType<typeof Logger>;
type LifecycleLike = { runHook(name: 'httpServing'): Promise<void> };

/**
 * Transport requirements stamped on every HTTP route's brand.
 *
 * Controllers using HTTP route factories require `AbstractHttpAdapter`
 * - a pure DI token signalling "HTTP is available in this scope."
 * A concrete binding (`HttpService` is the default) satisfies it and
 * owns the actual `HttpConfig` requirement. This keeps HTTP-using
 * controllers free of protocol config concerns at the type level.
 *
 * Runtime adapter-start still resolves `Config.of(HttpConfig)`, `Logger`,
 * and `Lifecycle` - those are kernel-level concerns, not controller ones.
 */
export const HTTP_TRANSPORT_REQUIRES = [AbstractHttpAdapter] as const;

/**
 * HTTP adapter - installed into the build context by any `Get/Post/Put/...`
 * call. Deduplicated by reference in the kernel. The `start` call happens
 * exactly once per compiled app, after `await app.ready`.
 */
export const HTTP_ADAPTER: Adapter = Object.freeze({
  name: 'http',
  // Kernel-level requires - what the `start` call needs resolved.
  // Controller-level requires are the separate `HTTP_TRANSPORT_REQUIRES`
  // (now `AbstractHttpAdapter`) which says "something in this scope
  // provides HTTP", not "how it's configured".
  requires: [Config.of(HttpConfig), Logger, Lifecycle] as const,
  start(app: Parameters<Adapter['start']>[0], cfg: unknown, logger: unknown, lifecycle: unknown) {
    const { port, maxBodyBytes, allowedOrigins } = cfg as HttpConfigValue;
    const log = logger as LoggerLike;
    const lc = lifecycle as LifecycleLike;
    // Log on `listening` so the message only appears after the bind
    // actually succeeds. If the bind fails (EADDRINUSE etc.) the server
    // emits 'error' - log that too and let it propagate via the
    // kernel's existing error path.
    const server = listen(app, port, { maxBodyBytes, allowedOrigins });
    server.once('listening', () => {
      // Log the *bound* port (server.address() resolves the OS-chosen
      // port when configured port is 0). Tests / harnesses parse this
      // line to discover ephemeral ports.
      const addr = server.address();
      const boundPort = typeof addr === 'object' && addr ? addr.port : port;
      log.info(`[http] listening on http://localhost:${boundPort}`);
      // Fire the `httpServing` lifecycle hook. Services that registered
      // handlers (metrics, service discovery, dev auto-shell) run here.
      // We don't await - a slow/hung hook shouldn't block the kernel's
      // adapter-start sequence. Any rejection is logged; it doesn't
      // propagate up and take down the server.
      void lc.runHook('httpServing').catch((err: unknown) => {
        log.error(`[http] httpServing hook failed: ${String(err)}`);
      });
    });
    server.once('error', (err) => {
      log.error(`[http] listen on :${port} failed: ${String(err)}`);
    });
  },
});
