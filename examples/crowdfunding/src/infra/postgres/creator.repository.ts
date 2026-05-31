import { createPgModel, createPgRepository } from '@justscale/postgres';
import { Creator } from '../../domain/creator.js';

export const PgCreator = createPgModel(Creator, {
  table: 'creators',
  overrides: {
    email: { unique: true, index: true },
  },
});

export const CreatorRepository = createPgRepository(PgCreator);
