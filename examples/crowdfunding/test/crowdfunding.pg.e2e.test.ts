import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import postgres from 'postgres';
import JustScale, { bindRepository, AbstractChannelBackend, createConfig, createSecretProvider } from '@justscale/core';
import { ModelRepository } from '@justscale/core/models';
import {
  AbstractPostgresClient,
  PostgresFeature,
  PostgresChannelFeature,
  PostgresLockFeature,
  PostgresProcessFeature,
  PostgresProcessConfig,
  PostgresSecrets,
  PgProcessExecution,
  PgSignalSubscription,
} from '@justscale/postgres';
import { PgSchemaIntrospection } from '@justscale/postgres/testing';
import { defaultHttpConfig } from '@justscale/http/testing';
import { AbstractProcessExecutor, AbstractSignalBus, TestClock } from '@justscale/core/process';

import {
  Backer,
  Campaign,
  Pledge,
  RewardTier,
  StretchGoal,
  PaymentTransaction,
} from '../src/domain/index.js';

import {
  PgCreator,
  PgCampaign,
  PgRewardTier,
  PgBacker,
  PgPledge,
  PgStretchGoal,
  PgPaymentTransaction,
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
import { PledgeSignals, PaymentSignals } from '../src/services/signals.js';
import { BackerService } from '../src/services/backer.service.js';

import { campaignLifecycle } from '../src/processes/campaign-lifecycle.process.js';

// =============================================================================
// Configuration
// =============================================================================

const BASE_CONNECTION_STRING =
  process.env.DATABASE_URL ?? `postgresql://justscale:justscale@localhost:${process.env.PGPORT ?? 5433}/justscale_test`;

const ALL_PG_MODELS = [
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

// =============================================================================
// Helpers
// =============================================================================

async function waitForSubscription(
  bus: InstanceType<typeof AbstractSignalBus>,
  signalName: string,
  identity: Record<string, string>,
  timeout = 10000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const subs = await bus.findSubscriptions(signalName, identity);
    if (subs.length > 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timeout waiting for subscription to signal "${signalName}"`);
}

// =============================================================================
// Postgres availability check
// =============================================================================

// =============================================================================
// E2E Tests — full Postgres stack
// =============================================================================

async function checkPostgres(): Promise<boolean> {
  try {
    const sql = postgres(BASE_CONNECTION_STRING, { max: 1, connect_timeout: 3 });
    await sql`SELECT 1`;
    await sql.end();
    return true;
  } catch {
    return false;
  }
}

async function createTestDb(): Promise<{ connectionString: string; drop: () => Promise<void> }> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const dbName = `test_crowdfunding_${suffix}`;
  const admin = postgres(BASE_CONNECTION_STRING, { max: 1 });
  await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  await admin.end();
  const connectionString = BASE_CONNECTION_STRING.replace(/\/[^/]+$/, `/${dbName}`);
  return {
    connectionString,
    async drop() {
      const adm = postgres(BASE_CONNECTION_STRING, { max: 1 });
      await adm.unsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`);
      await adm.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
      await adm.end();
    },
  };
}

