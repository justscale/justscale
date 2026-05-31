import { defineService } from '@justscale/core';
import { ModelRepository, type Locked, type Persistent, type Ref } from '@justscale/core/models';
import { Campaign, Creator, RewardTier, StretchGoal } from '../domain/index.js';

export class CampaignService extends defineService({
  inject: {
    campaigns: ModelRepository.of(Campaign),
    rewards: ModelRepository.of(RewardTier),
    goals: ModelRepository.of(StretchGoal),
  },
  factory: ({ campaigns, rewards, goals }) => ({
    async create(data: {
      creator: Ref<Creator>
      title: string
      description: string
      goalAmount: string
      durationDays?: number
      imageUrls?: string[]
    }): Promise<Persistent<Campaign>> {
      return await campaigns.insert({
        creator: data.creator,
        title: data.title,
        description: data.description,
        goalAmount: data.goalAmount,
        currentAmount: '0.00',
        status: 'draft',
        durationDays: data.durationDays ?? 30,
        imageUrls: data.imageUrls,
      });
    },

    async launch(campaign: Locked<Campaign>): Promise<Persistent<Campaign>> {
      if (campaign.status !== 'draft') {
        throw new Error(`Cannot launch campaign in status: ${campaign.status}`);
      }

      const deadline = new Date();
      deadline.setDate(deadline.getDate() + (campaign.durationDays || 30));

      return await campaigns.update(campaign, {
        status: 'active',
        deadline,
      });
    },

    async get(campaign: Ref<Campaign>): Promise<Persistent<Campaign> | undefined> {
      return await campaigns.get(campaign);
    },

    async list(): Promise<Persistent<Campaign>[]> {
      return await campaigns.find({ orderBy: { createdAt: 'desc' } });
    },

    async updateStatus(campaign: Locked<Campaign>, status: Persistent<Campaign>['status']): Promise<Persistent<Campaign>> {
      return await campaigns.update(campaign, { status });
    },

    async addRewardTier(campaign: Ref<Campaign>, data: {
      title: string
      description: string
      amount: string
      quantityAvailable?: number
      isEarlyBird?: boolean
      earlyBirdEndsAt?: Date
    }): Promise<Persistent<RewardTier>> {
      return await rewards.insert({
        campaign,
        ...data,
      });
    },

    async addStretchGoal(campaign: Ref<Campaign>, data: {
      title: string
      description: string
      targetAmount: string
    }): Promise<Persistent<StretchGoal>> {
      return await goals.insert({
        campaign,
        ...data,
      });
    },

    async checkStretchGoals(campaign: Ref<Campaign>, currentAmount: string): Promise<void> {
      const campaignGoals = await goals.find({
        where: StretchGoal.fields.campaign.eq(campaign),
      });
      for (const goal of campaignGoals) {
        if (!goal.unlockedAt && Number(currentAmount) >= Number(goal.targetAmount)) {
          using locked = await goals.lock(goal);
          if (locked) await goals.update(locked, { unlockedAt: new Date() });
        }
      }
    },
  }),
}) {}
