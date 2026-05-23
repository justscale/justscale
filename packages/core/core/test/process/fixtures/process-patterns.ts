/**
 * Process Patterns Examples
 *
 * Demonstrates various patterns for durable processes:
 * - Simple signal awaiting
 * - Race between multiple signals
 * - Race with timeouts
 * - Loops with races
 * - Sequential signal chains
 * - Retry patterns
 * - Approval workflows
 */
import { defineService } from '@justscale/core';
import {
  createProcess,
  AbstractProcessExecutor,
  signal,
  race,
  delay,
} from '@justscale/core/process';

// ============================================================================
// Services with Signals
// ============================================================================

export class OrderService extends defineService({
  inject: { executor: AbstractProcessExecutor },
  factory: ({ executor }) => ({
    // Signals with different payload types
    placed: executor.createSignal<[orderId: string], { items: string[]; total: number }>(
      'order.placed',
      ['orderId']
    ),
    paid: executor.createSignal<[orderId: string], { transactionId: string; amount: number }>(
      'order.paid',
      ['orderId']
    ),
    shipped: executor.createSignal<[orderId: string], { trackingNumber: string; carrier: string }>(
      'order.shipped',
      ['orderId']
    ),
    delivered: executor.createSignal<[orderId: string]>(
      'order.delivered',
      ['orderId']
    ),
    cancelled: executor.createSignal<[orderId: string], { reason: string; refundAmount?: number }>(
      'order.cancelled',
      ['orderId']
    ),
  }),
}) {}

export class ApprovalService extends defineService({
  inject: { executor: AbstractProcessExecutor },
  factory: ({ executor }) => ({
    approved: executor.createSignal<[requestId: string], { approvedBy: string; comments?: string }>(
      'approval.approved',
      ['requestId']
    ),
    rejected: executor.createSignal<[requestId: string], { rejectedBy: string; reason: string }>(
      'approval.rejected',
      ['requestId']
    ),
    escalated: executor.createSignal<[requestId: string], { escalatedTo: string }>(
      'approval.escalated',
      ['requestId']
    ),
  }),
}) {}

export class PaymentService extends defineService({
  inject: { executor: AbstractProcessExecutor },
  factory: ({ executor }) => ({
    received: executor.createSignal<[paymentId: string], { amount: number; method: string }>(
      'payment.received',
      ['paymentId']
    ),
    failed: executor.createSignal<[paymentId: string], { errorCode: string; message: string }>(
      'payment.failed',
      ['paymentId']
    ),
    refunded: executor.createSignal<[paymentId: string], { refundId: string; amount: number }>(
      'payment.refunded',
      ['paymentId']
    ),
  }),
}) {}

// ============================================================================
// Pattern 1: Simple Signal Await
// ============================================================================

/**
 * Wait for a single signal - the simplest pattern.
 * Process suspends until the signal is emitted.
 */
export const simpleAwait = createProcess({
  path: '/order/:orderId/wait-for-payment',
  inject: { orders: OrderService },

  async handler({ orders }, { orderId }) {
    // Simple await - process suspends here
    const payment = await signal(orders.paid);

    return {
      orderId,
      transactionId: payment.transactionId,
      amount: payment.amount,
    };
  },
});

// ============================================================================
// Pattern 2: Sequential Signal Chain
// ============================================================================

/**
 * Wait for signals in sequence - each must happen before the next.
 * Models a workflow with ordered steps.
 */
export const sequentialSignals = createProcess({
  path: '/order/:orderId/fulfillment',
  inject: { orders: OrderService },

  async handler({ orders }, { orderId }) {
    // Wait for payment first
    const payment = await signal(orders.paid);

    // Then wait for shipment
    const shipment = await signal(orders.shipped);

    // Finally wait for delivery
    await signal(orders.delivered);

    return {
      orderId,
      transactionId: payment.transactionId,
      trackingNumber: shipment.trackingNumber,
      carrier: shipment.carrier,
      status: 'delivered',
    };
  },
});

// ============================================================================
// Pattern 3: Race Between Signals (No Timeout)
// ============================================================================

/**
 * Race between multiple signals - first one wins.
 * Useful for approval/rejection workflows.
 */
export const approvalWorkflow = createProcess({
  path: '/approval/:requestId',
  inject: { approvals: ApprovalService },

  async handler({ approvals }, { requestId }) {
    const r = race();

    switch (true) {
      case signal(r, approvals.approved):
        // r is narrowed to { approvedBy: string; comments?: string }
        return {
          status: 'approved',
          approvedBy: r.approvedBy,
          comments: r.comments,
        };

      case signal(r, approvals.rejected):
        // r is narrowed to { rejectedBy: string; reason: string }
        return {
          status: 'rejected',
          rejectedBy: r.rejectedBy,
          reason: r.reason,
        };

      case signal(r, approvals.escalated):
        // r is narrowed to { escalatedTo: string }
        return {
          status: 'escalated',
          escalatedTo: r.escalatedTo,
        };
    }
  },
});

// ============================================================================
// Pattern 4: Race with Timeout
// ============================================================================

/**
 * Race between signal and timeout.
 * Common pattern for time-limited operations.
 */
export const paymentWithTimeout = createProcess({
  path: '/payment/:paymentId/wait',
  inject: { payments: PaymentService },

  async handler({ payments }, { paymentId }) {
    const r = race();

    switch (true) {
      case signal(r, payments.received):
        return {
          status: 'success',
          amount: r.amount,
          method: r.method,
        };

      case signal(r, payments.failed):
        return {
          status: 'failed',
          errorCode: r.errorCode,
          message: r.message,
        };

      case delay.hours(r, 24):
        return {
          status: 'timeout',
          message: 'Payment not received within 24 hours',
        };
    }
  },
});

