/**
 * HTTP Service - concrete DI-level "HTTP is provided in this scope" binding.
 *
 * The abstract token `AbstractHttpAdapter` is what route factories (Get,
 * Post, etc.) stamp on their `__transportRequires`. A controller using
 * those factories therefore requires `AbstractHttpAdapter` to be in
 * TProvided at `.add()` time. Satisfy it by binding a concrete HTTP
 * service.
 *
 * `HttpService` is the default concrete implementation. It binds to
 * `AbstractHttpAdapter` via `provides:` and requires `Config.of(HttpConfig)`
 * - pushing the "you must configure port/host" obligation from the
 * controller level down to the service level. Controllers just need HTTP
 * to be present; they don't care how it's configured.
 *
 * Runtime note: the actual HTTP server is still started by the kernel via
 * the `HTTP_ADAPTER` raw `Adapter` object, installed through build-phase
 * ALS when a `Get()` (or sibling) runs inside a compile. `HttpService`'s
 * factory returns a minimal handle - its purpose is purely to satisfy
 * the DI abstract token.
 *
 * @see AbstractHttpAdapter
 * @see HTTP_ADAPTER
 */

import {
  Config,
  defineAbstract,
  defineService,
  registerImplicitService,
  registerOpenApiMethod,
} from '@justscale/core';
import { HttpConfig } from './config.js';

// Advertise every standard HTTP method to the OpenAPI registry.
// `@justscale/feature-openapi` uses this to decide which routes land
// in `paths` - CLI/WebSocket/Event methods register nothing and are
// naturally filtered out.
for (const method of [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'TRACE',
] as const) {
  registerOpenApiMethod(method, { httpMethod: method.toLowerCase() });
}

export interface HttpAdapter {
  readonly port: number
  readonly host: string
}

/**
 * Abstract DI token representing "this scope has HTTP routing available".
 *
 * Route factories (`Get`, `Post`, `Put`, `Patch`, `Delete`, `Head`,
 * `Options`) stamp this as their `__transportRequires`. Any controller
 * using them therefore requires `AbstractHttpAdapter` at `.add()` time -
 * provide it by adding `HttpService` (the default concrete) or a
 * custom implementation via `bindService(AbstractHttpAdapter, MyImpl)`.
 */
export abstract class AbstractHttpAdapter extends defineAbstract<HttpAdapter>(
  'AbstractHttpAdapter',
) {}

/**
 * Default HTTP service. Binds to `AbstractHttpAdapter` and pushes the
 * "needs HttpConfig" obligation to this level - so consumers of HTTP
 * routes (controllers) don't see HttpConfig in their require set;
 * they only see `AbstractHttpAdapter`.
 */
export class HttpService extends defineService({
  inject: { config: Config.of(HttpConfig) },
  provides: [AbstractHttpAdapter],
  factory: ({ config }) => ({
    port: config.port,
    host: config.host,
  }),
}) {}

/**
 * Register `HttpService` as the implicit provider of `AbstractHttpAdapter`
 * on every builder. Lazy-resolved: if no controller in the app injects
 * `AbstractHttpAdapter`, the service is never instantiated and its
 * `HttpConfig` requirement is never triggered - so adding
 * `@justscale/http` as a dependency but not using it costs nothing.
 */
registerImplicitService(AbstractHttpAdapter as any, HttpService as any);
