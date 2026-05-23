/**
 * @justscale/process - Signal Bus
 *
 * Abstraction for routing signals between emitters and waiting processes.
 */

// ============================================================================
// Signal Bus Interface
// ============================================================================

/**
 * A signal waiting to be delivered.
 */
export interface PendingSignal {
  /** Signal name (e.g., 'orders.complete') */
  signal: string
  /** Identity values for routing (e.g., { orderId: '123' }) */
  identity: Record<string, string>
  /** Optional payload data */
  payload: unknown
  /** When the signal was emitted */
  emittedAt: Date
}

/**
 * A subscription to wait for signals.
 */
export interface SignalSubscription {
  /** Unique subscription ID */
  id: string
  /** Process instance ID waiting for this signal */
  instanceId: string
  /** Signal name to wait for */
  signal: string
  /** Identity filter (process params) */
  identity: Record<string, string>
  /** When the subscription was created */
  subscribedAt: Date
}

/**
 * Result of a race between multiple signals.
 */
export interface RaceSubscription {
  /** Unique subscription ID */
  id: string
  /** Process instance ID */
  instanceId: string
  /** Branches in the race */
  branches: RaceBranch[]
  /** When the subscription was created */
  subscribedAt: Date
}

export interface RaceBranch {
  /** Branch identifier */
  branchId: string
  /** Signal to wait for (if signal branch) */
  signal?: string
  /** Identity filter (if signal branch) */
  identity?: Record<string, string>
  /** Timer expiration (if timer branch) */
  expiresAt?: Date
}

/**
 * Result when a signal is matched.
 */
export interface SignalMatch {
  /** The subscription that was matched */
  subscriptionId: string
  /** Process instance ID to resume */
  instanceId: string
  /** Signal payload */
  payload: unknown
  /** For races, which branch won */
  branchId?: string
}

/**
 * Signal bus interface for routing signals to processes.
 *
 * Implementations:
 * - InMemorySignalBus (testing/development)
 * - PgSignalBus (production - uses LISTEN/NOTIFY + table storage)
 */
export interface SignalBus {
  // === Emit ===

  /**
   * Emit a signal to be delivered to waiting processes.
   *
   * @returns Number of processes that received the signal
   */
  emit(signal: string, identity: Record<string, string>, payload?: unknown): Promise<number>

  // === Subscribe ===

  /**
   * Subscribe to wait for a single signal.
   * Returns subscription ID for cancellation.
   */
  subscribe(
    instanceId: string,
    signal: string,
    identity: Record<string, string>
  ): Promise<string>

  /**
   * Subscribe to a race between multiple signals/timers.
   * Returns subscription ID for cancellation.
   */
  subscribeRace(instanceId: string, branches: RaceBranch[]): Promise<string>

  /**
   * Cancel a subscription (signal or race).
   */
  unsubscribe(subscriptionId: string): Promise<void>

  // === Polling (for executors without push) ===

  /**
   * Check if a signal subscription has been matched.
   * Returns the match if found, null otherwise.
   */
  checkSignal(subscriptionId: string): Promise<SignalMatch | null>

  /**
   * Check if a race subscription has been resolved.
   * Returns the winning match if found, null otherwise.
   */
  checkRace(subscriptionId: string): Promise<SignalMatch | null>

  // === Callbacks (for push-based executors) ===

  /**
   * Register a callback for when signals are matched.
   * Called when emit() matches a waiting subscription.
   * Async callbacks are awaited before emit() returns.
   */
  onMatch(callback: (match: SignalMatch) => void | Promise<void>): () => void

  // === Query ===

  /**
   * Find subscriptions that would match the given signal and identity.
   * Used for lock acquisition before signal emission.
   */
  findSubscriptions(
    signal: string,
    identity: Record<string, string>
  ): Promise<{ instanceId: string }[]>
}

// ============================================================================
// Abstract DI Token
// ============================================================================

/**
 * Abstract signal bus for DI injection.
 *
 * Use this as the DI token to inject a signal bus implementation:
 * - InMemorySignalBus (default, for single-instance apps)
 * - PgSignalBus (for multi-instance apps using postgres)
 *
 * @example
 * ```typescript
 * // In your feature/cluster setup:
 * .add(bindService(AbstractSignalBus, PgSignalBusService))
 * ```
 */
