/**
 * Order Service
 *
 * Business logic for order management:
 * - Checkout flow
 * - Order status workflow
 * - Payment processing
 * - Fulfillment
 */

import { Logger, defineService } from '@justscale/core';
import { type Persistent, type Ref, ModelRepository, q } from '@justscale/core/models';

import {
  Cart,
  Coupon,
  Customer,
  Order,
  OrderItem,
  Product,
} from '../models/index.js';
import { CartService } from './cart.service.js';

// ============================================================================
// Types
// ============================================================================

export interface CheckoutParams {
  cart: Ref<Cart>
  customer: Ref<Customer>
  shippingAddress: Order['shippingAddress']
  billingAddress?: Order['billingAddress']
  shippingMethod?: string
  paymentMethod: string
  customerNotes?: string
}

export interface OrderSearchParams {
  customerId?: string
  status?: Persistent<Order>['status']
  paymentStatus?: Persistent<Order>['paymentStatus']
  fromDate?: Date
  toDate?: Date
  limit?: number
  offset?: number
}

export interface OrderWithItems extends Persistent<Order> {
  items: Persistent<OrderItem>[]
}

// ============================================================================
// Service Definition
// ============================================================================

export class OrderService extends defineService({
  inject: {
    orders: ModelRepository.of(Order),
    orderItems: ModelRepository.of(OrderItem),
    products: ModelRepository.of(Product),
    customers: ModelRepository.of(Customer),
    coupons: ModelRepository.of(Coupon),
    cartService: CartService,
    logger: Logger,
  },

  factory: ({
    orders,
    orderItems,
    products,
    customers,
    coupons,
    cartService,
    logger,
  }) => {
    // Generate unique order number
    const generateOrderNumber = (): string => {
      const timestamp = Date.now().toString(36).toUpperCase();
      const random = Math.random().toString(36).substring(2, 6).toUpperCase();
      return `ORD-${timestamp}-${random}`;
    };

    return {
      // ─────────────────────────────────────────────────────────────────────────
      // Checkout
      // ─────────────────────────────────────────────────────────────────────────

      async checkout(params: CheckoutParams): Promise<Persistent<Order>> {
        const {
          cart,
          customer,
          shippingAddress,
          billingAddress,
          shippingMethod,
          paymentMethod,
          customerNotes,
        } = params;

        logger.info('Starting checkout');

        // Validate cart
        const validation = await cartService.validateCartForCheckout(cart);
        if (!validation.valid) {
          throw new Error(
            `Cart validation failed: ${validation.errors.join(', ')}`,
          );
        }

        // Get cart summary
        const summary = await cartService.getCartSummary(cart);
        if (!summary) {
          throw new Error('Cart not found');
        }

        // Get customer
        const foundCustomer = await customers.get(customer);
        if (!foundCustomer) {
          throw new Error('Customer not found');
        }

        // Calculate totals
        const subtotal = summary.subtotal;
        const discount = summary.discount;
        const shipping = 0; // Would be calculated based on shipping method
        const tax = subtotal * 0.1; // 10% tax for demo
        const total = subtotal - discount + shipping + tax;

        // Create order
        const order = await orders.insert({
          orderNumber: generateOrderNumber(),
          customer,
          status: 'pending',
          paymentStatus: 'pending',
          paymentMethod,
          subtotal: subtotal.toFixed(2),
          discountAmount: discount.toFixed(2),
          shippingAmount: shipping.toFixed(2),
          taxAmount: tax.toFixed(2),
          total: total.toFixed(2),
          currency: 'USD',
          shippingAddress,
          billingAddress: billingAddress ?? shippingAddress,
          shippingMethod,
          couponCode: summary.cart.couponCode,
          customerNotes,
        });

        const orderId = Order.ref(order).identifier;

        // Create order items
        for (const item of summary.items) {
          await orderItems.insert({
            order,
            product: item.product,
            productName: item.product.name,
            productSku: item.product.sku,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            totalPrice: (Number(item.unitPrice) * item.quantity).toFixed(2),
            options: item.options as OrderItem['options'],
          });

          // Decrease inventory
          if (item.product.trackInventory) {
            using lockedProduct = await products.lock(item.product);
            if (!lockedProduct) throw new Error('Product not found');
            await products.update(lockedProduct, {
              quantity: lockedProduct.quantity - item.quantity,
              salesCount: lockedProduct.salesCount + item.quantity,
            });
          }
        }

        // Update coupon usage
        if (summary.cart.couponCode) {
          const coupon = await coupons.findOne(
            Coupon.fields.code.eq(summary.cart.couponCode),
          );
          if (coupon) {
            using lockedCoupon = await coupons.lock(coupon);
            if (!lockedCoupon) throw new Error('Coupon not found');
            await coupons.update(lockedCoupon, {
              usageCount: lockedCoupon.usageCount + 1,
            });
          }
        }

        // Mark cart as converted
        await cartService.markCartAsConverted(cart);

        logger.info('Order created', {
          orderId,
          orderNumber: order.orderNumber,
        });
        return order;
      },

      // ─────────────────────────────────────────────────────────────────────────
      // Order Retrieval
      // ─────────────────────────────────────────────────────────────────────────

      async getOrder(order: Ref<Order>): Promise<Persistent<Order> | undefined> {
        return await orders.get(order);
      },

      async getOrderByNumber(
        orderNumber: string,
      ): Promise<Persistent<Order> | undefined> {
        return await orders.findOne(
          Order.fields.orderNumber.eq(orderNumber),
        );
      },

      async getOrderWithItems(order: Ref<Order>): Promise<OrderWithItems | null> {
        const found = await orders.get(order);
        if (!found) return null;

        const items = await orderItems.find({
          where: OrderItem.fields.order.eq(order),
        });

        return {
          ...found,
          items,
        } as OrderWithItems;
      },

      async getCustomerOrders(
        customer: Ref<Customer>,
        limit = 20,
        offset = 0,
      ): Promise<Persistent<Order>[]> {
        return await orders.find({
          where: Order.fields.customer.eq(customer),
          orderBy: { createdAt: 'desc' },
          limit,
          offset,
        });
      },

      async searchOrders(
        params: OrderSearchParams,
      ): Promise<{ orders: Persistent<Order>[]; total: number }> {
        const conditions: any[] = [];

        if (params.customerId) {
          conditions.push(Order.fields.customer.eq(params.customerId));
        }
        if (params.status) {
          conditions.push(Order.fields.status.eq(params.status));
        }
        if (params.paymentStatus) {
          conditions.push(Order.fields.paymentStatus.eq(params.paymentStatus));
        }
        if (params.fromDate) {
          conditions.push(Order.fields.createdAt.gte(params.fromDate));
        }
        if (params.toDate) {
          conditions.push(Order.fields.createdAt.lte(params.toDate));
        }

        const where = conditions.length > 0 ? q.and(...conditions) : undefined;
        const total = await orders.count(where);

        const orderList = await orders.find({
          where,
          orderBy: { createdAt: 'desc' },
          limit: params.limit ?? 20,
          offset: params.offset ?? 0,
        });

        return { orders: orderList, total };
      },

      // ─────────────────────────────────────────────────────────────────────────
      // Order Status Workflow
      // ─────────────────────────────────────────────────────────────────────────

      async confirmOrder(order: Ref<Order>): Promise<Persistent<Order>> {
        using locked = await orders.lock(order);
        if (!locked) {
          throw new Error('Order not found');
        }

        if (locked.status !== 'pending') {
          throw new Error(
            `Cannot confirm order in status: ${locked.status}`,
          );
        }

        const updated = await orders.update(locked, {
          status: 'confirmed',
          confirmedAt: new Date(),
        });

        logger.info('Order confirmed');
        return updated;
      },

      async processOrder(order: Ref<Order>): Promise<Persistent<Order>> {
        using locked = await orders.lock(order);
        if (!locked) {
          throw new Error('Order not found');
        }

        if (locked.status !== 'confirmed') {
          throw new Error(
            `Cannot process order in status: ${locked.status}`,
          );
        }

        const updated = await orders.update(locked, {
          status: 'processing',
        });

        logger.info('Order processing');
        return updated;
      },

      async shipOrder(
        order: Ref<Order>,
        trackingNumber?: string,
      ): Promise<Persistent<Order>> {
        using locked = await orders.lock(order);
        if (!locked) {
          throw new Error('Order not found');
        }

        if (locked.status !== 'processing') {
          throw new Error(
            `Cannot ship order in status: ${locked.status}`,
          );
        }

        const updated = await orders.update(locked, {
          status: 'shipped',
          trackingNumber,
          shippedAt: new Date(),
        });

        logger.info('Order shipped', { trackingNumber });
        return updated;
      },

      async deliverOrder(order: Ref<Order>): Promise<Persistent<Order>> {
        using locked = await orders.lock(order);
        if (!locked) {
          throw new Error('Order not found');
        }

        if (locked.status !== 'shipped') {
          throw new Error(
            `Cannot deliver order in status: ${locked.status}`,
          );
        }

        const updated = await orders.update(locked, {
          status: 'delivered',
          deliveredAt: new Date(),
        });

        logger.info('Order delivered');
        return updated;
      },

      async cancelOrder(order: Ref<Order>, reason?: string): Promise<Persistent<Order>> {
        using locked = await orders.lock(order);
        if (!locked) {
          throw new Error('Order not found');
        }

        if (!locked.canBeCancelled) {
          throw new Error(
            `Cannot cancel order in status: ${locked.status}`,
          );
        }

        // Restore inventory
        const items = await orderItems.find({
          where: OrderItem.fields.order.eq(order),
        });

        for (const item of items) {
          using lockedProduct = await products.lock(item.product);
          if (lockedProduct && lockedProduct.trackInventory) {
            await products.update(lockedProduct, {
              quantity: lockedProduct.quantity + item.quantity,
              salesCount: Math.max(0, lockedProduct.salesCount - item.quantity),
            });
          }
        }

        const updated = await orders.update(locked, {
          status: 'cancelled',
          cancelledAt: new Date(),
          internalNotes: reason ? `Cancelled: ${reason}` : undefined,
        });

        logger.info('Order cancelled', { reason });
        return updated;
      },

      // ─────────────────────────────────────────────────────────────────────────
      // Payment
      // ─────────────────────────────────────────────────────────────────────────

      async authorizePayment(
        order: Ref<Order>,
        paymentReference: string,
      ): Promise<Persistent<Order>> {
        using locked = await orders.lock(order);
        if (!locked) throw new Error('Order not found');
        const updated = await orders.update(locked, {
          paymentStatus: 'authorized',
          paymentReference,
        });

        logger.info('Payment authorized', { paymentReference });
        return updated;
      },

      async capturePayment(order: Ref<Order>): Promise<Persistent<Order>> {
        using locked = await orders.lock(order);
        if (!locked) {
          throw new Error('Order not found');
        }

        if (locked.paymentStatus !== 'authorized') {
          throw new Error(
            `Cannot capture payment in status: ${locked.paymentStatus}`,
          );
        }

        const updated = await orders.update(locked, {
          paymentStatus: 'captured',
        });

        logger.info('Payment captured');
        return updated;
      },

      async refundOrder(order: Ref<Order>, reason?: string): Promise<Persistent<Order>> {
        using locked = await orders.lock(order);
        if (!locked) {
          throw new Error('Order not found');
        }

        const updated = await orders.update(locked, {
          status: 'refunded',
          paymentStatus: 'refunded',
          internalNotes: reason ? `Refunded: ${reason}` : undefined,
        });

        // Restore inventory
        const items = await orderItems.find({
          where: OrderItem.fields.order.eq(order),
        });

        for (const item of items) {
          using lockedProduct = await products.lock(item.product);
          if (lockedProduct && lockedProduct.trackInventory) {
            await products.update(lockedProduct, {
              quantity: lockedProduct.quantity + item.quantity,
            });
          }
        }

        logger.info('Order refunded', { reason });
        return updated;
      },

      // ─────────────────────────────────────────────────────────────────────────
      // Analytics
      // ─────────────────────────────────────────────────────────────────────────

      async getOrderStats(
        fromDate?: Date,
        toDate?: Date,
      ): Promise<{
        totalOrders: number
        totalRevenue: number
        averageOrderValue: number
        statusCounts: Record<string, number>
      }> {
        const conditions: any[] = [];
        if (fromDate) conditions.push(Order.fields.createdAt.gte(fromDate));
        if (toDate) conditions.push(Order.fields.createdAt.lte(toDate));

        const where = conditions.length > 0 ? q.and(...conditions) : undefined;

        const allOrders = await orders.find({ where });
        const totalOrders = allOrders.length;

        let totalRevenue = 0;
        const statusCounts: Record<string, number> = {};

        for (const order of allOrders) {
          totalRevenue += Number(order.total);
          const status = order.status;
          statusCounts[status] = (statusCounts[status] || 0) + 1;
        }

        return {
          totalOrders,
          totalRevenue,
          averageOrderValue: totalOrders > 0 ? totalRevenue / totalOrders : 0,
          statusCounts,
        };
      },

      async getRecentOrders(limit = 10): Promise<Persistent<Order>[]> {
        return await orders.find({
          orderBy: { createdAt: 'desc' },
          limit,
        });
      },

      async getPendingOrders(): Promise<Persistent<Order>[]> {
        return await orders.find({
          where: q.or(
            Order.fields.status.eq('pending'),
            Order.fields.status.eq('confirmed'),
            Order.fields.status.eq('processing'),
          ),
          orderBy: { createdAt: 'asc' },
        });
      },
    };
  },
}) {}

export type OrderServiceType = ReturnType<(typeof OrderService)['factory']>;
