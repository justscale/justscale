import JustScale, { bindRepository, bindService, ChannelFeature, createConfig, createSecretProvider } from '@justscale/core';
import { ModelRepository } from '@justscale/core/models';
import {
  AbstractEmailSender,
  AuthEndpointsFeature,
  AuthFeature,
  ConsoleEmailSender,
  Session,
  User,
} from '@justscale/auth';
import {
  PostgresFeature,
  PostgresChannelFeature,
  PostgresLockFeature,
  PostgresProcessFeature,
  PostgresProcessConfig,
  PostgresSecrets,
} from '@justscale/postgres';
import {
  Backer,
  Campaign,
  Creator,
  Pledge,
  RewardTier,
  StretchGoal,
  PaymentTransaction,
} from './domain/index.js';
import {
  UserRepository,
  SessionRepository,
  CreatorRepository,
  CampaignRepository,
  RewardTierRepository,
  BackerRepository,
  PledgeRepository,
  StretchGoalRepository,
  PaymentTransactionRepository,
} from './infra/postgres/index.js';
import { BackerService, CampaignService, PledgeService, PaymentService } from './services/index.js';
import { PledgeSignals, PaymentSignals } from './services/signals.js';
import { EveryoneResolver, CreatorResolver, BackerResolver } from './services/principal-provider.js';
import { CampaignController } from './controllers/campaign.controller.js';
import { PledgeController } from './controllers/pledge.controller.js';
import { BackerController } from './controllers/backer.controller.js';
import { campaignLifecycle } from './processes/campaign-lifecycle.process.js';

const connectionString = process.env.DATABASE_URL ?? `postgres://localhost:${process.env.PGPORT ?? 5433}/crowdfunding`;

const Secrets = createSecretProvider({
  provides: [PostgresSecrets],
  factory: () => ({ [PostgresSecrets.key]: { connectionString } }),
});

const CrowdfundingConfig = createConfig({
  provides: [PostgresProcessConfig],
  factory: () => ({
    [PostgresProcessConfig.key]: { signalChannel: 'process_signals' },
  }),
});

export const app = (JustScale() as any)
  .add(Secrets)
  .add(CrowdfundingConfig)
  .add(PostgresFeature)
  .add(PostgresChannelFeature)
  .add(ChannelFeature)
  .add(PostgresLockFeature)
  .add(PostgresProcessFeature)
  // Auth — User/Session repos + AuthFeature + AuthEndpointsFeature
  .add(bindRepository(ModelRepository.of(User), UserRepository))
  .add(bindRepository(ModelRepository.of(Session), SessionRepository))
  .add(bindService(AbstractEmailSender, ConsoleEmailSender))
  .add(AuthFeature)
  .add(AuthEndpointsFeature)
  // Domain repos
  .add(CreatorRepository)
  .add(CampaignRepository)
  .add(RewardTierRepository)
  .add(BackerRepository)
  .add(PledgeRepository)
  .add(StretchGoalRepository)
  .add(PaymentTransactionRepository)
  .add(bindRepository(ModelRepository.of(Creator), CreatorRepository))
  .add(bindRepository(ModelRepository.of(Backer), BackerRepository))
  .add(bindRepository(ModelRepository.of(Campaign), CampaignRepository))
  .add(bindRepository(ModelRepository.of(Pledge), PledgeRepository))
  .add(bindRepository(ModelRepository.of(RewardTier), RewardTierRepository))
  .add(bindRepository(ModelRepository.of(StretchGoal), StretchGoalRepository))
  .add(bindRepository(ModelRepository.of(PaymentTransaction), PaymentTransactionRepository))
  // Services + signals
  .add(PledgeSignals)
  .add(PaymentSignals)
  .add(BackerService)
  .add(CampaignService)
  .add(PledgeService)
  .add(PaymentService)
  // Permissions — each resolver contributes independently;
  // the default AbstractPrincipalProvider aggregates them.
  .add(EveryoneResolver)
  .add(CreatorResolver)
  .add(BackerResolver)
  // Controllers
  .add(CampaignController)
  .add(PledgeController)
  .add(BackerController)
  .add(campaignLifecycle)
  .build();
