/**
 * Webshop Domain Models
 *
 * Demonstrates comprehensive use of @justscale/core/models:
 * - Various field types (string, int, decimal, boolean, timestamp, enum, array, object)
 * - References (ref for 1:1/N:1, refs for M:N)
 * - Self-referencing models (Category hierarchy)
 * - Nested objects (Address, Preferences)
 * - Computed fields via methods
 */

import { defineModel, field } from '@justscale/core/models';
import { permit } from '@justscale/permission';

// ============================================================================
// Value Objects (nested object shapes)
// ============================================================================

/**
 * Address - used for shipping and billing
 */
export const AddressShape = {
  street: field.string().max(255),
  city: field.string().max(100),
  state: field.string().max(100),
  postalCode: field.string().max(20),
  country: field.string().max(100),
};

/**
 * Customer preferences
 */
export const PreferencesShape = {
  newsletter: field.boolean(),
  currency: field.string().max(3), // USD, EUR, etc.
  language: field.string().max(5), // en-US, de-DE, etc.
};

/**
 * Product specifications
 */
export const ProductSpecsShape = {
  weight: field.decimal(10, 2).optional(),
  dimensions: field
    .object({
      width: field.decimal(10, 2),
      height: field.decimal(10, 2),
      depth: field.decimal(10, 2),
    })
    .optional(),
  color: field.string().optional(),
  material: field.string().optional(),
};

// ============================================================================
// Domain Models
// ============================================================================

/**
 * Customer - registered users who can shop
 */
export class Customer extends defineModel({
  fields: {
    // Basic info
    email: field.string().max(255).unique(),
    passwordHash: field.string().max(255),
    firstName: field.string().max(100),
    lastName: field.string().max(100),

    // Contact
    phone: field.string().max(20).optional(),

    // Status
    status: field
      .enum('CustomerStatus', ['active', 'suspended', 'deleted'] as const)
      .default('active'),
    emailVerified: field.boolean().default(false),

    // Nested objects
    shippingAddress: field.object(AddressShape).optional(),
    billingAddress: field.object(AddressShape).optional(),
    preferences: field.object(PreferencesShape).optional(),

    // Metadata
    lastLoginAt: field.timestamp().optional(),
    loginCount: field.int().default(0),

    // Timestamps
    createdAt: field.createdAt(),
    updatedAt: field.updatedAt(),
  },
}) {
  get fullName(): string {
    return `${this.firstName} ${this.lastName}`;
  }
}

/**
 * Category - hierarchical product categories (self-referencing)
 */
 
export class Category extends defineModel({
  fields: {
    name: field.string().max(100),
    slug: field.string().max(100).unique(),
    description: field.text().optional(),

    // Self-reference for hierarchy
    parent: field.ref((): any => Category).optional(),

    // Display
    imageUrl: field.string().max(500).optional(),
    displayOrder: field.int().default(0),
    isActive: field.boolean().default(true),

    // SEO
    metaTitle: field.string().max(100).optional(),
    metaDescription: field.string().max(255).optional(),

    createdAt: field.createdAt(),
    updatedAt: field.updatedAt(),
  },
}) {}

/**
 * Product - items available for purchase
 */
export class Product extends defineModel({
  fields: {
    // Basic info
    name: field.string().max(255),
    slug: field.string().max(255).unique(),
    description: field.text(),
    shortDescription: field.string().max(500).optional(),

    // Pricing
    price: field.decimal(10, 2),
    compareAtPrice: field.decimal(10, 2).optional(), // Original price for "sale" display
    costPrice: field.decimal(10, 2).optional(), // Cost for margin calculation

    // Inventory
    sku: field.string().max(100).unique(),
    barcode: field.string().max(100).optional(),
    quantity: field.int().default(0),
    lowStockThreshold: field.int().default(5),
    trackInventory: field.boolean().default(true),

    // Status
    status: field
      .enum('ProductStatus', ['draft', 'active', 'archived'] as const)
      .default('draft'),
    isFeatured: field.boolean().default(false),

    // Category
    category: field.ref(Category),

    // Tags and attributes
    tags: field.array(field.string()).optional(),
    specs: field.object(ProductSpecsShape).optional(),

    // Media
    imageUrls: field.array(field.string()).optional(),

    // SEO
    metaTitle: field.string().max(100).optional(),
    metaDescription: field.string().max(255).optional(),

    // Stats
    viewCount: field.int().default(0),
    salesCount: field.int().default(0),
    averageRating: field.decimal(3, 2).optional(),
    reviewCount: field.int().default(0),

    createdAt: field.createdAt(),
    updatedAt: field.updatedAt(),
  },
}) {
  get isInStock(): boolean {
    return !this.trackInventory || this.quantity > 0;
  }

  get isLowStock(): boolean {
    return this.trackInventory && this.quantity <= this.lowStockThreshold;
  }

  get margin(): number | null {
    if (!this.costPrice) return null;
    return Number(this.price) - Number(this.costPrice);
  }

  get marginPercent(): number | null {
    if (!this.costPrice || Number(this.price) === 0) return null;
    return (
      ((Number(this.price) - Number(this.costPrice)) / Number(this.price)) * 100
    );
  }
}

