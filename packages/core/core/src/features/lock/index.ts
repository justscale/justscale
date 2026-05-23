// Types
export type {
  Lock,
  LockMetadata,
  LockOptions,
  LockProvider,
  LockService,
} from './types.js';
export { isLocked } from './types.js';

// Service
export {
  LockServiceDef,
  AbstractLockProvider,
  LockAcquisitionError,
  DoubleLockError,
  LockReleasedError,
  InvalidLockKeyError,
  runWithLockTracking,
  getHeldLocks,
  _registerHeldLock,
  _unregisterHeldLock,
} from './lock-service.js';
