/**
 * @justscale/process - Timer Scheduler
 *
 * Abstraction for scheduling and managing process timers.
 */

// ============================================================================
// Timer Scheduler Interface
// ============================================================================

/**
 * A scheduled timer.
 */
export interface ScheduledTimer {
  /** Unique timer ID */
  id: string
  /** Process instance ID */
  instanceId: string
  /** When the timer expires */
  expiresAt: Date
  /** For races, the branch ID */
  branchId?: string
  /** When the timer was scheduled */
  scheduledAt: Date
}

/**
 * Result when a timer fires.
 */
export interface TimerFired {
  /** Timer that fired */
  timerId: string
  /** Process instance to resume */
  instanceId: string
  /** For races, which branch won */
  branchId?: string
}

/**
 * Abstract timer scheduler for managing process delays.
 *
 * Implementations:
 * - InMemoryTimerScheduler (testing/development - uses setTimeout)
 * - PgTimerScheduler (production - uses pg_cron or polling)
 */
export interface TimerScheduler {
  /**
   * Schedule a timer to fire at a specific time.
   * Returns timer ID for cancellation.
   */
  schedule(instanceId: string, expiresAt: Date, branchId?: string): Promise<string>

  /**
   * Cancel a scheduled timer.
   */
  cancel(timerId: string): Promise<void>

  /**
   * Cancel all timers for a process instance.
   */
  cancelAll(instanceId: string): Promise<void>

  /**
   * Register a callback for when timers fire.
   */
  onFire(callback: (fired: TimerFired) => void): () => void

  /**
   * Receive an externally-fired timer event.
   * Used by scheduled task transport to inject fired timers.
   */
  receiveFire(fired: TimerFired): void

  /**
   * Check for and fire any expired timers.
   * For polling-based implementations.
   */
  checkExpired(now?: Date): Promise<TimerFired[]>

  /**
   * Start the scheduler (begin processing timers).
   */
  start(): void

  /**
   * Stop the scheduler.
   */
  stop(): void
}

// ============================================================================
// In-Memory Implementation
// ============================================================================

/**
 * In-memory timer scheduler using setTimeout.
 *
 * Suitable for testing and single-node development.
 * Not suitable for production - timers lost on restart.
 */
export class InMemoryTimerScheduler implements TimerScheduler {
  // Node's setTimeout silently clamps delays above 2^31 - 1 ms to 1 ms
  // and emits a TimeoutOverflowWarning. Longer durable delays are armed
  // in chunks of this size and re-armed until expiresAt is reached.
  private static readonly TIMEOUT_MAX_MS = 2_147_483_647;

  private timers = new Map<string, ScheduledTimer>();
  private timeoutHandles = new Map<string, NodeJS.Timeout>();
  private fireCallbacks = new Set<(fired: TimerFired) => void>();
  private nextId = 1;
  private running = false;

  private generateId(): string {
    return `timer_${this.nextId++}`;
  }

  async schedule(instanceId: string, expiresAt: Date, branchId?: string): Promise<string> {
    const id = this.generateId();
    const timer: ScheduledTimer = {
      id,
      instanceId,
      expiresAt,
      branchId,
      scheduledAt: new Date(),
    };

    this.timers.set(id, timer);

    if (this.running) {
      this.scheduleTimeout(timer);
    }

    return id;
  }

  async cancel(timerId: string): Promise<void> {
    this.timers.delete(timerId);
    const handle = this.timeoutHandles.get(timerId);
    if (handle) {
      clearTimeout(handle);
      this.timeoutHandles.delete(timerId);
    }
  }

  async cancelAll(instanceId: string): Promise<void> {
    for (const [id, timer] of this.timers) {
      if (timer.instanceId === instanceId) {
        await this.cancel(id);
      }
    }
  }

  onFire(callback: (fired: TimerFired) => void): () => void {
    this.fireCallbacks.add(callback);
    return () => this.fireCallbacks.delete(callback);
  }

