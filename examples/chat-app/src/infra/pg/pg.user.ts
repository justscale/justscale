import { createPgModel, createPgRepository } from '@justscale/postgres';
import { User } from '@justscale/auth';

export const PgUser = createPgModel(User, { table: 'users' });
export const PgUserRepository = createPgRepository(PgUser);
