/**
 * Datastar SSE Wire-Format Encoders
 *
 * Pure functions that produce the raw SSE frame bytes for each datastar
 * event type. Each encoder returns a string that ends with a single blank
 * line — the SSE frame terminator. Multi-line payloads (e.g. fragments)
 * are split across multiple `data:` lines as required by the SSE spec.
 *
 * Reference: https://data-star.dev
 */

/** Merge modes accepted by datastar for mergeFragments. */
export type MergeMode =
  | 'append'
  | 'prepend'
  | 'before'
  | 'after'
  | 'replace'
  | 'inner'
  | 'outer';

export interface MergeFragmentsOptions {
  /** CSS selector that anchors the fragment on the client. */
  selector?: string
  /** How to merge the fragment relative to the selector. */
  mergeMode?: MergeMode
}

export interface ExecuteScriptOptions {
  /** If true, the client removes the <script> after execution. */
  autoRemove?: boolean
  /** Extra attributes to place on the <script> tag (space-separated `k="v"`). */
  attributes?: Record<string, string>
}

/** Split a payload across repeated SSE data lines, preserving \n boundaries. */
function dataLines(prefix: string, payload: string): string {
  // SSE spec: a newline inside `data:` starts a new data line. Preserve
  // intentional multi-line payloads by splitting and prefixing each line.
  const lines = payload.split('\n');
  let out = '';
  for (const line of lines) out += `data: ${prefix}${line}\n`;
  return out;
}

/**
 * Strip CR/LF from a value that must occupy a single SSE `data:` line
 * (selector, mergeMode, signal paths, script attributes). Without this a
 * newline in the value would terminate the line and let the caller inject
 * arbitrary SSE fields — including a whole `datastar-execute-script` event,
 * i.e. client-side code execution. Multi-line payloads (fragments, scripts)
 * go through `dataLines` instead and are safe.
 */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ');
}

/** `datastar-merge-signals` — merges a JSON object into the client signal store. */
export function encodeMergeSignals(signals: Record<string, unknown>): string {
  const json = JSON.stringify(signals);
  return `event: datastar-merge-signals\n${dataLines('signals ', json)}\n`;
}

/** `datastar-merge-fragments` — injects an HTML fragment. */
export function encodeMergeFragments(
  html: string,
  opts: MergeFragmentsOptions = {},
): string {
  let out = 'event: datastar-merge-fragments\n';
  if (opts.selector) out += `data: selector ${oneLine(opts.selector)}\n`;
  if (opts.mergeMode) out += `data: mergeMode ${oneLine(opts.mergeMode)}\n`;
  out += dataLines('fragments ', html);
  out += '\n';
  return out;
}

/** `datastar-remove-fragments` — removes matching elements by selector. */
export function encodeRemoveFragments(selector: string): string {
  return `event: datastar-remove-fragments\ndata: selector ${oneLine(selector)}\n\n`;
}

/** `datastar-remove-signals` — removes one or more signal paths. */
export function encodeRemoveSignals(paths: string[] | string): string {
  const joined = Array.isArray(paths) ? paths.join(' ') : paths;
  return `event: datastar-remove-signals\ndata: paths ${oneLine(joined)}\n\n`;
}

/** `datastar-execute-script` — evaluates JavaScript on the client. */
export function encodeExecuteScript(
  script: string,
  opts: ExecuteScriptOptions = {},
): string {
  let out = 'event: datastar-execute-script\n';
  if (opts.autoRemove) out += 'data: autoRemove true\n';
  if (opts.attributes) {
    const entries = Object.entries(opts.attributes);
    if (entries.length > 0) {
      const attrs = entries
        .map(([k, v]) => `${oneLine(k)}="${oneLine(v)}"`)
        .join(' ');
      out += `data: attributes ${oneLine(attrs)}\n`;
    }
  }
  out += dataLines('script ', script);
  out += '\n';
  return out;
}

/** SSE heartbeat comment — keeps intermediaries from closing an idle stream. */
export function encodeHeartbeat(): string {
  return ': heartbeat\n\n';
}