export abstract class AbstractSignalBus implements SignalBus {
  abstract emit(signal: string, identity: Record<string, string>, payload?: unknown): Promise<number>;
  abstract subscribe(instanceId: string, signal: string, identity: Record<string, string>): Promise<string>;
  abstract subscribeRace(instanceId: string, branches: RaceBranch[]): Promise<string>;
  abstract unsubscribe(subscriptionId: string): Promise<void>;
  abstract checkSignal(subscriptionId: string): Promise<SignalMatch | null>;
  abstract checkRace(subscriptionId: string): Promise<SignalMatch | null>;
  abstract onMatch(callback: (match: SignalMatch) => void | Promise<void>): () => void;
  abstract findSubscriptions(signal: string, identity: Record<string, string>): Promise<{ instanceId: string }[]>;
}

// ============================================================================
// In-Memory Implementation
// ============================================================================

/**
 * In-memory signal bus for testing and development.
 */
export class InMemorySignalBus extends AbstractSignalBus implements SignalBus {
  private subscriptions = new Map<string, SignalSubscription>();
  private races = new Map<string, RaceSubscription>();
  private matches = new Map<string, SignalMatch>();
  private matchCallbacks = new Set<(match: SignalMatch) => void | Promise<void>>();
  private nextId = 1;
  // Track races that are consumed (matched but not yet processed)
  private consumedRaces = new Set<string>();
  // Track instances currently being processed (to queue additional signals)
  private processingInstances = new Set<string>();
  // Queue signals per instance to replay after current processing completes
  private signalQueue = new Map<string, Array<{ signal: string; identity: Record<string, string>; payload: unknown }>>();

  private generateId(): string {
    return `sub_${this.nextId++}`;
  }

  async emit(
    signal: string,
    identity: Record<string, string>,
    payload?: unknown
  ): Promise<number> {
    let matchCount = 0;


    // Snapshot subscriptions before iterating. notifyMatch awaits the match
    // callback which can resume a process that re-subscribes to the same
    // signal - without a snapshot that new subscription is visited in the
    // same emit() pass and receives the SAME payload a second time.
    const subsSnapshot = [...this.subscriptions.entries()];
    for (const [id, sub] of subsSnapshot) {
      if (sub.signal !== signal) continue;
      if (!this.matchesIdentity(sub.identity, identity)) continue;
      // Subscription may have been cancelled during a previous
      // notifyMatch in this same emit - skip it.
      if (!this.subscriptions.has(id)) continue;

      const match: SignalMatch = {
        subscriptionId: id,
        instanceId: sub.instanceId,
        payload,
      };

      this.matches.set(id, match);
      this.subscriptions.delete(id);
      await this.notifyMatch(match);
      matchCount++;
    }

    // Check race subscriptions
    // Snapshot races to avoid iterating over newly added entries during notifyMatch
    const racesSnapshot = [...this.races.entries()];
    for (const [id, race] of racesSnapshot) {
      for (const branch of race.branches) {
        if (!branch.signal) continue;
        if (branch.signal !== signal) continue;
        if (branch.identity && !this.matchesIdentity(branch.identity, identity)) continue;

        const instanceId = race.instanceId;

        // If race is consumed OR instance is processing, queue the signal
        if (this.consumedRaces.has(id) || this.processingInstances.has(instanceId)) {
          const queue = this.signalQueue.get(instanceId) ?? [];
          queue.push({ signal, identity, payload });
          this.signalQueue.set(instanceId, queue);
          // Don't count as matched yet - will be replayed later
          break;
        }

        const match: SignalMatch = {
          subscriptionId: id,
          instanceId,
          payload,
          branchId: branch.branchId,
        };

        this.matches.set(id, match);
        // Mark as consumed AND processing BEFORE calling notifyMatch
        // This ensures other signals for this instance get queued
        this.consumedRaces.add(id);
        this.processingInstances.add(instanceId);
        try {
          await this.notifyMatch(match);
        } finally {
          this.processingInstances.delete(instanceId);
          // Now safe to delete the race
          this.consumedRaces.delete(id);
          this.races.delete(id);
        }

        // After processing, replay any queued signals for this instance
        const queued = this.signalQueue.get(instanceId);
        if (queued && queued.length > 0) {
          this.signalQueue.delete(instanceId);
          for (const q of queued) {
            await this.emit(q.signal, q.identity, q.payload);
          }
        }

        matchCount++;
        break; // Only one branch can win
      }
    }

    return matchCount;
  }

