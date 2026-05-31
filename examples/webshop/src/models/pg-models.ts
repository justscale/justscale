/**
 * PostgreSQL Storage Models
 *
 * Wraps domain models with PostgreSQL-specific storage configuration.
 * Separates domain concerns from storage/database concerns.
 */

import { createPgModel, createPgRepository } from '@justscale/postgres';
import {
  Cart,
  CartItem,
  Category,
  Coupon,
  Customer,
  Order,
  OrderItem,
  Product,
  Review,
  WishlistItem,
} from './index.js';

// ============================================================================
// PostgreSQL Storage Models
// ============================================================================

/**
 * Customer storage configuration
 */
export const PgCustomer = createPgModel(Customer, {
  table: 'customers',
  overrides: {
    email: { unique: true, index: true },
    status: { index: true },
  },
  indexes: [
    { fields: ['status', 'createdAt'], name: 'idx_customers_status_created' },
    {
      fields: ['email'],
      name: 'idx_customers_email_lower',
      expression: 'LOWER(email)',
    },
  ],
});

/**
 * Category storage configuration (self-referencing)
 */
export const PgCategory = createPgModel(Category, {
  table: 'categories',
  overrides: {
    slug: { unique: true, index: true },
  },
  relations: {
    parent: { onDelete: 'SET NULL' },
  },
  indexes: [
    {
      fields: ['parentId', 'displayOrder'],
      name: 'idx_categories_parent_order',
    },
    {
      fields: ['isActive'],
      name: 'idx_categories_active',
      where: 'is_active = true',
    },
  ],
});

/**
 * Product storage configuration
 */
export const PgProduct = createPgModel(Product, {
  table: 'products',
  overrides: {
    slug: { unique: true, index: true },
    sku: { unique: true, index: true },
    status: { index: true },
  },
  relations: {
    category: { onDelete: 'RESTRICT' },
  },
  indexes: [
    { fields: ['status', 'createdAt'], name: 'idx_products_status_created' },
    { fields: ['categoryId'], name: 'idx_products_category' },
    {
      fields: ['isFeatured'],
      name: 'idx_products_featured',
      where: 'is_featured = true',
    },
    { fields: ['tags'], name: 'idx_products_tags', using: 'GIN' },
    {
      fields: ['name', 'description'],
      name: 'idx_products_search',
      using: 'GIN',
      expression:
        "to_tsvector('english', name || ' ' || COALESCE(description, ''))",
    },
  ],
});

/**
 * Cart storage configuration
 */
export const PgCart = createPgModel(Cart, {
  table: 'carts',
  overrides: {
    sessionId: { index: true },
    status: { index: true },
  },
  relations: {
    customer: { onDelete: 'CASCADE' },
  },
  indexes: [
    { fields: ['customerId', 'status'], name: 'idx_carts_customer_status' },
    {
      fields: ['expiresAt'],
      name: 'idx_carts_expires',
      where: 'expires_at IS NOT NULL',
    },
  ],
});

/**
 * CartItem storage configuration
 */
export const PgCartItem = createPgModel(CartItem, {
  table: 'cart_items',
  relations: {
    cart: { onDelete: 'CASCADE' },
    product: { onDelete: 'CASCADE' },
  },
  indexes: [
    {
      fields: ['cartId', 'productId'],
      name: 'idx_cart_items_cart_product',
      unique: true,
    },
  ],
});

/**
 * Order storage configuration
 */
export const PgOrder = createPgModel(Order, {
  table: 'orders',
  overrides: {
    orderNumber: { unique: true, index: true },
    status: { index: true },
    paymentStatus: { index: true },
  },
  relations: {
    customer: { onDelete: 'RESTRICT' },
  },
  indexes: [
    {
      fields: ['customerId', 'createdAt'],
      name: 'idx_orders_customer_created',
    },
    { fields: ['status', 'createdAt'], name: 'idx_orders_status_created' },
    { fields: ['paymentStatus'], name: 'idx_orders_payment_status' },
  ],
});

/**
 * OrderItem storage configuration
 */
export const PgOrderItem = createPgModel(OrderItem, {
  table: 'order_items',
  relations: {
    order: { onDelete: 'CASCADE' },
    product: { onDelete: 'RESTRICT' },
  },
  indexes: [
    { fields: ['orderId'], name: 'idx_order_items_order' },
    { fields: ['productId'], name: 'idx_order_items_product' },
  ],
});

/**
 * Review storage configuration
 */
export const PgReview = createPgModel(Review, {
  table: 'reviews',
  overrides: {
    rating: { index: true },
    status: { index: true },
  },
  relations: {
    product: { onDelete: 'CASCADE' },
    customer: { onDelete: 'CASCADE' },
  },
  indexes: [
    { fields: ['productId', 'status'], name: 'idx_reviews_product_status' },
    { fields: ['customerId'], name: 'idx_reviews_customer' },
    {
      fields: ['productId', 'customerId'],
      name: 'idx_reviews_product_customer',
      unique: true,
    },
  ],
});

/**
 * Coupon storage configuration
 */
export const PgCoupon = createPgModel(Coupon, {
  table: 'coupons',
  overrides: {
    code: { unique: true, index: true },
  },
  indexes: [
    { fields: ['isActive', 'expiresAt'], name: 'idx_coupons_active_expires' },
  ],
});

/**
 * WishlistItem storage configuration
 */
export const PgWishlistItem = createPgModel(WishlistItem, {
  table: 'wishlist_items',
  relations: {
    customer: { onDelete: 'CASCADE' },
    product: { onDelete: 'CASCADE' },
  },
  indexes: [
    {
      fields: ['customerId', 'productId'],
      name: 'idx_wishlist_customer_product',
      unique: true,
    },
    {
      fields: ['customerId', 'priority'],
      name: 'idx_wishlist_customer_priority',
    },
  ],
});

// ============================================================================
// Repository Service Definitions
// ============================================================================

export const CustomerRepository = createPgRepository(PgCustomer);
export const CategoryRepository = createPgRepository(PgCategory);
export const ProductRepository = createPgRepository(PgProduct);
export const CartRepository = createPgRepository(PgCart);
export const CartItemRepository = createPgRepository(PgCartItem);
export const OrderRepository = createPgRepository(PgOrder);
export const OrderItemRepository = createPgRepository(PgOrderItem);
export const ReviewRepository = createPgRepository(PgReview);
export const CouponRepository = createPgRepository(PgCoupon);
export const WishlistItemRepository = createPgRepository(PgWishlistItem);

// ============================================================================
// Re-export domain models for convenience
// ============================================================================

export {
  Customer,
  Category,
  Product,
  Cart,
  CartItem,
  Order,
  OrderItem,
  Review,
  Coupon,
  WishlistItem,
} from './index.js';
