/**
 * PostgreSQL Signal Bus
 *
 * Routes signals to waiting processes using:
 * - PostgreSQL table for subscription persistence
 * - LISTEN/NOTIFY for real-time signal delivery
 *
 * @example
 * ```typescript
 * import { createPgSignalBus } from '@justscale/postgres'
 *
 * const signalBus = await createPgSignalBus({
 *   subscriptionRepo: repo,
 *   pubsub,
 * })
 *
 * // In executor
 * const executor = new ProcessExecutor({ signalBus, ... })
 * ```
 */

import { ADAPTER_KEY, defineModel, field } from '@justscale/core/models';
import {
  AbstractSignalBus,
  type SignalBus,
  type SignalMatch,
  type SignalRaceBranch as RaceBranch,
} from '@justscale/core/process';
import type { ChannelBackend } from '@justscale/core';
import { createPgModel } from '../model/pg-model.js';
import { createPgRepository, type Repository } from '../repository/pg-repository-service.js';
import { versionOf } from '../repository/pg-repository.js';

/** Extract adapter key from a persistent entity */
function keyOf(entity: unknown): string {
  const key = (entity as Record<symbol, unknown>)[ADAPTER_KEY];
  if (key === undefined) throw new Error('Entity has no adapter key - not persistent');
  return key as string;
}

// Simple trace logging for adapter
const TRACE_ENABLED = process.env.JUSTSCALE_TRACE === '1' || process.env.JUSTSCALE_TRACE === 'true';
function trace(message: string, data?: Record<string, unknown>): void {
  if (!TRACE_ENABLED) return;
  const timestamp = new Date().toISOString();
  const dataStr = data ? ' ' + JSON.stringify(data) : '';
  console.debug(`[${timestamp}] [TRACE] [PgSignalBus] ${message}${dataStr}`);
}


/** Queued event stored in database for cross-instance support */
interface QueuedPayload {
  signal: string
  identity: Record<string, string>
  payload: unknown
  branchId: string
}

/**
 * Domain model for signal subscriptions.
 */
export class SignalSubscription extends defineModel({
  name: 'JustScale_SignalSubscription',
  fields: {
    /** Process instance ID waiting for this signal */
    instanceId: field.string().max(512),
    /** Subscription type: 'signal' or 'race' */
    type: field.string().max(10).default('signal'),
    /** Signal name to wait for (for signal subscriptions) */
    signal: field.string().max(255).optional(),
    /** Identity filter as JSONB */
    identity: field.json<Record<string, string>>().default({}),
    /** Race branches as JSONB (for race subscriptions) */
    branches: field.json<RaceBranch[]>().optional(),
    /** Status: 'waiting' | 'matched' */
    status: field.string().max(20).default('waiting'),
    /** Matched payload (when signal arrives) */
    matchedPayload: field.json<unknown>().optional(),
    /** Matched branch ID (for races) */
    matchedBranchId: field.string().max(64).optional(),
    /** Queued payloads for events that arrived during processing */
    queuedPayloads: field.json<QueuedPayload[]>().default([]),
  },
}) {}

/**
 * PostgreSQL-specific subscription model.
 */
export const PgSignalSubscription = createPgModel(SignalSubscription, {
  table: 'process_signal_subscriptions',
});

/**
 * Repository for signal subscriptions.
 */
export const SignalSubscriptionRepository =
  createPgRepository(PgSignalSubscription);


type SubscriptionRepo = Repository<SignalSubscription>;

export interface PgSignalBusOptions {
  /** Subscription repository */
  subscriptionRepo: SubscriptionRepo
  /** Channel backend for real-time notifications (optional - falls back to polling) */
  channelBackend?: ChannelBackend
  /** Channel name for signal notifications (default: 'process_signals') */
  channel?: string
}

/**
 * PostgreSQL-backed signal bus.
 *
 * Uses table storage for durability and LISTEN/NOTIFY for real-time delivery.
 * Events that arrive while a process is executing are queued in the database
 * on the subscription record, ensuring cross-instance consistency.
 */
export class PgSignalBus extends AbstractSignalBus implements SignalBus {
  private readonly repo: SubscriptionRepo;
  private readonly channelBackend?: ChannelBackend;
  private readonly channelKey: string;
  private readonly matchCallbacks = new Set<(match: SignalMatch) => void>();
  private subscription: Disposable | null = null;

  constructor(options: PgSignalBusOptions) {
    super();
    this.repo = options.subscriptionRepo;
    this.channelBackend = options.channelBackend;
    this.channelKey = options.channel ?? 'process_signals';
  }

