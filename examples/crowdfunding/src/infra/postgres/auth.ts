import { createPgModel, createPgRepository } from '@justscale/postgres';
import { User, Session } from '@justscale/auth';

export const PgUser = createPgModel(User, { table: 'users' });
export const PgSession = createPgModel(Session, { table: 'sessions' });

export const UserRepository = createPgRepository(PgUser);
export const SessionRepository = createPgRepository(PgSession);
