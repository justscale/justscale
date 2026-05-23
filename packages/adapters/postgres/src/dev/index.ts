/**
 * `@justscale/postgres/dev` - dev-only CLI surface.
 *
 * Exports dev-only migration commands (`migrate make`, `migrate fresh`,
 * `migrate verify`). Intentionally does NOT export pglite - local dev
 * runs against real Postgres via docker. Pglite is a test artefact and
 * lives at `@justscale/postgres/testing`.
 */

export { PostgresMigrationDevFeature } from '../migration/migration-dev-feature.js';
export { MigrationDevController } from '../migration/migration-dev-controller.js';