  /**
   * Start listening for signal notifications.
   */
  async start(): Promise<void> {
    if (!this.channelBackend) return;
    this.subscription = this.channelBackend.subscribe(this.channelKey, (msg) => {
      this.handleNotification(msg as SignalNotification);
    });
  }

  /**
   * Stop listening.
   */
  async stop(): Promise<void> {
    if (this.subscription) {
      this.subscription[Symbol.dispose]();
      this.subscription = null;
    }
  }

  async emit(
    signal: string,
    identity: Record<string, string>,
    payload?: unknown,
  ): Promise<number> {
    trace('emit', { signal, identity });

    // Find ALL subscriptions (waiting AND matched) to handle queuing
    const allSubscriptions = await this.repo.find({});
    const waitingSubscriptions = allSubscriptions.filter(s => s.status === 'waiting');
    const matchedSubscriptions = allSubscriptions.filter(s => s.status === 'matched');

    trace('emit.subscriptions', { waiting: waitingSubscriptions.length, matched: matchedSubscriptions.length });

    let matchCount = 0;

    // First, queue events for any instanceIds that are currently processing
    // (have a 'matched' subscription but haven't re-subscribed yet)
    // We store queued events in the database for cross-instance consistency
    for (const sub of matchedSubscriptions) {
      if (sub.type === 'race') {
        const branches = sub.branches as RaceBranch[];
        for (const branch of branches) {
          if (!branch.signal) continue;
          if (branch.signal !== signal) continue;
          if (branch.identity && !this.matchesIdentity(branch.identity, identity)) continue;

          // This instanceId is processing - queue the event in the database
          // via optimistic-concurrency read-modify-write. Without the
          // expectedVersion check, two concurrent emitters would both read
          // the baseline queuedPayloads, both push their payload, and both
          // write — last-write-wins, dropping one event silently.
          //
          // The retry handles the legitimate "stale write" case: read v=N,
          // try to write with expectedVersion=N, get rejected because
          // someone else wrote v=N+1, re-read at v=N+1, retry. Backoff +
          // jitter avoids lockstep retries from N concurrent emitters
          // racing the same row.
          const MAX_ATTEMPTS = 5;
          let queued = false;
          for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            const freshSub = await this.repo.get(sub);
            if (!freshSub || freshSub.status !== 'matched') {
              trace('emit.queueSkipped', { instanceId: sub.instanceId, reason: 'subscription gone or processed' });
              break;
            }

            const queuedPayloads = (freshSub.queuedPayloads as QueuedPayload[]) || [];
            queuedPayloads.push({ signal, identity, payload, branchId: branch.branchId });

            trace('emit.queueing', { instanceId: sub.instanceId, signal, branchId: branch.branchId, queueLength: queuedPayloads.length, attempt });

            try {
              await this.repo.update(freshSub, { queuedPayloads }, versionOf(freshSub));
              matchCount++;
              queued = true;
              break;
            } catch (err) {
              if (attempt >= MAX_ATTEMPTS) {
                // The waiting subscription will still observe the live signal
                // through the normal match path below — this only matters if
                // the subscription is mid-processing. Trace and move on.
                trace('emit.queueFailed', { instanceId: sub.instanceId, error: (err as Error).message, attempts: attempt });
                break;
              }
              // Exponential backoff with jitter: 5, 10, 20, 40 ms ± 100%.
              // Spreads concurrent retries so they don't collide again.
              const baseMs = 5 * 2 ** (attempt - 1);
              const jitter = Math.random() * baseMs;
              await new Promise(r => setTimeout(r, baseMs + jitter));
            }
          }
          void queued;
          break;
        }
      }
    }

