import { z } from '@justscale/core/models';
import { Creator } from '../domain/creator.js';
import { Backer } from '../domain/backer.js';
import { RewardTier } from '../domain/reward-tier.js';

/**
 * Fields every caller is allowed to see on a campaign.
 * Omits internal-ish fields like deadline, durationDays, imageUrls.
 */
export const CampaignPublicView = z.object({
  title: z.string(),
  description: z.string(),
  goalAmount: z.string(),
  currentAmount: z.string(),
  status: z.enum(['draft', 'active', 'funded', 'failed', 'settling', 'completed']),
});

/**
 * Extra fields visible only to the owning creator.
 */
export const CampaignOwnerView = CampaignPublicView.extend({
  deadline: z.string().optional(),
  durationDays: z.number(),
  imageUrls: z.array(z.string()).optional(),
});

export const ErrorResponse = z.object({
  error: z.string(),
});

/**
 * Body for POST /campaigns — create a new campaign.
 */
export const CreateCampaignBody = z.object({
  creator: z.ref(Creator),
  title: z.string().min(1),
  description: z.string(),
  goalAmount: z.string(),
  durationDays: z.number().int().positive().optional(),
  imageUrls: z.array(z.string()).optional(),
});

/**
 * Body for POST /campaigns/:campaign/rewards — add a reward tier.
 */
export const AddRewardTierBody = z.object({
  title: z.string().min(1),
  description: z.string(),
  amount: z.string(),
  quantityAvailable: z.number().int().positive().optional(),
  isEarlyBird: z.boolean().optional(),
  earlyBirdEndsAt: z.coerce.date().optional(),
});

/**
 * Body for POST /campaigns/:campaign/stretch-goals — add a stretch goal.
 */
export const AddStretchGoalBody = z.object({
  title: z.string().min(1),
  description: z.string(),
  targetAmount: z.string(),
});

/**
 * Body for POST /campaigns/:campaign/pledge — create a pledge.
 */
export const CreatePledgeBody = z.object({
  backer: z.ref(Backer),
  amount: z.string(),
  rewardTier: z.ref(RewardTier).optional(),
});

/**
 * Body for POST /backers — register a new backer.
 */
export const RegisterBackerBody = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email().max(255),
  shippingAddress: z.object({
    street: z.string().max(255),
    city: z.string().max(100),
    state: z.string().max(100),
    postalCode: z.string().max(20),
    country: z.string().max(100),
  }).optional(),
});
