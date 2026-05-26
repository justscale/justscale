/**
 * Pre-staged for the "service-to-service DI in a single edit" e2e
 * test. Bare leaf service, no deps of its own. The test wires up
 * ChildService + ParentService (which injects ChildService) +
 * LoudController (which injects ParentService) in a single .add()
 * chain edit — verifying HMR's add-new path resolves service deps
 * against the live container, not just controllers.
 */

import { defineService } from '@justscale/core';

export class ChildService extends defineService({
  inject: {},
  factory: () => ({
    whisper: (name: string) => `hi ${name}`,
  }),
}) {}
