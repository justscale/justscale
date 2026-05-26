/**
 * Datastar Plugin Types
 *
 * Types for Datastar-specific route factories and context.
 */

import type { ExtractParams, Prettify } from '@justscale/core/plugin';
import type { MergeFragmentsOptions } from './encoder.js';

/** Datastar stream interface - abstraction over SSE */
export interface DatastarStream {
  mergeSignals(data: Record<string, unknown>): void
  /** `opts` lets you target a selector / merge mode (append, inner, …). */
  mergeFragments(html: string, opts?: MergeFragmentsOptions): void
  removeFragments(selector: string): void
  removeSignals(paths: string[] | string): void
  executeScript(script: string): void
}

/** Context for Datastar routes */
export interface DatastarContext<T = Record<string, unknown>> {
  signals: T
  stream: DatastarStream
  params: Record<string, string>
}

/** Context for watch handlers */
export interface WatchContext<
  TDeps = Record<string, unknown>,
  TParams = Record<string, string>,
> {
  deps: TDeps
  signals: Record<string, unknown>
  stream: DatastarStream
  params: Prettify<TParams>
  /** Signal that the client has disconnected */
  aborted: Promise<void>
}

/** Async generator that yields signal data */
export type WatchGenerator<TDeps, TParams> = (
  ctx: WatchContext<TDeps, TParams>,
) => AsyncGenerator<Record<string, unknown>, void, unknown>;

/** Watch factory type */
export type WatchFactory<TDeps> = <TPath extends string>(
  path: TPath,
  generator: WatchGenerator<TDeps, ExtractParams<TPath>>,
) => any;

declare module '@justscale/core/plugin' {
  interface RouteFactories<TDeps> {
    Watch: WatchFactory<TDeps>
  }
}
