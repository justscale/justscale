import assert from 'node:assert';

/**
 * Assert exact dirty paths (order-independent comparison)
 */
export function assertExactPaths(actual: string[], expected: string[], message?: string) {
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  assert.deepStrictEqual(
    sortedActual,
    sortedExpected,
    message ??
      `Expected paths ${JSON.stringify(sortedExpected)}, got ${JSON.stringify(sortedActual)}`
  );
}
