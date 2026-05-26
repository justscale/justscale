/**
 * Datastar Stream Wrapper
 *
 * Wraps a writable target (node's ServerResponse, or anything that exposes
 * `write(chunk: string): void` and `end(): void`) into a DatastarStream.
 * Each method routes its payload through the pure encoder layer and writes
 * the resulting SSE frame to the underlying sink.
 */

import type { ServerResponse } from 'node:http';
import {
  type ExecuteScriptOptions,
  type MergeFragmentsOptions,
  encodeExecuteScript,
  encodeHeartbeat,
  encodeMergeFragments,
  encodeMergeSignals,
  encodeRemoveFragments,
  encodeRemoveSignals,
} from './encoder.js';
import type { DatastarStream } from './types.js';

/** Minimal writable sink — the subset of ServerResponse that the stream needs. */
export interface DatastarWritable {
  write(chunk: string): unknown
  end?(): unknown
  /** Optional — set by the stream wrapper when the sink is a ServerResponse. */
  writeHead?(statusCode: number, headers?: Record<string, string>): unknown
  headersSent?: boolean
  destroyed?: boolean
}

/** Richer stream returned by createDatastarStream — adds lifecycle + extras. */
export interface ConcreteDatastarStream extends DatastarStream {
  /** Overload: send fragments with selector/mergeMode options. */
  mergeFragments(html: string, opts?: MergeFragmentsOptions): void
  /** Overload: send a script with autoRemove/attributes options. */
  executeScript(script: string, opts?: ExecuteScriptOptions): void
  /** Write an SSE heartbeat comment (`: heartbeat`). */
  heartbeat(): void
  /** Close the underlying sink, if it exposes `end()`. */
  close(): void
}

/** The default SSE headers datastar clients and upstream proxies expect. */
export const DATASTAR_SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
  // Disable buffering for nginx and similar reverse proxies.
  'X-Accel-Buffering': 'no',
};

function isServerResponse(w: DatastarWritable): w is ServerResponse {
  return typeof (w as ServerResponse).writeHead === 'function'
    && 'statusCode' in (w as object);
}

/**
 * Wrap a writable sink as a DatastarStream.
 *
 * If the sink is a node `ServerResponse` and headers have not yet been sent,
 * the SSE headers are written automatically (status 200). For abstract
 * writables (tests, custom transports) the caller is responsible for headers.
 */
export function createDatastarStream(
  writable: DatastarWritable,
): ConcreteDatastarStream {
  if (isServerResponse(writable) && !writable.headersSent) {
    writable.writeHead(200, DATASTAR_SSE_HEADERS);
  }

  // Track our own end so post-close writes become no-ops instead of throwing
  // `ERR_STREAM_WRITE_AFTER_END`. We also honour the sink's own ended state
  // (e.g. the response was ended elsewhere) when it exposes `writableEnded`.
  let ended = false;
  const isEnded = (): boolean =>
    ended ||
    !!writable.destroyed ||
    (writable as { writableEnded?: boolean }).writableEnded === true;

  const write = (frame: string): void => {
    if (isEnded()) return;
    writable.write(frame);
  };

  return {
    mergeSignals(data: Record<string, unknown>): void {
      write(encodeMergeSignals(data));
    },
    mergeFragments(html: string, opts?: MergeFragmentsOptions): void {
      write(encodeMergeFragments(html, opts));
    },
    removeFragments(selector: string): void {
      write(encodeRemoveFragments(selector));
    },
    removeSignals(paths: string[] | string): void {
      write(encodeRemoveSignals(paths));
    },
    executeScript(script: string, opts?: ExecuteScriptOptions): void {
      write(encodeExecuteScript(script, opts));
    },
    heartbeat(): void {
      write(encodeHeartbeat());
    },
    close(): void {
      if (isEnded()) return;
      ended = true;
      if (typeof writable.end === 'function') writable.end();
    },
  };
}
