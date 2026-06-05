/**
 * End-to-end test for the contribution pattern on AbstractPrincipalProvider.
 *
 * Verifies at runtime that multiple independent resolvers contribute to
 * the same request via the framework's default aggregating
 * AbstractPrincipalProvider:
 *
 * - EveryoneResolver always contributes a single Everyone principal
 * - CreatorResolver contributes a Creator principal when ctx.user is a creator
 * - BackerResolver contributes a Backer principal when ctx.user is a backer
 *
 * A single authenticated request where the user is BOTH a Creator and a
 * Backer should see all three resolvers fire, and the aggregated principal
 * list should contain principals from all three.
 */

import { describe, test, after, before } from 'node:test';
import assert from 'node:assert';
import postgres from 'postgres';
import JustScale, {
  bindRepository,
  bindService,
  ChannelFeature,
  createConfig,
  createSecretProvider,
} from '@justscale/core';
import { ModelRepository } from '@justscale/core/models';
import {
  AbstractEmailSender,
  AuthController,
  AuthEndpointsFeature,
  AuthFeature,
  ConsoleEmailSender,
  PasswordController,
  Session,
  TwoFactorController,
  User,
} from '@justscale/auth';
import { AbstractPrincipalProvider } from '@justscale/permission';
import {
  AbstractPostgresClient,
  PostgresFeature,
  PostgresChannelFeature,
  PostgresProcessFeature,
  PostgresProcessConfig,
  PostgresLockFeature,
  PostgresSecrets,
  PgProcessExecution,
  PgSignalSubscription,
} from '@justscale/postgres';
import { PgSchemaIntrospection } from '@justscale/postgres/testing';
import { httpTransport, createUserSession, defaultHttpConfig } from '@justscale/http/testing';
import * as t from '@justscale/testing';

import {
  Backer,
  Campaign,
  Creator,
  Pledge,
  PaymentTransaction,
  RewardTier,
  StretchGoal,
} from '../src/domain/index.js';
import {
  PgUser,
  PgSession,
  PgCreator,
  PgCampaign,
  PgRewardTier,
  PgBacker,
  PgPledge,
  PgStretchGoal,
  PgPaymentTransaction,
  UserRepository,
  SessionRepository,
  CreatorRepository,
  CampaignRepository,
  RewardTierRepository,
  BackerRepository,
  PledgeRepository,
  StretchGoalRepository,
  PaymentTransactionRepository,
} from '../src/infra/postgres/index.js';
import { CampaignService } from '../src/services/campaign.service.js';
import { PledgeService } from '../src/services/pledge.service.js';
import { PaymentService } from '../src/services/payment.service.js';
import { BackerService } from '../src/services/backer.service.js';
import { PledgeSignals, PaymentSignals } from '../src/services/signals.js';
import {
  BackerResolver,
  CreatorResolver,
  EveryoneResolver,
} from '../src/services/principal-provider.js';
import { CampaignController } from '../src/controllers/campaign.controller.js';

const BASE_CONNECTION_STRING =
  process.env.DATABASE_URL ??
  `postgresql://justscale:justscale@localhost:${process.env.PGPORT ?? 5433}/justscale_test`;

const ALL_PG_MODELS = [
  PgUser,
  PgSession,
  PgCreator,
  PgCampaign,
  PgRewardTier,
  PgBacker,
  PgPledge,
  PgStretchGoal,
  PgPaymentTransaction,
  PgProcessExecution,
  PgSignalSubscription,
];

async function checkPostgres(): Promise<boolean> {
  try {
    const sql = postgres(BASE_CONNECTION_STRING, { max: 1, connect_timeout: 2 });
    await sql`SELECT 1`;
    await sql.end();
    return true;
  } catch {
    return false;
  }
}