  async subscribe(
    instanceId: string,
    signal: string,
    identity: Record<string, string>
  ): Promise<string> {
    const id = this.generateId();
    this.subscriptions.set(id, {
      id,
      instanceId,
      signal,
      identity,
      subscribedAt: new Date(),
    });
    return id;
  }

  async subscribeRace(instanceId: string, branches: RaceBranch[]): Promise<string> {
    const id = this.generateId();
    this.races.set(id, {
      id,
      instanceId,
      branches,
      subscribedAt: new Date(),
    });
    return id;
  }

  async unsubscribe(subscriptionId: string): Promise<void> {
    this.subscriptions.delete(subscriptionId);
    this.races.delete(subscriptionId);
    this.matches.delete(subscriptionId);
  }

  async checkSignal(subscriptionId: string): Promise<SignalMatch | null> {
    return this.matches.get(subscriptionId) ?? null;
  }

  async checkRace(subscriptionId: string): Promise<SignalMatch | null> {
    return this.matches.get(subscriptionId) ?? null;
  }

  onMatch(callback: (match: SignalMatch) => void | Promise<void>): () => void {
    this.matchCallbacks.add(callback);
    return () => this.matchCallbacks.delete(callback);
  }

  async findSubscriptions(
    signal: string,
    identity: Record<string, string>
  ): Promise<{ instanceId: string }[]> {
    const results: { instanceId: string }[] = [];

    // Check simple subscriptions
    for (const sub of this.subscriptions.values()) {
      if (sub.signal !== signal) continue;
      if (!this.matchesIdentity(sub.identity, identity)) continue;
      results.push({ instanceId: sub.instanceId });
    }

    // Check race subscriptions
    for (const race of this.races.values()) {
      for (const branch of race.branches) {
        if (!branch.signal) continue;
        if (branch.signal !== signal) continue;
        if (branch.identity && !this.matchesIdentity(branch.identity, identity)) continue;
        results.push({ instanceId: race.instanceId });
        break; // Only need to find one matching branch per race
      }
    }

    return results;
  }

  private matchesIdentity(
    subscriptionIdentity: Record<string, string>,
    emitIdentity: Record<string, string>
  ): boolean {
    for (const [key, value] of Object.entries(subscriptionIdentity)) {
      if (emitIdentity[key] !== value) return false;
    }
    return true;
  }

  private async notifyMatch(match: SignalMatch): Promise<void> {
    for (const callback of this.matchCallbacks) {
      try {
        await callback(match);
      } catch (e) {
        console.error('[InMemorySignalBus] Match callback error:', e);
      }
    }
  }

  // === Timer Support ===

  /**
   * Check for expired timers in race subscriptions.
   * Returns matches for any expired timer branches.
   */
  async checkExpiredTimers(now: Date = new Date()): Promise<SignalMatch[]> {
    const expired: SignalMatch[] = [];

    for (const [id, race] of this.races) {
      for (const branch of race.branches) {
        if (!branch.expiresAt) continue;
        if (branch.expiresAt > now) continue;

        const match: SignalMatch = {
          subscriptionId: id,
          instanceId: race.instanceId,
          payload: undefined,
          branchId: branch.branchId,
        };

        this.matches.set(id, match);
        this.races.delete(id);
        await this.notifyMatch(match);
        expired.push(match);
        break; // Only one branch can win
      }
    }

    return expired;
  }

  // === Testing Utilities ===

  /** Clear all state */
  clear(): void {
    this.subscriptions.clear();
    this.races.clear();
    this.matches.clear();
    this.matchCallbacks.clear();
    this.consumedRaces.clear();
    this.processingInstances.clear();
    this.signalQueue.clear();
    this.nextId = 1;
  }

  /** Get subscription count */
  get subscriptionCount(): number {
    return this.subscriptions.size;
  }

  /** Get race subscription count */
  get raceCount(): number {
    return this.races.size;
  }

  /** Get pending match count */
  get matchCount(): number {
    return this.matches.size;
  }
}