/**
 * Cart - shopping cart for a customer
 */
export class Cart extends defineModel({
  fields: {
    customer: field.ref(Customer).optional(), // null for guest carts
    sessionId: field.string().max(100).optional(), // for guest carts

    // Status
    status: field
      .enum('CartStatus', ['active', 'abandoned', 'converted'] as const)
      .default('active'),

    // Coupon
    couponCode: field.string().max(50).optional(),
    discountAmount: field.decimal(10, 2).default('0.00'),

    // Notes
    notes: field.text().optional(),

    // Expiry for guest carts
    expiresAt: field.timestamp().optional(),

    createdAt: field.createdAt(),
    updatedAt: field.updatedAt(),
  },
  permissions: ({ customer }) => ({
    view: permit(Customer).when(customer),
    checkout: permit(Customer).when(customer),
  }),
}) {}

/**
 * CartItem - line item in a cart
 */
export class CartItem extends defineModel({
  fields: {
    cart: field.ref(Cart),
    product: field.ref(Product),

    quantity: field.int().default(1),

    // Price at time of adding (in case product price changes)
    unitPrice: field.decimal(10, 2),

    // Custom options selected
    options: field
      .object({
        size: field.string().optional(),
        color: field.string().optional(),
        customText: field.string().optional(),
      })
      .optional(),

    createdAt: field.createdAt(),
    updatedAt: field.updatedAt(),
  },
}) {
  get lineTotal(): number {
    return this.quantity * Number(this.unitPrice);
  }
}

/**
 * Order - completed purchase
 */
export class Order extends defineModel({
  fields: {
    // Order number (human readable)
    orderNumber: field.string().max(50).unique(),

    customer: field.ref(Customer),

    // Status workflow
    status: field
      .enum('OrderStatus', [
        'pending',
        'confirmed',
        'processing',
        'shipped',
        'delivered',
        'cancelled',
        'refunded',
      ] as const)
      .default('pending'),

    // Payment
    paymentStatus: field
      .enum('PaymentStatus', [
        'pending',
        'authorized',
        'captured',
        'failed',
        'refunded',
      ] as const)
      .default('pending'),
    paymentMethod: field.string().max(50).optional(),
    paymentReference: field.string().max(255).optional(),

    // Amounts
    subtotal: field.decimal(10, 2),
    discountAmount: field.decimal(10, 2).default('0.00'),
    shippingAmount: field.decimal(10, 2).default('0.00'),
    taxAmount: field.decimal(10, 2).default('0.00'),
    total: field.decimal(10, 2),

    // Currency
    currency: field.string().max(3).default('USD'),

    // Addresses (snapshot at order time)
    shippingAddress: field.object(AddressShape),
    billingAddress: field.object(AddressShape),

    // Shipping
    shippingMethod: field.string().max(100).optional(),
    trackingNumber: field.string().max(100).optional(),
    shippedAt: field.timestamp().optional(),
    deliveredAt: field.timestamp().optional(),

    // Coupon used
    couponCode: field.string().max(50).optional(),

    // Notes
    customerNotes: field.text().optional(),
    internalNotes: field.text().optional(),

    // Timestamps
    confirmedAt: field.timestamp().optional(),
    cancelledAt: field.timestamp().optional(),

    createdAt: field.createdAt(),
    updatedAt: field.updatedAt(),
  },
  permissions: ({ customer }) => ({
    view: permit(Customer).when(customer),
    cancel: permit(Customer).when(customer),
  }),
}) {
  get isEditable(): boolean {
    return this.status === 'pending' || this.status === 'confirmed';
  }

  get canBeCancelled(): boolean {
    return ['pending', 'confirmed', 'processing'].includes(this.status);
  }
}

