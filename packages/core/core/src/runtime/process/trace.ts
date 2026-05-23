/**
 * Process Runtime Trace Logging
 *
 * Lightweight tracing for the process runtime.
 * Enable with JUSTSCALE_TRACE=1 environment variable.
 */

const TRACE_ENABLED = process.env.JUSTSCALE_TRACE === '1' || process.env.JUSTSCALE_TRACE === 'true';

/**
 * Trace log a message (only when JUSTSCALE_TRACE is enabled).
 */
export function trace(component: string, message: string, data?: Record<string, unknown>): void {
  if (!TRACE_ENABLED) return;

  const timestamp = new Date().toISOString();
  const dataStr = data ? ' ' + JSON.stringify(data) : '';
  console.debug(`[${timestamp}] [TRACE] [${component}] ${message}${dataStr}`);
}

/**
 * Create a tracer for a specific component.
 */
export function createTracer(component: string) {
  return {
    trace: (message: string, data?: Record<string, unknown>) => trace(component, message, data),
  };
}
