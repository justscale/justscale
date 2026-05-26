/**
 * Injects ChildService. If HMR registers services but fails to resolve
 * their deps through the live container, ParentService's factory
 * throws at resolution time — the route that uses it won't answer and
 * the e2e test catches it.
 */

import { defineService } from '@justscale/core';
import { ChildService } from './child.service.js';

export class ParentService extends defineService({
  inject: { child: ChildService },
  factory: ({ child }) => ({
    greetLoud: (name: string) => child.whisper(name).toUpperCase(),
  }),
}) {}