async function createTestDb(): Promise<{ connectionString: string; drop: () => Promise<void> }> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const dbName = `test_crowdfund_multi_${suffix}`;
  const admin = postgres(BASE_CONNECTION_STRING, { max: 1 });
  await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  await admin.end();
  const connectionString = BASE_CONNECTION_STRING.replace(/\/[^/]+$/, `/${dbName}`);
  return {
    connectionString,
    async drop() {
      const adm = postgres(BASE_CONNECTION_STRING, { max: 1 });
      await adm.unsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`,
      );
      await adm.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
      await adm.end();
    },
  };
}

describe('Multi-resolver contribution pattern (pg e2e)', { timeout: 30000 }, async () => {
  if (!(await checkPostgres())) {
    test.skip('PostgreSQL not available', () => {});
    return;
  }

  // Spy on each resolver independently so we can prove all three fire per request.
  let everyoneCalls = 0;
  let creatorCalls = 0;
  let backerCalls = 0;

  const originalEveryone = EveryoneResolver.factory;
  (EveryoneResolver as unknown as { factory: typeof EveryoneResolver.factory }).factory = (async (
    deps: unknown,
    resolve: unknown,
  ) => {
    const instance = await (originalEveryone as unknown as (...args: unknown[]) => Promise<any>)(deps, resolve);
    const original = instance.resolve.bind(instance);
    instance.resolve = async (ctx: Parameters<typeof original>[0]) => {
      everyoneCalls++;
      return original(ctx);
    };
    return instance;
  }) as unknown as typeof EveryoneResolver.factory;

  const originalCreator = CreatorResolver.factory;
  (CreatorResolver as unknown as { factory: typeof CreatorResolver.factory }).factory = (async (
    deps: unknown,
    resolve: unknown,
  ) => {
    const instance = await (originalCreator as unknown as (...args: unknown[]) => Promise<any>)(deps, resolve);
    const original = instance.resolve.bind(instance);
    instance.resolve = async (ctx: Parameters<typeof original>[0]) => {
      creatorCalls++;
      return original(ctx);
    };
    return instance;
  }) as unknown as typeof CreatorResolver.factory;

  const originalBacker = BackerResolver.factory;
  (BackerResolver as unknown as { factory: typeof BackerResolver.factory }).factory = (async (
    deps: unknown,
    resolve: unknown,
  ) => {
    const instance = await (originalBacker as unknown as (...args: unknown[]) => Promise<any>)(deps, resolve);
    const original = instance.resolve.bind(instance);
    instance.resolve = async (ctx: Parameters<typeof original>[0]) => {
      backerCalls++;
      return original(ctx);
    };
    return instance;
  }) as unknown as typeof BackerResolver.factory;

  const testDb = await createTestDb();
  const sql = postgres(testDb.connectionString);

  const Secrets = createSecretProvider({
    provides: [PostgresSecrets],
    factory: () => ({ [PostgresSecrets.key]: { connectionString: testDb.connectionString } }),
  });

  const ProcessConfig = createConfig({
    provides: [PostgresProcessConfig],
    factory: () => ({
      [PostgresProcessConfig.key]: { signalChannel: 'crowdfund_multi_test' },
    }),
  });

  const app = JustScale()
    .add(Secrets)
    .add(defaultHttpConfig)
    .add(ProcessConfig)
    .add(PostgresFeature)
    .add(PostgresChannelFeature)
    .add(ChannelFeature)
    .add(PostgresLockFeature)
    .add(PostgresProcessFeature)
    .add(bindRepository(ModelRepository.of(User), UserRepository))
    .add(bindRepository(ModelRepository.of(Session), SessionRepository))
    .add(bindService(AbstractEmailSender, ConsoleEmailSender))
    .add(AuthFeature)
    .add(AuthEndpointsFeature)
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
    .add(PledgeSignals)
    .add(PaymentSignals)
    .add(BackerService)
    .add(CampaignService)
    .add(PledgeService)
    .add(PaymentService)
    .add(EveryoneResolver)
    .add(CreatorResolver)
    .add(BackerResolver)
    .add(CampaignController)
    .build()
    .compile();

  await app.ready;

  const pgClient = await app.container.resolve(AbstractPostgresClient);
  await new PgSchemaIntrospection(pgClient).sync(...ALL_PG_MODELS);

  const creatorRepo = await app.container.resolve(CreatorRepository);
  const backerRepo = await app.container.resolve(BackerRepository);
  const campaignRepo = await app.container.resolve(CampaignRepository);

  const client = await t.createTestClient(app, { transports: { http: httpTransport } });
  const typedApi = client.http.useControllers({
    auth: AuthController,
    twofa: TwoFactorController,
    password: PasswordController,
    campaigns: CampaignController,
  });

  after(async () => {
    await client.close();
    await sql.end();
    await testDb.drop();
  });

  test('anonymous request — only Everyone contributes', async () => {
    everyoneCalls = 0;
    creatorCalls = 0;
    backerCalls = 0;

    const creator = await creatorRepo.insert({
      name: 'Solo Creator',
      email: 'solo@example.com',
      verified: true,
    } as Parameters<typeof creatorRepo.insert>[0]);
    const campaign = await campaignRepo.insert({
      creator: Creator.ref(creator),
      title: 'Anon Campaign',
      description: 'x',
      goalAmount: '1000.00',
      durationDays: 10,
    } as Parameters<typeof campaignRepo.insert>[0]);

    const result = await typedApi.api.campaigns.get({ campaign });
    assert.strictEqual(result.status, 200);

    // All resolvers are called (aggregator invokes each); Creator/Backer just
    // return [] because no ctx.user. Everyone always contributes.
    assert.strictEqual(everyoneCalls, 1, 'EveryoneResolver must be called exactly once');
    assert.strictEqual(creatorCalls, 1, 'CreatorResolver must be called exactly once');
    assert.strictEqual(backerCalls, 1, 'BackerResolver must be called exactly once');
  });

  test('user registered as both Creator and Backer — all three resolvers contribute principals', async () => {
    everyoneCalls = 0;
    creatorCalls = 0;
    backerCalls = 0;

    const dualEmail = 'dual-role@example.com';

    // Seed a Creator and a Backer with the same email so a single logged-in
    // user matches both resolvers.
    const creator = await creatorRepo.insert({
      name: 'Dual Role Creator',
      email: dualEmail,
      verified: true,
    } as Parameters<typeof creatorRepo.insert>[0]);
    await backerRepo.insert({
      name: 'Dual Role Backer',
      email: dualEmail,
    } as Parameters<typeof backerRepo.insert>[0]);
    const campaign = await campaignRepo.insert({
      creator: Creator.ref(creator),
      title: 'Dual Campaign',
      description: 'both',
      goalAmount: '5000.00',
      durationDays: 20,
    } as Parameters<typeof campaignRepo.insert>[0]);

    // Query the aggregator directly AFTER authenticating through a request.
    // Easiest: make a request with a session, resolvers fire, then also
    // resolve the aggregator and invoke it with a ctx containing our user
    // to verify the principal list aggregates correctly.
    const session = createUserSession(typedApi, {
      captureToken: (route, res) => {
        if (route === 'auth.register' || route === 'auth.login') {
          return (res.data as { token?: string })?.token;
        }
        return undefined;
      },
    });
    const reg = await session.api.auth.register({
      email: dualEmail,
      password: 'password123',
      name: 'Dual Role',
    });
    assert.strictEqual(reg.status, 201);

    const result = await session.api.campaigns.get({
      campaign: Campaign.ref(campaign),
    });
    assert.strictEqual(result.status, 200);

    // All three resolvers must have fired on the authenticated request
    // (counts may be >=1 because register and get both go through the
    // permissions middleware — assert all three are called at least once).
    assert.ok(everyoneCalls >= 1, `EveryoneResolver should fire (got ${everyoneCalls})`);
    assert.ok(creatorCalls >= 1, `CreatorResolver should fire (got ${creatorCalls})`);
    assert.ok(backerCalls >= 1, `BackerResolver should fire (got ${backerCalls})`);

    // Directly exercise the aggregator: it should return principals from
    // Everyone + Creator + Backer when given the authenticated user's ctx.
    const userRepo = await app.container.resolve(UserRepository);
    const user = await userRepo.findOne(User.fields.email.eq(dualEmail));
    assert.ok(user, 'registered user should exist');

    const aggregator = await app.container.resolve(AbstractPrincipalProvider);
    const principals = await aggregator.resolve({ user });

    const principalTypes = principals.map((p) => p.type.name);
    assert.ok(principalTypes.includes('Everyone'), 'aggregator must include Everyone principal');
    assert.ok(principalTypes.includes('Creator'), 'aggregator must include Creator principal');
    assert.ok(principalTypes.includes('Backer'), 'aggregator must include Backer principal');
    assert.strictEqual(principals.length, 3, 'exactly 3 principals (one per resolver) expected');
  });
});
