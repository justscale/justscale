import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { InMemoryRepository, ModelRepository, getModelFields, registerModelRefResolver, type FieldDef } from '@justscale/core/models';
import { TestContainer } from '@justscale/testing';
import { setupTestProcessRuntime, TestClock } from '@justscale/core/process';

import {
  Creator,
  Campaign,
  RewardTier,
  Backer,
  Pledge,
  StretchGoal,
  PaymentTransaction,
} from '../src/domain/index.js';

import {
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

import { campaignLifecycle } from '../src/processes/campaign-lifecycle.process.js';

// ============================================================================
// Helpers
// ============================================================================

function createTestRepos() {
  const getFieldDefsForRef = (fieldDef: FieldDef): Record<string, FieldDef> | undefined => {
    const target = fieldDef.refTarget?.();
    if (target === Creator) return getModelFields(Creator);
    if (target === Campaign) return getModelFields(Campaign);
    if (target === RewardTier) return getModelFields(RewardTier);
    if (target === Backer) return getModelFields(Backer);
    if (target === Pledge) return getModelFields(Pledge);
    if (target === StretchGoal) return getModelFields(StretchGoal);
    if (target === PaymentTransaction) return getModelFields(PaymentTransaction);
    return undefined;
  };

  // repos object populated below — resolver captures it lazily
  const repos: Record<string, InMemoryRepository<any>> = {};

  const resolver = (refId: string, fieldDef: FieldDef) => {
    const target = fieldDef.refTarget?.();
    if (target === Creator) return repos.creators['store'].get(refId) as Record<string, unknown> | undefined;
    if (target === Campaign) return repos.campaigns['store'].get(refId) as Record<string, unknown> | undefined;
    if (target === RewardTier) return repos.rewards['store'].get(refId) as Record<string, unknown> | undefined;
    if (target === Backer) return repos.backers['store'].get(refId) as Record<string, unknown> | undefined;
    if (target === Pledge) return repos.pledges['store'].get(refId) as Record<string, unknown> | undefined;
    if (target === StretchGoal) return repos.goals['store'].get(refId) as Record<string, unknown> | undefined;
    if (target === PaymentTransaction) return repos.transactions['store'].get(refId) as Record<string, unknown> | undefined;
    return undefined;
  };

  const opts = (model: any) => ({
    fieldDefs: getModelFields(model),
    relationResolver: resolver,
    getFieldDefsForRef,
  });

  repos.creators = new InMemoryRepository<Creator>(opts(Creator));
  repos.backers = new InMemoryRepository<Backer>(opts(Backer));
  repos.campaigns = new InMemoryRepository<Campaign>(opts(Campaign));
  repos.rewards = new InMemoryRepository<RewardTier>(opts(RewardTier));
  repos.pledges = new InMemoryRepository<Pledge>(opts(Pledge));
  repos.goals = new InMemoryRepository<StretchGoal>(opts(StretchGoal));
  repos.transactions = new InMemoryRepository<PaymentTransaction>(opts(PaymentTransaction));

  return repos as {
    creators: InMemoryRepository<Creator>;
    backers: InMemoryRepository<Backer>;
    campaigns: InMemoryRepository<Campaign>;
    rewards: InMemoryRepository<RewardTier>;
    pledges: InMemoryRepository<Pledge>;
    goals: InMemoryRepository<StretchGoal>;
    transactions: InMemoryRepository<PaymentTransaction>;
  };
}

// ============================================================================
// E2E Tests — exercises the actual compiled process
// ============================================================================

describe('Campaign Lifecycle (e2e)', () => {
  let container: TestContainer;
  let repos: ReturnType<typeof createTestRepos>;
  let runtime: ReturnType<typeof setupTestProcessRuntime>;
  let clock: TestClock;

  let campaignSvc: Awaited<ReturnType<typeof container.get<typeof CampaignService>>>;
  let pledgeSvc: Awaited<ReturnType<typeof container.get<typeof PledgeService>>>;
  let paymentSvc: Awaited<ReturnType<typeof container.get<typeof PaymentService>>>;
  let backerSvc: Awaited<ReturnType<typeof container.get<typeof BackerService>>>;

  beforeEach(async () => {
    container = new TestContainer();
    repos = createTestRepos();

    // Register ref resolvers so process types config can resolve References
    registerModelRefResolver(Campaign as any, async (id) => repos.campaigns['store'].get(id) ?? null);
    registerModelRefResolver(Pledge as any, async (id) => repos.pledges['store'].get(id) ?? null);

    container.registerInstance(CreatorRepository, repos.creators as any);
    container.registerInstance(CampaignRepository, repos.campaigns as any);
    container.registerInstance(RewardTierRepository, repos.rewards as any);
    container.registerInstance(BackerRepository, repos.backers as any);
    container.registerInstance(PledgeRepository, repos.pledges as any);
    container.registerInstance(StretchGoalRepository, repos.goals as any);
    container.registerInstance(PaymentTransactionRepository, repos.transactions as any);

    container.registerInstance(ModelRepository.of(Campaign), repos.campaigns as any);
    container.registerInstance(ModelRepository.of(Pledge), repos.pledges as any);
    container.registerInstance(ModelRepository.of(RewardTier), repos.rewards as any);
    container.registerInstance(ModelRepository.of(StretchGoal), repos.goals as any);
    container.registerInstance(ModelRepository.of(PaymentTransaction), repos.transactions as any);

    runtime = setupTestProcessRuntime(container);
    runtime.timerScheduler.stop();
    clock = new TestClock(runtime.timerScheduler);

    const { PledgeSignals, PaymentSignals } = await import('../src/services/signals.js');
    container.register(PledgeSignals);
    container.register(PaymentSignals);
    container.register(CampaignService);
    container.register(PledgeService);
    container.register(PaymentService);
    container.register(BackerService);

    campaignSvc = await container.get(CampaignService);
    pledgeSvc = await container.get(PledgeService);
    paymentSvc = await container.get(PaymentService);
    backerSvc = await container.get(BackerService);
  });

  afterEach(() => {
    runtime.stop();
    runtime.clear();
  });

  test('successful campaign: fully funded → charge all backers', async () => {
    const creator = await repos.creators.insert({
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
      using locked = await repos.campaigns.lock(campaign);
      await campaignSvc.launch(locked!);
    }

    const backer1 = await backerSvc.register({ name: 'Bob', email: 'bob@example.com' });
    const backer2 = await backerSvc.register({ name: 'Carol', email: 'carol@example.com' });
    const backer3 = await backerSvc.register({ name: 'Dave', email: 'dave@example.com' });

    // Start the process — suspends on race(fullyFunded signal, delay.days)
    const handle = await campaignLifecycle([Campaign.ref(campaign)]);
    assert.strictEqual(clock.pendingCount, 1, 'delay timer should be pending');

    // pledge() now locks the campaign internally and releases before
    // emitting fullyFunded — so the test doesn't need an outer lock,
    // and the campaignLifecycle handler can re-lock without deadlock.
    await pledgeSvc.pledge(Campaign.ref(campaign), backer1, '15.00');
    await pledgeSvc.pledge(Campaign.ref(campaign), backer2, '2500.00');

    // Third pledge hits goal → fullyFunded signal fires → process resumes,
    // enters charge loop, charges first pledge, suspends on chargeProcessed
    await pledgeSvc.pledge(Campaign.ref(campaign), backer3, '2500.00');
    // Yield to let process resume and reach first chargeProcessed suspend
    await new Promise(r => setTimeout(r, 200));

    // Emit chargeProcessed for each pledge — each emission resumes the process,
    // which charges the next pledge and re-suspends (or completes on the last one)
    const allPledges = await repos.pledges.find({
      where: Pledge.fields.campaign.eq(Campaign.ref(campaign)),
      orderBy: { createdAt: 'asc' } as any,
    });

    assert.strictEqual(allPledges.length, 3, 'should have 3 pledges in repo');

    for (const _pledge of allPledges) {
      // Don't hold the campaign lock while emitting — the handler
      // re-locks the campaign for setCampaignStatus and would deadlock.
      await paymentSvc.chargeProcessed({ campaign: Campaign.ref(campaign) as any });
      await new Promise(r => setTimeout(r, 200));
    }

    const result = await handle.wait();
    assert.strictEqual(result!.status, 'completed');

    // Verify final state
    const finalCampaign = await campaignSvc.get(campaign);
    assert.strictEqual(finalCampaign!.status, 'completed');

    const chargedPledges = await repos.pledges.find({
      where: Pledge.fields.status.eq('charged'),
    });
    assert.strictEqual(chargedPledges.length, 3);

    const chargeTx = await repos.transactions.find({
      where: PaymentTransaction.fields.type.eq('charge'),
    });
    assert.strictEqual(chargeTx.length, 3);
  });

  test('failed campaign: deadline expires → refund all backers', async () => {
    const creator = await repos.creators.insert({
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
      using locked = await repos.campaigns.lock(campaign);
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
    // Timer callback uses setImmediate — yield to let the process resume
    await new Promise(r => setTimeout(r, 200));

    // Emit refundProcessed for each pledge
    const allPledges = await repos.pledges.find({
      where: Pledge.fields.campaign.eq(Campaign.ref(campaign)),
      orderBy: { createdAt: 'asc' } as any,
    });

    for (const _pledge of allPledges) {
      await paymentSvc.refundProcessed({ campaign: Campaign.ref(campaign) as any });
      await new Promise(r => setTimeout(r, 200));
    }

    const result = await handle.wait();
    assert.strictEqual(result!.status, 'failed');

    // Verify final state
    const finalCampaign = await campaignSvc.get(campaign);
    assert.strictEqual(finalCampaign!.status, 'failed');

    const refundedPledges = await repos.pledges.find({
      where: Pledge.fields.status.eq('refunded'),
    });
    assert.strictEqual(refundedPledges.length, 2);

    const refundTx = await repos.transactions.find({
      where: PaymentTransaction.fields.type.eq('refund'),
    });
    assert.strictEqual(refundTx.length, 2);
  });
});

// ============================================================================
// Repository Query Tests
// ============================================================================

describe('Repository Queries', () => {
  let repos: ReturnType<typeof createTestRepos>;

  beforeEach(() => {
    repos = createTestRepos();
  });

  test('find pledges by campaign using has()', async () => {
    const creator = await repos.creators.insert({
      name: 'Liam', email: 'liam@example.com',
    } as any);

    const campaign1 = await repos.campaigns.insert({
      creator,
      title: 'Campaign A',
      description: 'A',
      goalAmount: '1000.00',
      status: 'active',
      durationDays: 30,
    } as any);

    const campaign2 = await repos.campaigns.insert({
      creator,
      title: 'Campaign B',
      description: 'B',
      goalAmount: '2000.00',
      status: 'active',
      durationDays: 30,
    } as any);

    const backer = await repos.backers.insert({
      name: 'Mia', email: 'mia@example.com',
    } as any);

    await repos.pledges.insert({
      campaign: campaign1,
      backer,
      amount: '50.00',
      status: 'pending',
    } as any);

    await repos.pledges.insert({
      campaign: campaign2,
      backer,
      amount: '100.00',
      status: 'pending',
    } as any);

    const campaign1Pledges = await repos.pledges.find({
      where: Pledge.fields.campaign.has(Campaign.fields.title.eq('Campaign A')),
    });
    assert.strictEqual(campaign1Pledges.length, 1);
    assert.strictEqual((campaign1Pledges[0] as any).amount, '50.00');
  });

  test('find transactions by pledge status', async () => {
    const creator = await repos.creators.insert({
      name: 'Noah', email: 'noah@example.com',
    } as any);

    const campaign = await repos.campaigns.insert({
      creator,
      title: 'TxTest',
      description: 'Testing transactions',
      goalAmount: '1000.00',
      status: 'active',
      durationDays: 30,
    } as any);

    const backer = await repos.backers.insert({
      name: 'Olga', email: 'olga@example.com',
    } as any);

    const chargedPledge = await repos.pledges.insert({
      campaign,
      backer,
      amount: '50.00',
      status: 'charged',
      chargedAt: new Date(),
    } as any);

    const refundedPledge = await repos.pledges.insert({
      campaign,
      backer,
      amount: '30.00',
      status: 'refunded',
      refundedAt: new Date(),
    } as any);

    await repos.transactions.insert({
      pledge: chargedPledge,
      type: 'charge',
      amount: '50.00',
      status: 'success',
      processedAt: new Date(),
    } as any);

    await repos.transactions.insert({
      pledge: refundedPledge,
      type: 'refund',
      amount: '30.00',
      status: 'success',
      processedAt: new Date(),
    } as any);

    const chargeTx = await repos.transactions.find({
      where: PaymentTransaction.fields.pledge.has(Pledge.fields.status.eq('charged')),
    });
    assert.strictEqual(chargeTx.length, 1);
    assert.strictEqual((chargeTx[0] as any).type, 'charge');

    const refundTx = await repos.transactions.find({
      where: PaymentTransaction.fields.pledge.has(Pledge.fields.status.eq('refunded')),
    });
    assert.strictEqual(refundTx.length, 1);
    assert.strictEqual((refundTx[0] as any).type, 'refund');
  });

  test('find pledges by backer shipping address', async () => {
    const creator = await repos.creators.insert({
      name: 'Pat', email: 'pat@example.com',
    } as any);

    const campaign = await repos.campaigns.insert({
      creator,
      title: 'Shipping Test',
      description: 'Test',
      goalAmount: '1000.00',
      status: 'active',
      durationDays: 30,
    } as any);

    const portlandBacker = await repos.backers.insert({
      name: 'Quinn',
      email: 'quinn@example.com',
      shippingAddress: {
        street: '1 St', city: 'Portland', state: 'OR',
        postalCode: '97201', country: 'USA',
      },
    } as any);

    const seattleBacker = await repos.backers.insert({
      name: 'Riley',
      email: 'riley@example.com',
      shippingAddress: {
        street: '2 St', city: 'Seattle', state: 'WA',
        postalCode: '98101', country: 'USA',
      },
    } as any);

    await repos.pledges.insert({
      campaign,
      backer: portlandBacker,
      amount: '25.00',
      status: 'pending',
    } as any);

    await repos.pledges.insert({
      campaign,
      backer: seattleBacker,
      amount: '50.00',
      status: 'pending',
    } as any);

    const portlandPledges = await repos.pledges.find({
      where: Pledge.fields.backer.has(
        (Backer.fields.shippingAddress as any).city.eq('Portland'),
      ),
    });
    assert.strictEqual(portlandPledges.length, 1);
    assert.strictEqual((portlandPledges[0] as any).amount, '25.00');
  });
});
