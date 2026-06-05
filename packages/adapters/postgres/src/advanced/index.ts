/**
 * `@justscale/postgres/advanced` - low-level escape hatches.
 *
 * **Prefer the features.** For normal apps, wire Postgres with
 * `PostgresFeature` / `PostgresChannelFeature` / `PostgresLockFeature` (from
 * `@justscale/postgres`) plus a `Secret.of(PostgresSecrets)` provider. The
 * features provide `AbstractPostgresClient` / `AbstractChannelBackend` for you,
 * and pool size is tunable via `PostgresClientConfig` - so you should rarely
 * need anything here.
 *
 * Reach for these factories only when the feature shape doesn't fit: a custom
 * secret shape, multiple databases in one app, or hand-built wiring. They are
 * intentionally kept off the main barrel so the feature path is the obvious
 * default.
 */

export {
  createPostgresClient,
  createRawPostgresClient,
} from '../client/client.js';

export { createPostgresChannelBackend } from '../channel/channel-backend.js';
