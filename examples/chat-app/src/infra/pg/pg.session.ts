import { createPgModel, createPgRepository } from '@justscale/postgres';
import { Session } from '@justscale/auth';

export const PgSession = createPgModel(Session, { table: 'sessions' });
export const PgSessionRepository = createPgRepository(PgSession);