  receiveFire(fired: TimerFired): void {
    // Remove the timer if it exists (prevents double-fire)
    this.timers.delete(fired.timerId);
    const handle = this.timeoutHandles.get(fired.timerId);
    if (handle) {
      clearTimeout(handle);
      this.timeoutHandles.delete(fired.timerId);
    }
    this.notifyFire(fired);
  }

  async checkExpired(now: Date = new Date()): Promise<TimerFired[]> {
    const fired: TimerFired[] = [];

    for (const [id, timer] of this.timers) {
      if (timer.expiresAt <= now) {
        const result: TimerFired = {
          timerId: id,
          instanceId: timer.instanceId,
          branchId: timer.branchId,
        };
        fired.push(result);
        this.timers.delete(id);
        this.notifyFire(result);
      }
    }

    return fired;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    // Schedule timeouts for existing timers
    for (const timer of this.timers.values()) {
      this.scheduleTimeout(timer);
    }
  }

  stop(): void {
    this.running = false;
    for (const handle of this.timeoutHandles.values()) {
      clearTimeout(handle);
    }
    this.timeoutHandles.clear();
  }

  private scheduleTimeout(timer: ScheduledTimer): void {
    const fire = (): void => {
      // Cancelled or scheduler stopped - drop silently.
      if (!this.timers.has(timer.id)) return;
      if (!this.running) return;

      const remaining = timer.expiresAt.getTime() - Date.now();
      if (remaining > 0) {
        // Re-arm for the remainder. Node's setTimeout clamps delays above
        // TIMEOUT_MAX_MS to 1ms, so we chunk long waits into multiple
        // iterations of this callback.
        const chunk = Math.min(remaining, InMemoryTimerScheduler.TIMEOUT_MAX_MS);
        const next = setTimeout(fire, chunk);
        this.timeoutHandles.set(timer.id, next);
        return;
      }

      this.timers.delete(timer.id);
      this.timeoutHandles.delete(timer.id);

      const fired: TimerFired = {
        timerId: timer.id,
        instanceId: timer.instanceId,
        branchId: timer.branchId,
      };
      this.notifyFire(fired);
    };

    const total = Math.max(0, timer.expiresAt.getTime() - Date.now());
    const chunk = Math.min(total, InMemoryTimerScheduler.TIMEOUT_MAX_MS);
    const handle = setTimeout(fire, chunk);
    this.timeoutHandles.set(timer.id, handle);
  }

  private notifyFire(fired: TimerFired): void {
    for (const callback of this.fireCallbacks) {
      try {
        callback(fired);
      } catch (e) {
        console.error('[InMemoryTimerScheduler] Fire callback error:', e);
      }
    }
  }

  // === Testing Utilities ===

  /** Clear all timers */
  clear(): void {
    this.stop();
    this.timers.clear();
    this.fireCallbacks.clear();
    this.nextId = 1;
  }

  /** Clear all timers without removing fire callbacks (for test cleanup between tests) */
  clearTimers(): void {
    for (const handle of this.timeoutHandles.values()) {
      clearTimeout(handle);
    }
    this.timeoutHandles.clear();
    this.timers.clear();
  }

  /** Get timer count */
  get timerCount(): number {
    return this.timers.size;
  }

  /** Get pending timer count (alias for timerCount) */
  get pendingCount(): number {
    return this.timers.size;
  }

  /** Advance time and fire expired timers (for testing) */
  async advanceTo(time: Date): Promise<TimerFired[]> {
    return this.checkExpired(time);
  }

  /** Fire the next timer immediately (for testing) */
  fireNext(): void {
    const timer = this.timers.values().next().value;
    if (!timer) return;

    this.timers.delete(timer.id);
    this.timeoutHandles.delete(timer.id);

    const fired: TimerFired = {
      timerId: timer.id,
      instanceId: timer.instanceId,
      branchId: timer.branchId,
    };
    this.notifyFire(fired);
  }

  /** Get all timers (for debugging) */
  getTimers(): ScheduledTimer[] {
    return Array.from(this.timers.values());
  }
}
