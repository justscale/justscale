/**
 * Stop Mechanism for Middleware Guards
 *
 * Provides a unique stop signal that guards can return to halt middleware execution.
 */

/**
 * Unique stop symbol - all consumers import this directly from core.
 */
export const STOP_SYMBOL: unique symbol = Symbol('@justscale/stop');
export type Stop = typeof STOP_SYMBOL;

/**
 * Type guard to check if a value is the stop signal.
 *
 * @param value - Value to check
 * @returns True if value is the stop signal
 */
export function isStop(value: unknown): value is Stop {
  return value === STOP_SYMBOL;
}

/**
 * Create stop function - only injected for guards.
 *
 * @returns Function that returns the stop signal when called
 */
export function createStopFn(): () => Stop {
  return () => STOP_SYMBOL;
}
