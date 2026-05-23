/**
 * In-Memory Storage Adapter
 *
 * Provides in-memory implementations of the repository pattern.
 * Useful for testing, prototyping, or simple use cases.
 *
 * @example
 * ```typescript
 * import { defineModel, field } from '@justscale/core/models'
 * import { createInMemoryModel, InMemoryRepository } from '@justscale/core/models/in-memory'
 *
 * const User = defineModel('User', {
 *   email: field.string().max(255),
 *   name: field.string(),
 * })
 *
 * // Option 1: Use createInMemoryModel wrapper (like createPgModel)
 * const MemoryUser = createInMemoryModel(User)
 * const userRepo = MemoryUser.repository()
 *
 * // Option 2: Use InMemoryRepository directly
 * const repo = new InMemoryRepository<typeof User>()
 *
 * // Query using field expressions
 * const user = await repo.findOne(User.fields.email.eq('test@example.com'))
 * ```
 */

// Repository
export { InMemoryRepository } from './in-memory-repository.js';
export type { InMemoryRepositoryOptions, RelationResolver } from './in-memory-repository.js';

// Model wrapper
export {
  createInMemoryModel,
  createInMemoryRepository,
} from './in-memory-model.js';
export type {
  InMemoryModel,
  InMemoryModelOptions,
  CreateRepositoryOptions,
} from './in-memory-model.js';

// Condition evaluator (for advanced use/testing)
export {
  evaluateCondition,
  sortEntities,
  computeAggregation,
} from './condition-evaluator.js';
export type { EvaluatorContext } from './condition-evaluator.js';

// Scheduled task repository
export { InMemoryScheduledTaskRepository } from './in-memory-scheduled-task.repository.js';