describe('Campaign Lifecycle (Postgres e2e)', { timeout: 30000 }, async () => {
  if (!await checkPostgres()) {
    test.skip('PostgreSQL not available', () => {});
    return;
  }

  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let sql: ReturnType<typeof postgres>;
  let built: any;
  let app: any;
  let client: AbstractPostgresClient;
  let clock: TestClock;

  let signalBus: InstanceType<typeof AbstractSignalBus>;
  let campaignSvc: any;
  let pledgeSvc: any;
  let paymentSvc: any;
  let backerSvc: any;

  before(async () => {
    testDb = await createTestDb();
    sql = postgres(testDb.connectionString);

    const Secrets = createSecretProvider({
      provides: [PostgresSecrets],
      factory: () => ({ [PostgresSecrets.key]: { connectionString: testDb.connectionString } }),
    });

    const ProcessConfig = createConfig({
      provides: [PostgresProcessConfig],
      factory: () => ({
        [PostgresProcessConfig.key]: { signalChannel: 'crowdfund_test' },
      }),
    });

    built = (JustScale() as any)
      .add(Secrets)
      .add(defaultHttpConfig)
      .add(ProcessConfig)
      .add(PostgresFeature)
      .add(PostgresChannelFeature)
      .add(PostgresLockFeature)
      .add(PostgresProcessFeature)
      .add(CreatorRepository)
      .add(CampaignRepository)
      .add(RewardTierRepository)
      .add(BackerRepository)
      .add(PledgeRepository)
      .add(StretchGoalRepository)
      .add(PaymentTransactionRepository)
      .add(bindRepository(ModelRepository.of(Campaign), CampaignRepository))
      .add(bindRepository(ModelRepository.of(Pledge), PledgeRepository))
      .add(bindRepository(ModelRepository.of(RewardTier), RewardTierRepository))
      .add(bindRepository(ModelRepository.of(StretchGoal), StretchGoalRepository))
      .add(bindRepository(ModelRepository.of(PaymentTransaction), PaymentTransactionRepository))
      .add(CampaignService)
      .add(PledgeSignals)
      .add(PaymentSignals)
      .add(PledgeService)
      .add(PaymentService)
      .add(BackerService)
      .build();

    app = built.compile();
    await app.ready;

    client = await app.container.resolve(AbstractPostgresClient);
    await new PgSchemaIntrospection(client).sync(...ALL_PG_MODELS);

    // Access the executor's timer scheduler for TestClock
    const executor = await app.container.resolve(AbstractProcessExecutor);
    const timerScheduler = (executor as any).timerScheduler;
    timerScheduler.stop();
    clock = new TestClock(timerScheduler);

    signalBus = await app.container.resolve(AbstractSignalBus);
    campaignSvc = await app.container.resolve(CampaignService);
    pledgeSvc = await app.container.resolve(PledgeService);
    paymentSvc = await app.container.resolve(PaymentService);
    backerSvc = await app.container.resolve(BackerService);
  });

  beforeEach(async () => {
    const allTables = ALL_PG_MODELS.map((m) => m.table);
    for (const table of [...allTables].reverse()) {
      await sql.unsafe(`TRUNCATE ${table} CASCADE`).catch(() => {});
    }
  });

  after(async () => {
    await built.stop();
    const channelBackend = await app.container.resolve(AbstractChannelBackend);
    if (channelBackend && typeof channelBackend.close === 'function') {
      await channelBackend.close();
    }
    await client.close();
    await sql.end();
    await testDb.drop();
  });

  test('successful campaign: fully funded → charge all backers', async () => {
    const creatorRepo = await app.container.resolve(CreatorRepository);
    const creator = await creatorRepo.insert({
      name: 'Alice Maker',
      email: 'alice@example.com',
      bio: 'Indie game developer',
      verified: true,
    } as any);

    const campaign = await campaignSvc.create({
      creator,
      title: 'Pixel Quest RPG',
      description: 'A retro-style RPG adventure',
      goalAmount: '5000.00',
      durationDays: 30,
    });
    {
      const campaignRepo = await app.container.resolve(ModelRepository.of(Campaign));
      using locked = await campaignRepo.lock(campaign);
      await campaignSvc.launch(locked!);
    }

    const backer1 = await backerSvc.register({ name: 'Bob', email: 'bob@example.com' });
    const backer2 = await backerSvc.register({ name: 'Carol', email: 'carol@example.com' });
    const backer3 = await backerSvc.register({ name: 'Dave', email: 'dave@example.com' });

    // Start the process — suspends on race(fullyFunded signal, delay.days)
    const handle = await campaignLifecycle([Campaign.ref(campaign)]);
    assert.strictEqual(clock.pendingCount, 1, 'delay timer should be pending');

    const campaignRepo2 = await app.container.resolve(ModelRepository.of(Campaign));

    // pledge() locks the campaign internally and releases before emitting
    // fullyFunded — see pledge.service.ts. Outer lock would deadlock against
    // the campaignLifecycle handler that re-locks the same campaign.
    await pledgeSvc.pledge(Campaign.ref(campaign), backer1, '15.00');
    await pledgeSvc.pledge(Campaign.ref(campaign), backer2, '2500.00');

    // Third pledge hits goal → fullyFunded signal fires → process resumes,
    // enters charge loop, charges first pledge, suspends on chargeProcessed
    await pledgeSvc.pledge(Campaign.ref(campaign), backer3, '2500.00');

    // Emit chargeProcessed for each pledge
    const pledgeRepo = await app.container.resolve(PledgeRepository);
    const allPledges = await pledgeRepo.find({
      where: Pledge.fields.campaign.eq(Campaign.ref(campaign)),
      orderBy: { createdAt: 'asc' } as any,
    });

    const identity = { campaign: Campaign.ref(campaign).identifier };
    for (const _pledge of allPledges) {
      await waitForSubscription(signalBus, 'payment.campaign.charge-processed', identity);
      await paymentSvc.chargeProcessed({ campaign: Campaign.ref(campaign) as any });
    }

    const result = await handle.wait();
    assert.ok(result);
    assert.strictEqual(result.status, 'completed');

    // Verify final state
    const finalCampaign = await campaignSvc.get(campaign);
    assert.strictEqual(finalCampaign!.status, 'completed');

    const chargedPledges = await pledgeRepo.find({
      where: Pledge.fields.status.eq('charged'),
    });
    assert.strictEqual(chargedPledges.length, 3);

    const txRepo = await app.container.resolve(PaymentTransactionRepository);
    const chargeTx = await txRepo.find({
      where: PaymentTransaction.fields.type.eq('charge'),
    });
    assert.strictEqual(chargeTx.length, 3);
  });

  test('failed campaign: deadline expires → refund all backers', async () => {
    const creatorRepo = await app.container.resolve(CreatorRepository);
    const creator = await creatorRepo.insert({
      name: 'Eve Creator',
      email: 'eve@example.com',
      verified: false,
    } as any);

    const campaign = await campaignSvc.create({
      creator,
      title: 'Underfunded Project',
      description: 'This wont make it',
      goalAmount: '10000.00',
      durationDays: 7,
    });
    {
      const campaignRepo = await app.container.resolve(ModelRepository.of(Campaign));
      using locked = await campaignRepo.lock(campaign);
      await campaignSvc.launch(locked!);
    }

    const backer1 = await backerSvc.register({ name: 'Frank', email: 'frank@example.com' });
    const backer2 = await backerSvc.register({ name: 'Grace', email: 'grace@example.com' });

    await pledgeSvc.pledge(Campaign.ref(campaign), backer1, '100.00');
    await pledgeSvc.pledge(Campaign.ref(campaign), backer2, '200.00');

    // Start the process — suspends on race(fullyFunded signal, delay.days)
    const handle = await campaignLifecycle([Campaign.ref(campaign)]);
    assert.strictEqual(clock.pendingCount, 1, 'delay timer should be pending');

    // Fire the delay timer → process resumes on the delay branch,
    // refunds first pledge, suspends on refundProcessed
    clock.fireNext();

    // Emit refundProcessed for each pledge
    const pledgeRepo = await app.container.resolve(PledgeRepository);
    const allPledges = await pledgeRepo.find({
      where: Pledge.fields.campaign.eq(Campaign.ref(campaign)),
      orderBy: { createdAt: 'asc' } as any,
    });

    const identity2 = { campaign: Campaign.ref(campaign).identifier };
    for (const _pledge of allPledges) {
      await waitForSubscription(signalBus, 'payment.campaign.refund-processed', identity2);
      await paymentSvc.refundProcessed({ campaign: Campaign.ref(campaign) as any });
    }

    const result = await handle.wait();
    assert.ok(result);
    assert.strictEqual(result.status, 'failed');

    // Verify final state
    const finalCampaign = await campaignSvc.get(campaign);
    assert.strictEqual(finalCampaign!.status, 'failed');

    const refundedPledges = await pledgeRepo.find({
      where: Pledge.fields.status.eq('refunded'),
    });
    assert.strictEqual(refundedPledges.length, 2);

    const txRepo = await app.container.resolve(PaymentTransactionRepository);
    const refundTx = await txRepo.find({
      where: PaymentTransaction.fields.type.eq('refund'),
    });
    assert.strictEqual(refundTx.length, 2);
  });
});
