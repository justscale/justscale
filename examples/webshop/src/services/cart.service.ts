/**
 * Cart Service
 *
 * Business logic for shopping cart management:
 * - Add/remove/update items
 * - Apply coupons
 * - Calculate totals
 * - Convert to order
 */

import { Logger, defineService } from '@justscale/core';
import { type Persistent, type Ref, ModelRepository, q } from '@justscale/core/models';

import {
  Cart,
  CartItem,
  Coupon,
  Customer,
  Product,
} from '../models/index.js';

// ============================================================================
// Types
// ============================================================================

export interface CartSummary {
  cart: Persistent<Cart>
  items: CartItemWithProduct[]
  subtotal: number
  discount: number
  total: number
  itemCount: number
}

export interface CartItemWithProduct {
  cart: unknown
  quantity: number
  unitPrice: string
  options?: {
    size?: string
    color?: string
    customText?: string
  }
  product: Persistent<Product>
}

export interface AddToCartParams {
  product: Ref<Product>
  quantity: number
  options?: {
    size?: string
    color?: string
    customText?: string
  }
}

// ============================================================================
// Service Definition
// ============================================================================

export class CartService extends defineService({
  inject: {
    carts: ModelRepository.of(Cart),
    cartItems: ModelRepository.of(CartItem),
    products: ModelRepository.of(Product),
    coupons: ModelRepository.of(Coupon),
    logger: Logger,
  },

  factory: ({ carts, cartItems, products, coupons, logger }) => ({
    // ─────────────────────────────────────────────────────────────────────────
    // Cart Management
    // ─────────────────────────────────────────────────────────────────────────

    async getOrCreateCart(
      customerId?: string,
      sessionId?: string,
    ): Promise<Persistent<Cart>> {
      // Find existing active cart
      let cart: Persistent<Cart> | undefined;

      if (customerId) {
        cart = await carts.findOne(
          q.and(
            Cart.fields.customer.eq(customerId),
            Cart.fields.status.eq('active'),
          ),
        );
      } else if (sessionId) {
        cart = await carts.findOne(
          q.and(
            Cart.fields.sessionId.eq(sessionId),
            Cart.fields.status.eq('active'),
          ),
        );
      }

      if (cart) {
        return cart;
      }

      // Create new cart
      logger.info('Creating new cart', { customerId, sessionId });
      return await carts.insert({
        customer: customerId ? Customer.ref`${customerId}` : undefined,
        sessionId,
        status: 'active',
        discountAmount: '0.00',
        expiresAt: sessionId
          ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
          : undefined, // 7 days for guest
      });
    },

    async getCart(cart: Ref<Cart>): Promise<Persistent<Cart> | undefined> {
      return await carts.get(cart);
    },

    async getCartSummary(cart: Ref<Cart>): Promise<CartSummary | null> {
      const found = await carts.get(cart);
      if (!found) return null;

      // Get cart items with product info
      const items = await cartItems.find({
        where: CartItem.fields.cart.eq(cart),
      });

      // Fetch products for each item
      const itemsWithProducts: CartItemWithProduct[] = [];
      let subtotal = 0;

      for (const item of items) {
        const productRef = CartItem.ref(item);
        const product = await products.get(Product.ref(productRef.identifier));
        if (product) {
          const itemWithProduct = {
            ...item,
            product,
          } as CartItemWithProduct;
          itemsWithProducts.push(itemWithProduct);
          subtotal += item.quantity * Number(item.unitPrice);
        }
      }

      const discount = Number(found.discountAmount) || 0;
      const total = Math.max(0, subtotal - discount);

      return {
        cart: found,
        items: itemsWithProducts,
        subtotal,
        discount,
        total,
        itemCount: itemsWithProducts.reduce(
          (sum, item) => sum + item.quantity,
          0,
        ),
      };
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Cart Items
    // ─────────────────────────────────────────────────────────────────────────

    async addToCart(
      cart: Ref<Cart>,
      params: AddToCartParams,
    ): Promise<Persistent<CartItem>> {
      const { product: productRef, quantity, options } = params;

      // Validate product
      const product = await products.get(productRef);
      if (!product) {
        throw new Error('Product not found');
      }

      if (product.status !== 'active') {
        throw new Error('Product is not available');
      }

      // Check inventory
      if (product.trackInventory && product.quantity < quantity) {
        throw new Error('Insufficient inventory for product');
      }

      // Check if item already in cart
      const existingItem = await cartItems.findOne(
        q.and(
          CartItem.fields.cart.eq(cart),
          CartItem.fields.product.eq(productRef),
        ),
      );

      if (existingItem) {
        // Update quantity
        const newQuantity = existingItem.quantity + quantity;
        logger.info('Updating cart item quantity', { newQuantity });
        using lockedItem = await cartItems.lock(existingItem);
        if (!lockedItem) throw new Error('Cart item not found');
        return await cartItems.update(lockedItem, {
          quantity: newQuantity,
        });
      }

      // Add new item
      logger.info('Adding item to cart', { quantity });
      const item = await cartItems.insert({
        cart,
        product: productRef,
        quantity,
        unitPrice: product.price,
        options: options as CartItem['options'],
      });

      // Update cart timestamp
      using lockedCart = await carts.lock(cart);
      if (!lockedCart) throw new Error('Cart not found');
      await carts.update(lockedCart, {}); // Touch to update updatedAt

      return item;
    },

    async updateCartItemQuantity(
      cartItem: Ref<CartItem>,
      quantity: number,
    ): Promise<Persistent<CartItem>> {
      if (quantity <= 0) {
        throw new Error('Quantity must be positive');
      }

      const item = await cartItems.get(cartItem);
      if (!item) {
        throw new Error('Cart item not found');
      }

      // Check inventory
      const product = await products.get(item.product);
      if (product && product.trackInventory && product.quantity < quantity) {
        throw new Error('Insufficient inventory');
      }

      using lockedItem = await cartItems.lock(item);
      if (!lockedItem) throw new Error('Cart item not found');
      return await cartItems.update(lockedItem, {
        quantity,
      });
    },

    async removeFromCart(cartItem: Ref<CartItem>): Promise<boolean> {
      using locked = await cartItems.lock(cartItem);
      if (!locked) return false;

      await cartItems.delete(locked);
      logger.info('Removed item from cart');
      return true;
    },

    async clearCart(cart: Ref<Cart>): Promise<void> {
      await cartItems.deleteWhere(CartItem.fields.cart.eq(cart));
      using locked = await carts.lock(cart);
      if (!locked) throw new Error('Cart not found');
      await carts.update(locked, {
        couponCode: undefined,
        discountAmount: '0.00',
      });
      logger.info('Cart cleared');
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Coupons
    // ─────────────────────────────────────────────────────────────────────────

    async applyCoupon(
      cart: Ref<Cart>,
      couponCode: string,
    ): Promise<{ success: boolean; message: string; discount?: number }> {
      const found = await carts.get(cart);
      if (!found) {
        return { success: false, message: 'Cart not found' };
      }

      // Find coupon
      const coupon = await coupons.findOne(
        Coupon.fields.code.eq(couponCode.toUpperCase()),
      );
      if (!coupon) {
        return { success: false, message: 'Invalid coupon code' };
      }

      // Get cart summary for validation
      const summary = await this.getCartSummary(cart);
      if (!summary) {
        return { success: false, message: 'Cart not found' };
      }

      // Validate coupon
      const couponInstance = new Coupon(coupon);
      if (!couponInstance.isValid(summary.subtotal)) {
        if (!coupon.isActive) {
          return { success: false, message: 'Coupon is no longer active' };
        }
        if (coupon.usageLimit && coupon.usageCount >= coupon.usageLimit) {
          return { success: false, message: 'Coupon usage limit reached' };
        }
        if (
          coupon.minOrderAmount &&
          summary.subtotal < Number(coupon.minOrderAmount)
        ) {
          return {
            success: false,
            message: `Minimum order amount is $${coupon.minOrderAmount}`,
          };
        }
        return { success: false, message: 'Coupon is not valid' };
      }

      // Calculate discount
      const discount = couponInstance.calculateDiscount(summary.subtotal);

      // Apply coupon
      using locked = await carts.lock(cart);
      if (!locked) {
        return { success: false, message: 'Cart not found' };
      }
      await carts.update(locked, {
        couponCode: couponCode.toUpperCase(),
        discountAmount: discount.toFixed(2),
      });

      logger.info('Coupon applied', { couponCode, discount });
      return { success: true, message: 'Coupon applied successfully', discount };
    },

    async removeCoupon(cart: Ref<Cart>): Promise<void> {
      using locked = await carts.lock(cart);
      if (!locked) throw new Error('Cart not found');
      await carts.update(locked, {
        couponCode: undefined,
        discountAmount: '0.00',
      });
      logger.info('Coupon removed');
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Cart Lifecycle
    // ─────────────────────────────────────────────────────────────────────────

    async mergeGuestCartToCustomer(
      sessionId: string,
      customerId: string,
    ): Promise<Persistent<Cart> | null> {
      // Find guest cart
      const guestCart = await carts.findOne(
        q.and(
          Cart.fields.sessionId.eq(sessionId),
          Cart.fields.status.eq('active'),
        ),
      );

      if (!guestCart) return null;

      // Find customer's existing cart
      const customerCart = await carts.findOne(
        q.and(
          Cart.fields.customer.eq(customerId),
          Cart.fields.status.eq('active'),
        ),
      );

      if (customerCart) {
        // Merge guest cart items into customer cart
        const guestItems = await cartItems.find({
          where: CartItem.fields.cart.eq(guestCart),
        });

        for (const item of guestItems) {
          await this.addToCart(customerCart, {
            product: item.product,
            quantity: item.quantity,
            options: item.options,
          });
        }

        // Delete guest cart
        await cartItems.deleteWhere(CartItem.fields.cart.eq(guestCart));
        using lockedGuest = await carts.lock(guestCart);
        if (!lockedGuest) throw new Error('Guest cart not found');
        await carts.delete(lockedGuest);

        return customerCart;
      }
      // Convert guest cart to customer cart
      using lockedGuestCart = await carts.lock(guestCart);
      if (!lockedGuestCart) throw new Error('Guest cart not found');
      await carts.update(lockedGuestCart, {
        customer: Customer.ref`${customerId}`,
        sessionId: undefined,
        expiresAt: undefined,
      });

      return guestCart;
    },

    async markCartAsAbandoned(cart: Ref<Cart>): Promise<void> {
      using locked = await carts.lock(cart);
      if (!locked) throw new Error('Cart not found');
      await carts.update(locked, { status: 'abandoned' });
      logger.info('Cart marked as abandoned');
    },

    async markCartAsConverted(cart: Ref<Cart>): Promise<void> {
      using locked = await carts.lock(cart);
      if (!locked) throw new Error('Cart not found');
      await carts.update(locked, { status: 'converted' });
      logger.info('Cart marked as converted');
    },

    async cleanupExpiredCarts(): Promise<number> {
      const now = new Date();
      const deleted = await carts.deleteWhere(
        q.and(
          Cart.fields.status.eq('active'),
          Cart.fields.expiresAt.lt(now),
        ),
      );
      if (deleted > 0) {
        logger.info('Cleaned up expired carts', { count: deleted });
      }
      return deleted;
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Validation
    // ─────────────────────────────────────────────────────────────────────────

    async validateCartForCheckout(
      cart: Ref<Cart>,
    ): Promise<{ valid: boolean; errors: string[] }> {
      const errors: string[] = [];

      const summary = await this.getCartSummary(cart);
      if (!summary) {
        return { valid: false, errors: ['Cart not found'] };
      }

      if (summary.items.length === 0) {
        errors.push('Cart is empty');
      }

      // Validate each item
      for (const item of summary.items) {
        const product = item.product;

        if (product.status !== 'active') {
          errors.push(`${product.name} is no longer available`);
        }

        if (product.trackInventory && product.quantity < item.quantity) {
          errors.push(`Insufficient inventory for ${product.name}`);
        }

        // Check if price has changed
        if (Number(item.unitPrice) !== Number(product.price)) {
          errors.push(`Price has changed for ${product.name}`);
        }
      }

      return { valid: errors.length === 0, errors };
    },
  }),
}) {}

export type CartServiceType = ReturnType<(typeof CartService)['factory']>;
