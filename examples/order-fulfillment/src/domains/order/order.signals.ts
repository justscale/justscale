import { defineSignals } from '@justscale/core/process';
import { Order } from './order.model.js';

// The :order path param matches the orderFulfillment process path param,
// so signal subscription identity aligns with process identity.
export class OrderSignals extends defineSignals((signal) => ({
  paymentConfirmed: signal('/order/:order/payment-confirmed').types({ order: Order }),
})) {}
