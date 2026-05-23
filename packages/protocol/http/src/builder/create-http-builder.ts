import { createBaseBuilder, createBuilderState, currentBuilder } from '@justscale/core';
import type { z } from 'zod';
import { body } from './plugins/body.js';
import { query } from './plugins/query.js';
import type {
  HttpBaseContext,
  HttpMethod,
  HttpRouteBuilder,
  HttpRouteDef,
} from './types.js';
import { HTTP_ADAPTER, HTTP_TRANSPORT_REQUIRES } from '../adapter.js';

export function createHttpRouteBuilder<TPath extends string>(
  method: HttpMethod,
  path: TPath,
): HttpRouteBuilder<HttpBaseContext<TPath>, never, {}, TPath> {
  // Install the HTTP adapter into the current build context, if any.
  // currentBuilder() returns undefined when Get()/Post()/etc. runs outside
  // an app compile (e.g. direct unit tests of a route builder). In that
  // case we silently skip - no adapter registration is needed because no
  // app will consume it.
  currentBuilder()?.installAdapter(HTTP_ADAPTER);

  const state = createBuilderState();
  const base = createBaseBuilder(state, path);

  const builder: HttpRouteBuilder<any, any, any, any> = {
    use(middleware) {
      base.use(middleware);
      return builder;
    },

    guard(check) {
      base.guard(check);
      return builder;
    },

    apply(plugin) {
      return plugin(builder as any) as any;
    },

    returns(status: number, schema?: z.ZodType, permission?: any) {
      base.returns(status, schema as any, permission);
      return builder;
    },

    types(types: any): any {
      base.types(types);
      return builder;
    },

    body(schema: any): any {
      return this.apply(body(schema) as any);
    },

    query(schema: any): any {
      return this.apply(query(schema) as any);
    },

    handle(handler) {
      const routeDef = base.handle(handler as any);
      return {
        ...routeDef,
        method,
        __transportRequires: HTTP_TRANSPORT_REQUIRES,
      } as HttpRouteDef<TPath, any, any>;
    },
  };

  return builder as any;
}

export const Get = <TPath extends string>(path: TPath) =>
  createHttpRouteBuilder('GET', path);

export const Post = <TPath extends string>(path: TPath) =>
  createHttpRouteBuilder('POST', path);

export const Put = <TPath extends string>(path: TPath) =>
  createHttpRouteBuilder('PUT', path);

export const Patch = <TPath extends string>(path: TPath) =>
  createHttpRouteBuilder('PATCH', path);

export const Delete = <TPath extends string>(path: TPath) =>
  createHttpRouteBuilder('DELETE', path);

export const Head = <TPath extends string>(path: TPath) =>
  createHttpRouteBuilder('HEAD', path);

export const Options = <TPath extends string>(path: TPath) =>
  createHttpRouteBuilder('OPTIONS', path);