/**
 * OrderItem - line item in an order (snapshot of product at order time)
 */
export class OrderItem extends defineModel({
  fields: {
    order: field.ref(Order),
    product: field.ref(Product),

    // Snapshot of product info
    productName: field.string().max(255),
    productSku: field.string().max(100),

    quantity: field.int(),
    unitPrice: field.decimal(10, 2),
    totalPrice: field.decimal(10, 2),

    // Options selected
    options: field
      .object({
        size: field.string().optional(),
        color: field.string().optional(),
        customText: field.string().optional(),
      })
      .optional(),

    createdAt: field.createdAt(),
  },
}) {}

/**
 * Review - customer product review
 */
export class Review extends defineModel({
  fields: {
    product: field.ref(Product),
    customer: field.ref(Customer),

    rating: field.int(), // 1-5
    title: field.string().max(255).optional(),
    body: field.text(),

    // Moderation
    status: field
      .enum('ReviewStatus', ['pending', 'approved', 'rejected'] as const)
      .default('pending'),

    // Helpful votes
    helpfulCount: field.int().default(0),
    notHelpfulCount: field.int().default(0),

    // Verified purchase
    isVerifiedPurchase: field.boolean().default(false),

    createdAt: field.createdAt(),
    updatedAt: field.updatedAt(),
  },
  permissions: ({ customer }) => ({
    edit: permit(Customer).when(customer),
    delete: permit(Customer).when(customer),
  }),
}) {}

/**
 * Coupon - discount codes
 */
export class Coupon extends defineModel({
  fields: {
    code: field.string().max(50).unique(),
    description: field.string().max(255).optional(),

    // Discount type
    discountType: field.enum('DiscountType', ['percentage', 'fixed'] as const),
    discountValue: field.decimal(10, 2),

    // Limits
    minOrderAmount: field.decimal(10, 2).optional(),
    maxDiscountAmount: field.decimal(10, 2).optional(),
    usageLimit: field.int().optional(),
    usageCount: field.int().default(0),
    usageLimitPerCustomer: field.int().optional(),

    // Validity
    startsAt: field.timestamp().optional(),
    expiresAt: field.timestamp().optional(),
    isActive: field.boolean().default(true),

    // Restrictions
    applicableCategories: field.array(field.string()).optional(), // Category IDs
    applicableProducts: field.array(field.string()).optional(), // Product IDs

    createdAt: field.createdAt(),
    updatedAt: field.updatedAt(),
  },
}) {
  isValid(orderAmount: number): boolean {
    if (!this.isActive) return false;
    if (this.usageLimit && this.usageCount >= this.usageLimit) return false;
    if (this.minOrderAmount && orderAmount < Number(this.minOrderAmount))
      return false;

    const now = new Date();
    if (this.startsAt && now < this.startsAt) return false;
    if (this.expiresAt && now > this.expiresAt) return false;

    return true;
  }

  calculateDiscount(orderAmount: number): number {
    if (!this.isValid(orderAmount)) return 0;

    let discount: number;
    if (this.discountType === 'percentage') {
      discount = orderAmount * (Number(this.discountValue) / 100);
    } else {
      discount = Number(this.discountValue);
    }

    if (this.maxDiscountAmount) {
      discount = Math.min(discount, Number(this.maxDiscountAmount));
    }

    return Math.min(discount, orderAmount);
  }
}

/**
 * Wishlist - customer product wishlist
 */
export class WishlistItem extends defineModel({
  fields: {
    customer: field.ref(Customer),
    product: field.ref(Product),

    // Priority/notes
    priority: field.int().default(0),
    notes: field.text().optional(),

    // Price tracking
    priceWhenAdded: field.decimal(10, 2),

    createdAt: field.createdAt(),
  },
}) {}