    // Now match waiting subscriptions as before
    for (const sub of waitingSubscriptions) {
      const subId = keyOf(sub);
      trace('emit.checkingSub', { type: sub.type, signal: sub.signal, subId });
      if (sub.type === 'signal') {
        // Simple signal subscription
        if (sub.signal !== signal) continue;
        if (!this.matchesIdentity(sub.identity, identity)) continue;

        trace('emit.signalMatch', { subId, signal });

        // Mark as matched
        await this.repo.update(sub, {
          status: 'matched',
          matchedPayload: payload ?? null,
        });

        matchCount++;

        // Notify via channel backend (for cross-instance distribution)
        if (this.channelBackend) {
          const notification: SignalNotification = {
            subscriptionId: subId,
            instanceId: sub.instanceId,
            payload,
          };
          trace('emit.publishing', { channel: this.channelKey, notification });
          this.channelBackend.publish(this.channelKey, notification);
        }
      } else if (sub.type === 'race') {
        // Race subscription - check each branch
        const branches = sub.branches as RaceBranch[];
        for (const branch of branches) {
          if (!branch.signal) continue;
          if (branch.signal !== signal) {
            trace('emit.branchSignalMismatch', { branchSignal: branch.signal, emittedSignal: signal });
            continue;
          }
          if (
            branch.identity &&
            !this.matchesIdentity(branch.identity, identity)
          ) {
            trace('emit.branchIdentityMismatch', { branchIdentity: branch.identity, emittedIdentity: identity });
            continue;
          }

          trace('emit.raceMatch', { subId, branchId: branch.branchId, signal });

          // Mark as matched. Optimistic versioning in the repo throws on a
          // concurrent write - that's the real "another signal already
          // matched" signal.
          try {
            await this.repo.update(sub, {
              status: 'matched',
              matchedPayload: payload ?? null,
              matchedBranchId: branch.branchId,
            });
          } catch (err) {
            trace('emit.raceMatchFailed', { subId, branchId: branch.branchId, error: (err as Error).message });
            break;
          }

          matchCount++;

          // Notify via channel backend (for cross-instance distribution)
          if (this.channelBackend) {
            const notification: SignalNotification = {
              subscriptionId: subId,
              instanceId: sub.instanceId,
              payload,
              branchId: branch.branchId,
            };
            trace('emit.publishing', { channel: this.channelKey, notification });
            this.channelBackend.publish(this.channelKey, notification);
          }

          break; // Only one branch can win
        }
      }
    }

