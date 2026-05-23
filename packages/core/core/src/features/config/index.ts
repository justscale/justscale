/**
 * @justscale/config
 *
 * Type-safe configuration management with Zod validation.
 */

// Types
export {
  CONFIG_PARTIAL,
  isConfigPartial,
  isConfigComponent,
} from './types.js';
export type {
  ConfigPartial,
  ConfigComponent,
} from './types.js';

// Define config partials
export {
  defineConfigPartial,
} from './define-config-partial.js';

// Config injection
export {
  Config,
  createToken,
} from './config-of.js';
export type {
  ConfigToken,
} from './config-of.js';

// Create config components
export {
  createConfig,
} from './create-config.js';

// Environment service
export {
  EnvServiceDef,
} from './env-service.js';
export type {
  EnvService,
} from './env-service.js';

// Config service
export {
  ConfigServiceDef,
  createConfigService,
} from './config-service.js';
export type {
  ConfigService,
  ConfigServiceOptions,
} from './config-service.js';

// Profile service
export {
  ProfileServiceDef,
} from './profile-service.js';
export type {
  ProfileService,
} from './profile-service.js';

// File watcher
export {
  watchEnvFiles,
} from './file-watcher.js';
export type {
  EnvFileWatcher,
} from './file-watcher.js';

// CLI
export {
  createConfigController,
  createProfileController,
  getPath,
  formatValue,
} from './cli/index.js';
