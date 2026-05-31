import { createPgModel, createPgRepository } from '@justscale/postgres';
import { StretchGoal } from '../../domain/stretch-goal.js';

export const PgStretchGoal = createPgModel(StretchGoal, {
  table: 'stretch_goals',
  relations: {
    campaign: { onDelete: 'CASCADE' },
  },
  indexes: [
    { fields: ['campaignId'], name: 'idx_stretch_goals_campaign' },
  ],
});

export const StretchGoalRepository = createPgRepository(PgStretchGoal);
