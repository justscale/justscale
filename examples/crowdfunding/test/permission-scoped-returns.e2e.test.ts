/**
 * End-to-end test for permission-scoped `.returns()` on GET /campaigns/:campaign.
 *
 * Verifies at runtime:
 * - `.use(optionalAuth)` populates ctx.user when a session is present
 * - `.use(permissions)` calls each registered resolver (Everyone/Creator/Backer)
 * - Provider derives Creator by ctx.user.email lookup
 * - `permit(Creator).when(creator)` matches the owning creator → viewAsOwner
 * - Everyone else matches `permit(Everyone).always()` → view
 * - Response body shape matches the permission-scoped schema
 */

import { describe, test, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import postgres from 'postgres';
import JustScale, {
  bindRepository,
  bindService,
  AbstractChannelBackend,
  ChannelFeature,
  createConfig,
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
import {
  createPostgresClient,
  createPostgresChannelBackend,
  PostgresProcessFeature,
  PostgresProcessConfig,
  PostgresLockFeature,
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
  const dbName = `test_crowdfund_perm_${suffix}`;
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

describe('Permission-scoped .returns() on GET /campaigns/:campaign (pg e2e)', { timeout: 30000 }, async () => {
  if (!(await checkPostgres())) {
    test.skip('PostgreSQL not available', () => {});
    return;
  }

  // --- Spy on the CreatorResolver to prove it's actually called ---
  // Each request should hit the resolver exactly once via the default
  // aggregating AbstractPrincipalProvider.
  //
  // createContribution's factory is async and also registers the instance
  // with the parent aggregator as a side effect. To spy on calls made
  // through the aggregator, we mutate `resolve` on the returned instance
  // in place — parent.register() holds a reference to the same object.
  let resolveCallCount = 0;
  const originalFactory = CreatorResolver.factory;
  (CreatorResolver as unknown as {
    factory: typeof CreatorResolver.factory;
  }).factory = (async (deps: unknown, resolve: unknown) => {
    const instance = (await (originalFactory as unknown as (...args: unknown[]) => Promise<any>)(deps, resolve));
    const original = instance.resolve.bind(instance);
    instance.resolve = async (ctx: Parameters<typeof original>[0]) => {
      resolveCallCount++;
      return original(ctx);
    };
    return instance;
  }) as unknown as typeof CreatorResolver.factory;

  // --- Setup: create test DB and build app ---
  const testDb = await createTestDb();
  const sql = postgres(testDb.connectionString);

  const PostgresClient = createPostgresClient({ connectionString: testDb.connectionString });
  const PgChannelBackend = createPostgresChannelBackend({ connectionString: testDb.connectionString });

  const ProcessConfig = createConfig({
    provides: [PostgresProcessConfig],
    factory: () => ({
      [PostgresProcessConfig.key]: { signalChannel: 'crowdfund_perm_test' },
    }),
  });

  const app = (JustScale())
    .add(defaultHttpConfig)
    .add(ProcessConfig)
    .add(PostgresClient)
    .add(PgChannelBackend)
    .add(bindService(AbstractChannelBackend, PgChannelBackend))
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

  const pgClient = await app.container.resolve(PostgresClient);
  await new PgSchemaIntrospection(pgClient).sync(...ALL_PG_MODELS);

  const creatorRepo = await app.container.resolve(CreatorRepository);
  const campaignRepo = await app.container.resolve(CampaignRepository);

  const client = await t.createTestClient(app, { transports: { http: httpTransport } });

  // Declare controllers INLINE so typedApi preserves its inferred shape.
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

  beforeEach(async () => {
    const tables = ALL_PG_MODELS.map((m) => (m as unknown as { table: string }).table);
    await sql.unsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(', ')} CASCADE`);
    resolveCallCount = 0;
  });

  async function seedCreator(email: string) {
    return await creatorRepo.insert({
      name: 'Creator ' + email,
      email,
      verified: true,
    } as Parameters<typeof creatorRepo.insert>[0]);
  }

  async function seedCampaign(creator: Awaited<ReturnType<typeof seedCreator>>) {
    return await campaignRepo.insert({
      creator: Creator.ref(creator),
      title: 'Save the World',
      description: 'A campaign to save the world',
      goalAmount: '10000.00',
      durationDays: 30,
    } as Parameters<typeof campaignRepo.insert>[0]);
  }

  test('anonymous request → CampaignPublicView (no durationDays/deadline)', async () => {
    const creator = await seedCreator('anon-owner@example.com');
    const campaign = await seedCampaign(creator);

    // Pass the Persistent entity directly — client extracts id via refId().
    const result = await typedApi.api.campaigns.get({
      campaign,
    });

    assert.strictEqual(result.status, 200);
    if (result.status !== 200) return;
    const body = result.data;
    assert.strictEqual(body.title, 'Save the World');
    assert.strictEqual(body.goalAmount, '10000.00');
    assert.ok(!('durationDays' in body), 'public view must NOT leak durationDays');
    assert.ok(!('deadline' in body), 'public view must NOT leak deadline');

    assert.ok(resolveCallCount > 0, 'CreatorResolver.resolve must be called');
  });

  test('authenticated owner → CampaignOwnerView (with durationDays)', async () => {
    const ownerEmail = 'owner@example.com';
    const creator = await seedCreator(ownerEmail);
    const campaign = await seedCampaign(creator);

    const session = createUserSession(typedApi, {
      captureToken: (route, res) => {
        if (route === 'auth.register' || route === 'auth.login') {
          return (res.data as { token?: string })?.token;
        }
        return undefined;
      },
    });

    const reg = await session.api.auth.register({
      email: ownerEmail,
      password: 'password123',
      name: 'The Owner',
    });
    assert.strictEqual(reg.status, 201, `register should succeed (got ${reg.status})`);

    const result = await session.api.campaigns.get({
      campaign: Campaign.ref(campaign),
    });

    assert.strictEqual(result.status, 200);
    if (result.status !== 200) return;
    const body = result.data;
    assert.strictEqual(body.title, 'Save the World');
    assert.ok('durationDays' in body, 'owner view must include durationDays');
    assert.strictEqual(body.durationDays, 30);
  });

  test('authenticated non-owner → CampaignPublicView', async () => {
    const creator = await seedCreator('someone-else@example.com');
    const campaign = await seedCampaign(creator);

    const session = createUserSession(typedApi, {
      captureToken: (route, res) => {
        if (route === 'auth.register' || route === 'auth.login') {
          return (res.data as { token?: string })?.token;
        }
        return undefined;
      },
    });

    const reg = await session.api.auth.register({
      email: 'stranger@example.com',
      password: 'password123',
      name: 'Stranger',
    });
    assert.strictEqual(reg.status, 201);

    const result = await session.api.campaigns.get({
      campaign: Campaign.ref(campaign),
    });

    assert.strictEqual(result.status, 200);
    if (result.status !== 200) return;
    const body = result.data;
    assert.strictEqual(body.title, 'Save the World');
    assert.ok(!('durationDays' in body), 'non-owner should get public view');
  });
});