// ============================================================================
// Pattern 5: Loop with Race (Retry Pattern)
// ============================================================================

/**
 * Retry pattern - loop until success or max attempts.
 * Each iteration races between success, failure, and timeout.
 */
export const retryablePayment = createProcess({
  path: '/payment/:paymentId/retry',
  inject: { payments: PaymentService },

  async handler({ payments }, { paymentId }) {
    const maxAttempts = 3;
    let attempts = 0;

    while (attempts < maxAttempts) {
      attempts++;

      const r = race();

      switch (true) {
        case signal(r, payments.received):
          // Success - exit loop and return
          return {
            status: 'success',
            attempts,
            amount: r.amount,
          };

        case signal(r, payments.failed):
          // Failed - continue to retry if attempts remain
          if (attempts >= maxAttempts) {
            return {
              status: 'failed',
              attempts,
              lastError: r.message,
            };
          }
          // Will continue loop for retry
          continue;

        case delay.minutes(r, 5):
          // Timeout for this attempt - retry
          continue;
      }
    }

    return {
      status: 'exhausted',
      attempts,
    };
  },
});

// ============================================================================
// Pattern 6: Multi-Stage Timeout (Warning then Expire)
// ============================================================================

/**
 * Two-stage timeout - warn first, then expire.
 * Useful for giving users a chance to act before final timeout.
 */
export const stagedTimeout = createProcess({
  path: '/session/:sessionId/monitor',
  inject: { orders: OrderService },

  async handler({ orders }, { sessionId }) {
    // First stage: wait for activity or warning timeout
    const r1 = race();

    switch (true) {
      case signal(r1, orders.placed):
        return { status: 'active', items: r1.items };

      case delay.minutes(r1, 25):
        // Warning stage reached - now wait for activity or final timeout
        break;
    }

    // Second stage: final countdown
    const r2 = race();

    switch (true) {
      case signal(r2, orders.placed):
        return { status: 'recovered', items: r2.items };

      case delay.minutes(r2, 5):
        return { status: 'expired', reason: 'Session timeout after 30 minutes' };
    }
  },
});

// ============================================================================
// Pattern 7: Cancellable Long-Running Process
// ============================================================================

/**
 * Long-running process that can be cancelled at any time.
 * The cancel signal can interrupt at any wait point.
 */
export const cancellableOrder = createProcess({
  path: '/order/:orderId/process',
  inject: { orders: OrderService },

  async handler({ orders }, { orderId }) {
    // Wait for payment or cancellation
    const r1 = race();

    switch (true) {
      case signal(r1, orders.paid):
        // Continue to shipping
        break;

      case signal(r1, orders.cancelled):
        return {
          status: 'cancelled',
          stage: 'payment',
          reason: r1.reason,
          refundAmount: r1.refundAmount,
        };

      case delay.days(r1, 7):
        return { status: 'expired', stage: 'payment' };
    }

    // Wait for shipment or cancellation
    const r2 = race();

    switch (true) {
      case signal(r2, orders.shipped):
        // Continue to delivery
        break;

      case signal(r2, orders.cancelled):
        return {
          status: 'cancelled',
          stage: 'shipping',
          reason: r2.reason,
          refundAmount: r2.refundAmount,
        };
    }

    // Wait for delivery (no cancel after shipped)
    await signal(orders.delivered);

    return { status: 'completed' };
  },
});

// ============================================================================
// Pattern 8: Conditional Signal Waiting
// ============================================================================

/**
 * Different wait logic based on conditions.
 * Shows that normal control flow works around signal waits.
 */
export const conditionalWait = createProcess({
  path: '/order/:orderId/conditional',
  inject: { orders: OrderService, payments: PaymentService },

  async handler({ orders, payments }, { orderId }) {
    // Get order details (would be from a service in real code)
    const isPrepaid = orderId.startsWith('PRE-');

    if (isPrepaid) {
      // Prepaid orders skip payment wait
      const shipment = await signal(orders.shipped);
      return {
        status: 'shipped',
        prepaid: true,
        trackingNumber: shipment.trackingNumber,
      };
    } else {
      // Regular orders wait for payment first
      const payment = await signal(orders.paid);
      const shipment = await signal(orders.shipped);
      return {
        status: 'shipped',
        prepaid: false,
        transactionId: payment.transactionId,
        trackingNumber: shipment.trackingNumber,
      };
    }
  },
});

// ============================================================================
// Pattern 9: Periodic Check with Signal Override
// ============================================================================

/**
 * Periodic polling that can be interrupted by a signal.
 * Useful for status monitoring with manual override.
 */
export const periodicWithOverride = createProcess({
  path: '/monitor/:itemId',
  inject: { orders: OrderService },

  async handler({ orders }, { itemId }) {
    let checkCount = 0;
    const maxChecks = 10;

    while (checkCount < maxChecks) {
      checkCount++;

      const r = race();

      switch (true) {
        case signal(r, orders.delivered):
          // Manual delivery confirmation overrides polling
          return {
            status: 'delivered',
            method: 'signal',
            checkCount,
          };

        case delay.minutes(r, 30):
          // Time for next check - in real code, would call external API here
          // For now, just continue polling
          continue;
      }
    }

    return {
      status: 'polling_exhausted',
      checkCount,
    };
  },
});
