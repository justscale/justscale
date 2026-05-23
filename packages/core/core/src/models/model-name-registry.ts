/**
 * Core model name registry.
 *
 * Maps model names to model classes. Used by the Reference deserializer
 * to recreate typed refs via Model.ref(id) during process state restoration.
 *
 * Populated by adapters (createPgModel, createInMemoryModel) at registration time.
 */

import type { Reference } from './reference/reference.js';

export interface RegisteredModel {
  ref: (id: string) => Reference<unknown>;
}

const registry = new Map<string, RegisteredModel>();

export function registerModelByName(name: string, model: RegisteredModel): void {
  registry.set(name, model);
}

export function getModelByName(name: string): RegisteredModel | undefined {
  return registry.get(name);
}

export function getModelNameRegistry(): ReadonlyMap<string, RegisteredModel> {
  return registry;
}
