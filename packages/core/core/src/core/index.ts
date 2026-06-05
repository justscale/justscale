// Core - Foundation: DI + routing + observability

// DI Container & Services
export * from './service.js';
export * from './contribution.js';
export * from './disposable.js';
export * from './container-reflection.js';
export * from './scope-bridge.js';

// Request Context
export * from './context.js';

// Lifecycle
export { Lifecycle, isLifecycleToken, LIFECYCLE_TOKEN } from './lifecycle.js';
export type { LifecycleHooks } from './lifecycle.js';
export { LifecycleImpl } from './lifecycle-impl.js';

// Logger
export * from './logger.js';
export * from './pino-logger.js';

// Controller
export * from './controller.js';
export * from './controller.contextual.js';
export * from './controller.procedure.js';

// Middleware & Guards
export * from './middleware.js';

// Plugin System
export * from './plugin.js';

// HMR
export * from './hmr.js';
