import { defineService } from '@justscale/core';
import { ModelRepository, type FindOptions, type Locked, type Persistent, type Ref } from '@justscale/core/models';
import { Backer, Campaign, Pledge, RewardTier } from '../domain/index.js';
import { PledgeSignals } from './signals.js';

export class PledgeService extends defineService({
  inject: {
    pledges: ModelRepository.of(Pledge),
    campaigns: ModelRepository.of(Campaign),
    rewards: ModelRepository.of(RewardTier),
    signals: PledgeSignals,
  },
  factory: ({ pledges, campaigns, rewards, signals }) => {
    return {
      // Re-export signals on the service so callers can subscribe via svc.fullyFunded
      get pledged() { return signals.pledged; },
      get cancelled() { return signals.cancelled; },
      get fullyFunded() { return signals.fullyFunded; },

      async pledge(campaign: Ref<Campaign>, backer: Ref<Backer>, amount: string, rewardTier?: Ref<RewardTier>): Promise<Persistent<Pledge>> {
        // Lock the campaign INSIDE this method, mutate, release before
        // emitting the signal. Why: the signal triggers
        // campaignLifecycle which re-locks the same campaign. Holding
        // the lock across `await signals.fullyFunded(...)` would deadlock
        // against ourselves (and matches the pattern PG signals already
        // use — NOTIFY is async, lock is freed before delivery).
        let pledge: Persistent<Pledge>;
        let isFullyFunded = false;

        {
          await using locked = await campaigns.lock(campaign);
          if (!locked) throw new Error('Campaign not found');
          if (locked.status !== 'active') {
            throw new Error('Campaign is not active');
          }

          if (rewardTier) {
            await using tier = await rewards.lock(rewards.get(rewardTier));
            if (!tier) throw new Error('Reward tier not found');

            if (tier.isEarlyBird) {
              const earlyBirdEnds = tier.earlyBirdEndsAt;
              if (earlyBirdEnds && new Date() > earlyBirdEnds) {
                throw new Error('Early bird period has ended');
              }
            }

            if (tier.quantityAvailable != null) {
              if (tier.quantityPledged >= tier.quantityAvailable) {
                throw new Error('Reward tier is sold out');
              }
              await rewards.update(tier, {
                quantityPledged: tier.quantityPledged + 1,
              });
            }

            if (Number(amount) < Number(tier.amount)) {
              throw new Error(`Minimum pledge for this tier is ${tier.amount}`);
            }
          }

          pledge = await pledges.insert({
            campaign: locked,
            backer,
            rewardTier,
            amount,
            status: 'pending',
          });

          const newAmount = (Number(locked.currentAmount) + Number(amount)).toFixed(2);
          await campaigns.update(locked, { currentAmount: newAmount });
          isFullyFunded = Number(newAmount) >= Number(locked.goalAmount);
        } // campaign + tier locks released here

        if (isFullyFunded) {
          // Lock has been released above; we only need the Ref for
          // routing. Cast through the Lock-typed payload — signal
          // identity uses .identifier at runtime regardless of shape.
          await signals.fullyFunded({ campaign: campaign as unknown as Locked<Campaign> });
        }

        return pledge;
      },

      async cancel(pledge: Locked<Pledge>, campaign: Locked<Campaign>): Promise<Persistent<Pledge>> {
        if (pledge.status !== 'pending') {
          throw new Error('Can only cancel pending pledges');
        }

        const newAmount = (Number(campaign.currentAmount) - Number(pledge.amount)).toFixed(2);
        await campaigns.update(campaign, { currentAmount: newAmount });

        return await pledges.update(pledge, { status: 'refunded', refundedAt: new Date() });
      },

      iterate(options: FindOptions<Pledge>): AsyncIterable<Persistent<Pledge>> {
        return pledges.stream(options);
      },

      async findIds(campaign: Ref<Campaign>): Promise<string[]> {
        const results = await pledges.find({
          where: Pledge.fields.campaign.eq(campaign),
        });
        return results.map(p => Pledge.ref(p).identifier);
      },
    };
  },
}) {}
