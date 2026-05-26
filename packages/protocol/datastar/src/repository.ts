/**
 * Signal Repository
 *
 * Provides dirty tracking and validation for signal data.
 */

import {
  type Model,
  createModel,
  getModelInternals,
} from '@justscale/observable';
import type { z } from 'zod';
import type { DatastarStream } from './types.js';

export class SignalRepository<T> {
  constructor(
    private schema: z.ZodType<T>,
    private stream: DatastarStream,
  ) {}

  /**
   * Create a model from raw signal data (with validation + defaults)
   */
  create(data?: unknown): Model<T> {
    return createModel(this.schema, data);
  }

  /**
   * Save dirty changes to signals
   * Returns true if anything was saved
   */
  save(model: Model<T>): boolean {
    const internals = getModelInternals(model);

    if (!internals.isDirty()) {
      return false;
    }

    const dirtyData = internals.getDirtyData();
    this.stream.mergeSignals(dirtyData as Record<string, unknown>);
    internals.markClean();

    return true;
  }

  /**
   * Force save all data (not just dirty)
   */
  saveAll(model: Model<T>): void {
    const internals = getModelInternals(model);

    // Clone without the symbol
    const data: Record<string, unknown> = {};
    for (const key of Object.keys(model as object)) {
      data[key] = (model as Record<string, unknown>)[key];
    }

    this.stream.mergeSignals(data as Record<string, unknown>);
    internals.markClean();
  }
}

/**
 * Factory for creating signal repositories in route handlers
 */
export function createSignalRepository<T>(
  schema: z.ZodType<T>,
  stream: DatastarStream,
): SignalRepository<T> {
  return new SignalRepository(schema, stream);
}
