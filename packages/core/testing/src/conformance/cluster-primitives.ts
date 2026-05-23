/**
 * Adapter conformance suite - cluster primitives.
 *
 * Every cluster-capable adapter (Postgres, Redis, future) must pass this
 * suite to claim conformance. Shape follows the well-trod JDBC/ODBC
 * pattern: one abstract spec, multiple concrete runners.
 *
 * ## How to use
 *
 * ```typescript
 * import { describeClusterConformance } from '@justscale/testing/conformance';
 * import { PostgresFeature, PostgresChannelFeature, PostgresLockFeature,
 *          PostgresProcessFeature } from '@justscale/postgres';
 *
 * describeClusterConformance('postgres (real docker pg)', {
 *   makeInstance: () => JustScale()
 *     .add(env)
 *     .add(PostgresFeature)
 *     .add(PostgresChannelFeature)
 *     .add(PostgresLockFeature)
 *     .add(PostgresProcessFeature),
 *   skipIfUnavailable: async () => !(await hasDockerPg()),
 * });
 * ```
 *
 * ## What it asserts
 *
 * 1. Channel pub/sub cross-instance - publish on A, subscribe on B, B receives within 500ms.
 * 2. Channel isolation - channels keyed differently don't cross-talk.
 * 3. Lock mutex - two instances racing for the same advisory lock, only one wins; release lets the other acquire.
 * 4. Lock hand-off - kill lock-holder, another instance picks it up.
 * 5. Process signal resume - process suspended at race(), signal fires, process wakes and advances pc.
 * 6. Process cross-instance signal - process running on A, emit from B, A resumes.
 * 7. Process advisory lock - spawn same process path on two instances, only one runs.
 *
 * Each scenario is scoped tight enough to pinpoint the failing primitive.
 */

import type JustScale from '@justscale/core';

/** The builder shape returned by `JustScale()`. */
type JustScaleBuilder = ReturnType<typeof JustScale>;

export interface ClusterConformanceOptions {
  /**
   * Factory that produces a fresh JustScale builder wired to the adapter
   * under test. Called per scenario (and per instance within scenarios
   * that need multiple). Must be totally independent - no shared state
   * between calls beyond the adapter's natural backend (e.g. the same
   * Postgres database, the same Redis instance).
   */
  makeInstance: (instanceId: number) => JustScaleBuilder | Promise<JustScaleBuilder>;

  /**
   * Optional: skip the whole suite if the adapter isn't available in the
   * current environment. For pg this means "docker compose up -d"; for
   * redis similar. Return true to skip, false to run.
   */
  skipIfUnavailable?: () => boolean | Promise<boolean>;

  /**
   * Optional: called once before any scenario to prepare the backend
   * (e.g., create the test database + run migrations). Runs outside any
   * instance factory.
   */
  beforeAll?: () => Promise<void>;

  /**
   * Optional: called once after all scenarios finish.
   */
  afterAll?: () => Promise<void>;
}

/**
 * Run the cluster conformance suite against an adapter.
 *
 * @param adapterName - Shows up in test output: "cluster-conformance/postgres"
 * @param opts - How to spin up instances + setup/teardown hooks
 */
export function describeClusterConformance(
  adapterName: string,
  opts: ClusterConformanceOptions,
): void {
  void adapterName;
  void opts;
  throw new Error(
    `describeClusterConformance('${adapterName}', ...) is not yet implemented. ` +
    'Scenarios are listed in the header comment.',
  );
}