    return matchCount;
  }

  async subscribe(
    instanceId: string,
    signal: string,
    identity: Record<string, string>,
  ): Promise<string> {
    // Delete any stale subscription rows for this instance. The executor
    // that originally registered them may have crashed without cleanup,
    // leaving orphaned rows that emit() would otherwise keep iterating.
    await this.deleteSubscriptionsForInstance(instanceId);

    const entity = await this.repo.insert({
      instanceId,
      type: 'signal',
      signal,
      identity,
      status: 'waiting',
    } as any);
    return keyOf(entity);
  }

  async subscribeRace(
    instanceId: string,
    branches: RaceBranch[],
  ): Promise<string> {
    trace('subscribeRace', { instanceId, branches });
    try {
      // Check for old 'matched' subscriptions that may have queued events
      // This handles cross-instance scenarios where events were queued on another instance
      const oldSubscriptions = await this.repo.find({
        where: SignalSubscription.fields.instanceId.eq(instanceId),
      });
      const matchedSub = oldSubscriptions.find(s => s.status === 'matched');
      const queuedPayloads = (matchedSub?.queuedPayloads as QueuedPayload[]) || [];

      // Remove the old rows now that we've extracted any queuedPayloads.
      // Without this, crash+failover leaks a 'waiting' row per takeover
      // (the crashed executor never runs its cleanup loop).
      for (const old of oldSubscriptions) {
        try {
          await this.repo.delete(old);
        } catch {
          // Already gone (concurrent cleanup); safe to ignore.
        }
      }

      // Create new subscription
      const entity = await this.repo.insert({
        instanceId,
        type: 'race',
        branches,
        status: 'waiting',
      } as any);
      const entityKey = keyOf(entity);
      trace('subscribeRace.created', { id: entityKey, hasQueuedPayloads: queuedPayloads.length > 0 });

      // If there are queued events, deliver the first one immediately
      if (queuedPayloads.length > 0) {
        const queuedEvent = queuedPayloads[0];
        const remainingPayloads = queuedPayloads.slice(1);

        trace('subscribeRace.dequeueing', {
          instanceId,
          signal: queuedEvent.signal,
          branchId: queuedEvent.branchId,
          remainingQueue: remainingPayloads.length,
        });

        // Find the matching branch for the queued event
        const matchingBranch = branches.find(b =>
          b.signal === queuedEvent.signal &&
          (!b.identity || this.matchesIdentity(b.identity, queuedEvent.identity))
        );

        if (matchingBranch) {
          // Immediately mark the new subscription as matched with the queued event
          // Store remaining payloads on the new subscription
          await this.repo.update(entity, {
            status: 'matched',
            matchedPayload: queuedEvent.payload ?? null,
            matchedBranchId: queuedEvent.branchId,
            queuedPayloads: remainingPayloads,
          });

          // Notify via channel backend
          if (this.channelBackend) {
            const notification: SignalNotification = {
              subscriptionId: entityKey,
              instanceId,
              payload: queuedEvent.payload,
              branchId: queuedEvent.branchId,
            };
            trace('subscribeRace.publishingQueued', { channel: this.channelKey, notification });
            this.channelBackend.publish(this.channelKey, notification);
          }
        }
      }

      return entityKey;
    } catch (err) {
      trace('subscribeRace.error', { error: (err as Error).message, stack: (err as Error).stack });
      throw err;
    }
  }

  async unsubscribe(subscriptionId: string): Promise<void> {
    try {
      await this.repo.delete(SignalSubscription.ref`${subscriptionId}`);
    } catch {
      // Ignore if already deleted
    }
  }

  private async deleteSubscriptionsForInstance(instanceId: string): Promise<void> {
    const old = await this.repo.find({
      where: SignalSubscription.fields.instanceId.eq(instanceId),
    });
    for (const sub of old) {
      try {
        await this.repo.delete(sub);
      } catch {
        // Already gone (concurrent cleanup); safe to ignore.
      }
    }
  }

  async checkSignal(subscriptionId: string): Promise<SignalMatch | null> {
    const sub = await this.repo.get(SignalSubscription.ref`${subscriptionId}`);
    if (!sub || sub.status !== 'matched') return null;

    return {
      subscriptionId: keyOf(sub),
      instanceId: sub.instanceId,
      payload: sub.matchedPayload,
    };
  }

  async checkRace(subscriptionId: string): Promise<SignalMatch | null> {
    const sub = await this.repo.get(SignalSubscription.ref`${subscriptionId}`);
    if (!sub || sub.status !== 'matched') return null;

    return {
      subscriptionId: keyOf(sub),
      instanceId: sub.instanceId,
      payload: sub.matchedPayload,
      branchId: sub.matchedBranchId,
    };
  }

  onMatch(callback: (match: SignalMatch) => void): () => void {
    trace('onMatch.registering', { callbackName: callback.name || 'anonymous', currentCount: this.matchCallbacks.size });
    this.matchCallbacks.add(callback);
    trace('onMatch.registered', { newCount: this.matchCallbacks.size });
    return () => this.matchCallbacks.delete(callback);
  }

  async findSubscriptions(
    signal: string,
    identity: Record<string, string>,
  ): Promise<{ instanceId: string }[]> {
    const subscriptions = await this.repo.find({
      where: SignalSubscription.fields.status.eq('waiting'),
    });

    const results: { instanceId: string }[] = [];

    for (const sub of subscriptions) {
      if (sub.type === 'signal') {
        if (sub.signal !== signal) continue;
        if (!this.matchesIdentity(sub.identity, identity)) continue;
        results.push({ instanceId: sub.instanceId });
      } else if (sub.type === 'race') {
        const branches = sub.branches as RaceBranch[];
        for (const branch of branches) {
          if (!branch.signal) continue;
          if (branch.signal !== signal) continue;
          if (branch.identity && !this.matchesIdentity(branch.identity, identity)) continue;
          results.push({ instanceId: sub.instanceId });
          break;
        }
      }
    }

    return results;
  }

  private matchesIdentity(
    subscriptionIdentity: Record<string, string>,
    emitIdentity: Record<string, string>,
  ): boolean {
    for (const [key, value] of Object.entries(subscriptionIdentity)) {
      if (emitIdentity[key] !== value) return false;
    }
    return true;
  }

  private handleNotification(notification: SignalNotification): void {
    trace('handleNotification', { notification });
    const match: SignalMatch = {
      subscriptionId: notification.subscriptionId,
      instanceId: notification.instanceId,
      payload: notification.payload,
      branchId: notification.branchId,
    };

    trace('handleNotification.callbacks', { count: this.matchCallbacks.size });
    for (const callback of this.matchCallbacks) {
      try {
        trace('handleNotification.calling', { callbackName: callback.name || 'anonymous' });
        // Callback is `void | Promise<void>`. The channel-backend subscription
        // signature is sync, so we cannot `await` here. Attach a .catch on
        // any returned promise so async rejections (e.g. process executor's
        // saveState racing pool teardown) don't escape as unhandledRejection.
        const result = callback(match) as void | Promise<void>;
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch((e) => {
            console.error('[PgSignalBus] Match callback async error:', e);
          });
        }
      } catch (e) {
        console.error('[PgSignalBus] Match callback error:', e);
      }
    }
  }
}

interface SignalNotification {
  subscriptionId: string
  instanceId: string
  payload: unknown
  branchId?: string
}


/**
 * Create a PostgreSQL-backed signal bus.
 *
 * @example
 * ```typescript
 * const signalBus = await createPgSignalBus({
 *   subscriptionRepo: container.resolve(SignalSubscriptionRepository),
 *   pubsub: container.resolve(PostgresPubSub),
 * })
 *
 * await signalBus.start() // Begin listening for notifications
 * ```
 */
export async function createPgSignalBus(
  options: PgSignalBusOptions,
): Promise<PgSignalBus> {
  const bus = new PgSignalBus(options);
  return bus;
}
