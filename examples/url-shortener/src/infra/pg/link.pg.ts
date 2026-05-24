import { createPgModel, createPgRepository } from '@justscale/postgres';
import { Link } from '../../domains/link/link.model.js';

// Infrastructure owns storage concerns: table name, indexes, the id strategy.
// The domain model above stays pure and never imports this file.
export const PgLink = createPgModel(Link, {
  table: 'links',
  overrides: { slug: { index: true } },
});

export const LinkRepository = createPgRepository(PgLink);
