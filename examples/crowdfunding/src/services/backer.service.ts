import { defineService } from '@justscale/core';
import type { Persistent, Ref } from '@justscale/core/models';
import { Backer } from '../domain/index.js';
import { BackerRepository } from '../infra/postgres/index.js';

export class BackerService extends defineService({
  inject: { backers: BackerRepository },
  factory: ({ backers }) => ({
    async register(data: {
      name: string
      email: string
      shippingAddress?: Persistent<Backer>['shippingAddress']
    }): Promise<Persistent<Backer>> {
      return await backers.insert(data);
    },

    async get(backer: Ref<Backer>): Promise<Persistent<Backer> | undefined> {
      return await backers.get(backer);
    },
  }),
}) {}
