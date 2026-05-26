import { defineService } from '@justscale/core';

export class SubScopedService extends defineService({
  inject: {},
  factory: () => ({
    speak(): string {
      return 'sub-v1';
    },
  }),
}) {}
