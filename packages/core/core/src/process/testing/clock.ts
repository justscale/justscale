/**
 * @justscale/process - Test Clock
 *
 * Time travel utilities for testing timer-based process logic.
 *
 * @example
 * ```typescript
 * import { TestClock } from '@justscale/process/testing'
 *
 * const clock = new TestClock(timerScheduler)
 *
 * // Advance time by duration
 * await clock.advance.minutes(5)
 * await clock.advance.hours(1)
 * await clock.advance.days(7)
 *
 * // Advance to specific time
 * await clock.advanceTo(new Date('2025-01-01'))
 *
 * // Fire next timer immediately
 * clock.fireNext()
 *
 * // Get pending timers
 * console.log(clock.pendingTimers)
 * ```
 */

import type { InMemoryTimerScheduler, TimerFired, ScheduledTimer } from '../../runtime/process/timer-scheduler.js';

/**
 * Test clock for controlling time in process tests.
 *
 * Wraps an InMemoryTimerScheduler to provide time travel capabilities.
 */
export class TestClock {
  private _currentTime: Date;

  /**
   * Duration-based time advancement methods.
   */
  readonly advance: {
    /** Advance time by milliseconds */
    ms: (ms: number) => Promise<TimerFired[]>
    /** Advance time by seconds */
    seconds: (n: number) => Promise<TimerFired[]>
    /** Advance time by minutes */
    minutes: (n: number) => Promise<TimerFired[]>
    /** Advance time by hours */
    hours: (n: number) => Promise<TimerFired[]>
    /** Advance time by days */
    days: (n: number) => Promise<TimerFired[]>
  };

  constructor(private scheduler: InMemoryTimerScheduler, startTime?: Date) {
    this._currentTime = startTime ?? new Date();

    // Bind advance methods
    this.advance = {
      ms: (ms) => this.advanceBy(ms),
      seconds: (n) => this.advanceBy(n * 1000),
      minutes: (n) => this.advanceBy(n * 60 * 1000),
      hours: (n) => this.advanceBy(n * 60 * 60 * 1000),
      days: (n) => this.advanceBy(n * 24 * 60 * 60 * 1000),
    };
  }

  /**
   * Get the current simulated time.
   */
  get now(): Date {
    return this._currentTime;
  }

  /**
   * Get all pending timers.
   */
  get pendingTimers(): ScheduledTimer[] {
    return this.scheduler.getTimers();
  }

  /**
   * Get the number of pending timers.
   */
  get pendingCount(): number {
    return this.scheduler.pendingCount;
  }

  /**
   * Get the next timer to fire (if any).
   */
  get nextTimer(): ScheduledTimer | undefined {
    const timers = this.scheduler.getTimers();
    if (timers.length === 0) return undefined;
    return timers.reduce((earliest, timer) =>
      timer.expiresAt < earliest.expiresAt ? timer : earliest
    );
  }

  /**
   * Get time until the next timer fires.
   */
  get timeToNextTimer(): number | undefined {
    const next = this.nextTimer;
    if (!next) return undefined;
    return Math.max(0, next.expiresAt.getTime() - this._currentTime.getTime());
  }

  /**
   * Advance time by a specific amount (in milliseconds).
   * Fires any timers that expire during the advancement.
   */
  async advanceBy(ms: number): Promise<TimerFired[]> {
    const newTime = new Date(this._currentTime.getTime() + ms);
    return this.advanceTo(newTime);
  }

  /**
   * Advance time to a specific point.
   * Fires any timers that expire up to that time.
   */
  async advanceTo(time: Date): Promise<TimerFired[]> {
    if (time < this._currentTime) {
      throw new Error(`Cannot go back in time: ${time} < ${this._currentTime}`);
    }
    this._currentTime = time;
    return this.scheduler.advanceTo(time);
  }

  /**
   * Fire the next pending timer immediately, regardless of its scheduled time.
   * Useful for skipping directly to when a timer fires.
   */
  fireNext(): void {
    this.scheduler.fireNext();
  }

  /**
   * Fire all pending timers immediately.
   */
  fireAll(): void {
    while (this.scheduler.pendingCount > 0) {
      this.scheduler.fireNext();
    }
  }

  /**
   * Advance time to when the next timer fires.
   * Returns the fired timer, or undefined if no timers are pending.
   */
  async advanceToNextTimer(): Promise<TimerFired | undefined> {
    const next = this.nextTimer;
    if (!next) return undefined;

    const fired = await this.advanceTo(next.expiresAt);
    return fired[0];
  }

  /**
   * Advance time to fire exactly n timers.
   * Useful for stepping through timer-based workflows.
   */
  async advanceToFireCount(count: number): Promise<TimerFired[]> {
    const fired: TimerFired[] = [];
    for (let i = 0; i < count && this.pendingCount > 0; i++) {
      const result = await this.advanceToNextTimer();
      if (result) fired.push(result);
    }
    return fired;
  }

  /**
   * Check if any timer will fire within the given duration.
   */
  hasTimerWithin(ms: number): boolean {
    const threshold = new Date(this._currentTime.getTime() + ms);
    return this.pendingTimers.some(t => t.expiresAt <= threshold);
  }

  /**
   * Reset the clock to a specific time without firing timers.
   * Useful for test setup.
   */
  reset(time?: Date): void {
    this._currentTime = time ?? new Date();
  }
}

/**
 * Create a test clock from a timer scheduler.
 */
export function createTestClock(
  scheduler: InMemoryTimerScheduler,
  startTime?: Date
): TestClock {
  return new TestClock(scheduler, startTime);
}
