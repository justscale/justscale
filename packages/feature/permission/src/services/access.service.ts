/**
 * AccessService - field-level access control for serialization.
 *
 * Resolves principals from the request context and stores them in a
 * per-instance AsyncLocalStorage. The HTTP serializer reads principals
 * from this service to filter entity fields based on model access rules.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { defineService } from '@justscale/core';
import { filterByAccess, ACCESS_RULES, type FieldAccessRule } from '@justscale/core/models';
import { AbstractPrincipalProvider } from './principal-provider.js';
import type { Principal } from '../types.js';

export class AccessService extends defineService({
  inject: { principals: AbstractPrincipalProvider },
  factory: ({ principals }) => {
    const store = new AsyncLocalStorage<Principal[]>();

    return {
      /**
       * Get the resolved principals for the current request.
       */
      getPrincipals(): Principal[] | undefined {
        return store.getStore();
      },

      /**
       * Resolve principals from the request context and run the handler
       * with them available for access filtering.
       */
      async runWithPrincipals<T>(ctx: Record<string, unknown>, fn: () => T | Promise<T>): Promise<T> {
        const resolved = await principals.resolve(ctx);
        return store.run(resolved, fn);
      },

      /**
       * Filter an entity's fields based on access rules and current principals.
       * If no principals in context, returns all fields (no filtering).
       */
      filter(entity: Record<string, unknown>, modelClass: { readonly [ACCESS_RULES]?: Record<string, FieldAccessRule> }): Record<string, unknown> {
        const currentPrincipals = store.getStore();
        if (!currentPrincipals) return { ...entity };
        return filterByAccess(entity, modelClass, currentPrincipals);
      },
    };
  },
}) {}
