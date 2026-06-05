import { createPgModel, createPgRepository } from '@justscale/postgres';
import { Backer } from '../../domain/backer.js';

export const PgBacker = createPgModel(Backer, {
  table: 'backers',
  overrides: {
    email: { unique: true, index: true },
  },
});

export const BackerRepository = createPgRepository(PgBacker);
