/**
 * @justscale/core/environment
 *
 * Declarative environment primitive - name + type + services + providers.
 * Enforces vault policy per environment type.
 */

export {
  ENVIRONMENT,
  ENVIRONMENT_TYPES,
  DEFAULT_VAULT_POLICY,
  isEnvironment,
} from './types.js';
export type {
  Environment,
  EnvironmentType,
  EnvContract,
  Env,
  RegisteredConfigPartials,
  RegisteredSecretPartials,
  RegisteredFlagPartials,
  VaultPolicy,
  VaultPolicyRules,
  VaultAllowedIn,
  ServiceCompatibleWithEnv,
} from './types.js';

export { createEnvironment } from './create-environment.js';
export {
  loadEnvironment,
  detectEnvironmentName,
  isEnvironmentType,
  __registerStaticEnvironment,
} from './load.js';
export type { LoadEnvironmentOptions } from './load.js';
