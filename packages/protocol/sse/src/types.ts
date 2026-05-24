/**
 * SSE Types
 */

// Register SSE as a supported method for controllers
declare module '@justscale/core' {
  interface SupportedMethods {
    SSE: { streaming: true }
  }
}

/** An SSE event to send to the client */
export interface SSEEvent {
  /** Event ID — sent as `id:` field. Optional. */
  id?: string
  /** Event type — sent as `event:` field. If omitted, client receives as 'message'. */
  event?: string
  /** Event data — JSON-serialized and sent as `data:` field. */
  data: unknown
  /** Retry interval hint in ms — sent as `retry:` field. Optional. */
  retry?: number
}

/** Context passed to SSE handler */
export interface SSEContext<TDeps = Record<string, unknown>, TParams = Record<string, string>> {
  /** Route parameters */
  params: TParams
  /** Injected dependencies from the controller */
  deps: TDeps
  /** Raw query parameters from the URL */
  rawQuery: Record<string, string>
  /** Last-Event-ID from the client's reconnection header (if any) */
  lastEventId?: string
  /** Signal that fires when the client disconnects */
  aborted: Promise<void>
}

/** Async generator that yields SSE events */
export type SSEGenerator<TDeps = any, TParams = any> = (
  ctx: SSEContext<TDeps, TParams>,
) => AsyncGenerator<SSEEvent, void, undefined>;
