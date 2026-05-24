/**
 * SSE Wire Format
 *
 * Formats events according to the Server-Sent Events specification.
 * https://html.spec.whatwg.org/multipage/server-sent-events.html
 */

import type { SSEEvent } from './types.js';

/** Format an SSE event for wire transmission */
export function formatSSEEvent(event: SSEEvent): string {
  let output = '';
  if (event.id != null) output += `id: ${event.id}\n`;
  if (event.event) output += `event: ${event.event}\n`;
  if (event.retry != null) output += `retry: ${event.retry}\n`;
  const data = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
  // Split multi-line data into separate `data:` lines per spec
  for (const line of data.split('\n')) {
    output += `data: ${line}\n`;
  }
  output += '\n';
  return output;
}

/** Format a heartbeat comment (keeps connection alive through proxies) */
export function formatHeartbeat(): string {
  return ': heartbeat\n\n';
}
