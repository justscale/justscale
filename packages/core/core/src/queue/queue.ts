/**
 * Queue — FIFO async iterable primitive.
 *
 * Single-consumer: one `for await` at a time. Items are removed after consumption.
 * Becomes durable inside process handlers via Symbol.process serialization.
 *
 * @example
 * ```typescript
 * const q = createQueue<string>()
 * q.push('hello')
 * q.push('world')
 *
 * for await (const item of q) {
 *   console.log(item)  // 'hello', 'world', then waits for more
 * }
 * ```
 */

/** Ensure Symbol.process is available */
import { registerProcessType } from '../process/serialization.js';

interface QueueWaiter<T> {
  resolve: (value: IteratorResult<T>) => void
}

export class Queue<T> {
  private items: T[] = [];
  private waiter: QueueWaiter<T> | null = null;
  private closed = false;
  private consuming = false;

  constructor(initialItems?: T[]) {
    if (initialItems) {
      this.items = [...initialItems];
    }
  }

  /** Number of unconsumed items in the queue */
  get length(): number {
    return this.items.length;
  }

  /** Push an item to the queue. Notifies any waiting consumer. */
  push(item: T): void {
    if (this.closed) return;

    if (this.waiter) {
      const { resolve } = this.waiter;
      this.waiter = null;
      resolve({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  /** Close the queue — no more items will be pushed, iteration ends after draining. */
  close(): void {
    this.closed = true;
    if (this.waiter) {
      const { resolve } = this.waiter;
      this.waiter = null;
      resolve({ value: undefined as any, done: true });
    }
  }

  /** Single-consumer async iterator — yields items FIFO, waits when empty. */
  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.consuming) {
      throw new Error('Queue is single-consumer. Only one for-await loop at a time.');
    }
    this.consuming = true;

    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.items.length > 0) {
          return Promise.resolve({ value: this.items.shift()!, done: false });
        }

        if (this.closed) {
          this.consuming = false;
          return Promise.resolve({ value: undefined as any, done: true });
        }

        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiter = { resolve };
        });
      },
      return: (): Promise<IteratorResult<T>> => {
        // Cancel any pending waiter — this unblocks the for-await loop
        if (this.waiter) {
          const { resolve } = this.waiter;
          this.waiter = null;
          resolve({ value: undefined as any, done: true });
        }
        this.consuming = false;
        return Promise.resolve({ value: undefined as any, done: true });
      },
    };
  }

  /** Processable protocol — makes Queue durable inside process handlers */
  static {
    const descriptor: ProcessDescriptor<Queue<unknown>> = {
      name: 'Queue',
      serialize(queue: Queue<unknown>): object {
        return { items: [...queue.items] };
      },
      deserialize(data: object): Queue<unknown> {
        return new Queue((data as { items: unknown[] }).items);
      },
    };

    if (typeof Symbol.process !== 'undefined') {
      (Queue as any)[Symbol.process] = descriptor;
    }

    // Register with the process type registry for deserialization
    registerProcessType(descriptor);
  }
}

export function createQueue<T>(initialItems?: T[]): Queue<T> {
  return new Queue<T>(initialItems);
}
