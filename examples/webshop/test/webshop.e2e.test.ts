/**
 * Webshop E2E Tests
 *
 * Comprehensive tests for the webshop example that exercise:
 * - All domain models with various field types
 * - References (ref, refs, self-referencing)
 * - Nested objects and arrays
 * - Complex queries with has(), combined conditions
 * - Business logic in services
 * - Full checkout flow
 */

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert';
import { InMemoryRepository, getModelFields, q, type FieldDef } from '@justscale/core/models';

import {
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
} from '../src/models/index.js';

// ============================================================================
// Test Repository Setup
// ============================================================================

interface TestRepos {
  customers: InMemoryRepository<Customer>
  categories: InMemoryRepository<Category>
  products: InMemoryRepository<Product>
  carts: InMemoryRepository<Cart>
  cartItems: InMemoryRepository<CartItem>
  orders: InMemoryRepository<Order>
  orderItems: InMemoryRepository<OrderItem>
  reviews: InMemoryRepository<Review>
  coupons: InMemoryRepository<Coupon>
  wishlistItems: InMemoryRepository<WishlistItem>
}

function createTestRepos(): TestRepos {
  const customers = new InMemoryRepository<Customer>();
  const coupons = new InMemoryRepository<Coupon>();

  const getFieldDefsForRef = (fieldDef: FieldDef): Record<string, FieldDef> | undefined => {
    const target = fieldDef.refTarget?.();
    if (target === Customer) return getModelFields(Customer);
    if (target === Category) return getModelFields(Category);
    if (target === Product) return getModelFields(Product);
    if (target === Cart) return getModelFields(Cart);
    if (target === CartItem) return getModelFields(CartItem);
    if (target === Order) return getModelFields(Order);
    if (target === OrderItem) return getModelFields(OrderItem);
    if (target === Review) return getModelFields(Review);
    if (target === Coupon) return getModelFields(Coupon);
    if (target === WishlistItem) return getModelFields(WishlistItem);
    return undefined;
  };

  // repos populated below — resolver captures lazily
  const r: Record<string, InMemoryRepository<any>> = {};

  const resolver = (refId: string, fieldDef: FieldDef) => {
    const target = fieldDef.refTarget?.();
    if (target === Customer) return customers['store'].get(refId) as Record<string, unknown> | undefined;
    if (target === Category) return r.categories?.['store'].get(refId) as Record<string, unknown> | undefined;
    if (target === Product) return r.products?.['store'].get(refId) as Record<string, unknown> | undefined;
    if (target === Cart) return r.carts?.['store'].get(refId) as Record<string, unknown> | undefined;
    if (target === CartItem) return r.cartItems?.['store'].get(refId) as Record<string, unknown> | undefined;
    if (target === Order) return r.orders?.['store'].get(refId) as Record<string, unknown> | undefined;
    if (target === OrderItem) return r.orderItems?.['store'].get(refId) as Record<string, unknown> | undefined;
    if (target === Review) return r.reviews?.['store'].get(refId) as Record<string, unknown> | undefined;
    if (target === Coupon) return coupons['store'].get(refId) as Record<string, unknown> | undefined;
    if (target === WishlistItem) return r.wishlistItems?.['store'].get(refId) as Record<string, unknown> | undefined;
    return undefined;
  };

  r.categories = new InMemoryRepository<Category>({
    fieldDefs: getModelFields(Category),
    relationResolver: resolver,
    getFieldDefsForRef,
  });

  r.products = new InMemoryRepository<Product>({
    fieldDefs: getModelFields(Product),
    relationResolver: resolver,
    getFieldDefsForRef,
  });

  r.carts = new InMemoryRepository<Cart>({
    fieldDefs: getModelFields(Cart),
    relationResolver: resolver,
    getFieldDefsForRef,
  });

  r.cartItems = new InMemoryRepository<CartItem>({
    fieldDefs: getModelFields(CartItem),
    relationResolver: resolver,
    getFieldDefsForRef,
  });

  r.orders = new InMemoryRepository<Order>({
    fieldDefs: getModelFields(Order),
    relationResolver: resolver,
    getFieldDefsForRef,
  });

  r.orderItems = new InMemoryRepository<OrderItem>({
    fieldDefs: getModelFields(OrderItem),
    relationResolver: resolver,
    getFieldDefsForRef,
  });

  r.reviews = new InMemoryRepository<Review>({
    fieldDefs: getModelFields(Review),
    relationResolver: resolver,
    getFieldDefsForRef,
  });

  r.wishlistItems = new InMemoryRepository<WishlistItem>({
    fieldDefs: getModelFields(WishlistItem),
    relationResolver: resolver,
    getFieldDefsForRef,
  });

  return {
    customers,
    categories: r.categories as InMemoryRepository<Category>,
    products: r.products as InMemoryRepository<Product>,
    carts: r.carts as InMemoryRepository<Cart>,
    cartItems: r.cartItems as InMemoryRepository<CartItem>,
    orders: r.orders as InMemoryRepository<Order>,
    orderItems: r.orderItems as InMemoryRepository<OrderItem>,
    reviews: r.reviews as InMemoryRepository<Review>,
    coupons,
    wishlistItems: r.wishlistItems as InMemoryRepository<WishlistItem>,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Webshop E2E Tests', () => {
  let repos: TestRepos;

  beforeEach(() => {
    repos = createTestRepos();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Customer Tests
  // ─────────────────────────────────────────────────────────────────────────

  describe('Customer Management', () => {
    test('should create customer with nested address objects', async () => {
      const customer = await repos.customers.insert({
        email: 'john@example.com',
        passwordHash: 'hashedpassword',
        firstName: 'John',
        lastName: 'Doe',
        phone: '+1234567890',
        status: 'active',
        emailVerified: true,
        shippingAddress: {
          street: '123 Main St',
          city: 'New York',
          state: 'NY',
          postalCode: '10001',
          country: 'USA',
        },
        billingAddress: {
          street: '456 Business Ave',
          city: 'New York',
          state: 'NY',
          postalCode: '10002',
          country: 'USA',
        },
        preferences: {
          newsletter: true,
          currency: 'USD',
          language: 'en-US',
        },
        loginCount: 0,
      });

      assert.ok(customer);
      assert.strictEqual(customer.email, 'john@example.com');
      assert.strictEqual(customer.shippingAddress!.city, 'New York');
      assert.strictEqual(customer.preferences!.currency, 'USD');
    });

    test('should query customers by nested address field', async () => {
      await repos.customers.insert({
        email: 'ny@example.com',
        passwordHash: 'hash',
        firstName: 'New',
        lastName: 'Yorker',
        status: 'active',
        shippingAddress: { street: '1 St', city: 'New York', state: 'NY', postalCode: '10001', country: 'USA' },
      });

      await repos.customers.insert({
        email: 'la@example.com',
        passwordHash: 'hash',
        firstName: 'Los',
        lastName: 'Angeleno',
        status: 'active',
        shippingAddress: { street: '2 St', city: 'Los Angeles', state: 'CA', postalCode: '90001', country: 'USA' },
      });

      const nyCustomers = await repos.customers.find({
        where: Customer.fields.shippingAddress.city.eq('New York'),
      });

      assert.strictEqual(nyCustomers.length, 1);
      assert.strictEqual(nyCustomers[0].firstName, 'New');
    });

    test('should query customers by deeply nested preference', async () => {
      await repos.customers.insert({
        email: 'newsletter@example.com',
        passwordHash: 'hash',
        firstName: 'News',
        lastName: 'Letter',
        status: 'active',
        preferences: { newsletter: true, currency: 'USD', language: 'en-US' },
      });

      await repos.customers.insert({
        email: 'nonews@example.com',
        passwordHash: 'hash',
        firstName: 'No',
        lastName: 'News',
        status: 'active',
        preferences: { newsletter: false, currency: 'USD', language: 'en-US' },
      });

      const subscribers = await repos.customers.find({
        where: Customer.fields.preferences.newsletter.eq(true),
      });

      assert.strictEqual(subscribers.length, 1);
      assert.strictEqual(subscribers[0].email, 'newsletter@example.com');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Category Hierarchy Tests (Self-Referencing)
  // ─────────────────────────────────────────────────────────────────────────

  describe('Category Hierarchy', () => {
    test('should create category hierarchy', async () => {
      const electronics = await repos.categories.insert({
        name: 'Electronics',
        slug: 'electronics',
        description: 'Electronic devices',
        displayOrder: 1,
        isActive: true,
      });

      const phones = await repos.categories.insert({
        name: 'Phones',
        slug: 'phones',
        description: 'Mobile phones',
        parent: electronics,
        displayOrder: 1,
        isActive: true,
      });

      const smartphones = await repos.categories.insert({
        name: 'Smartphones',
        slug: 'smartphones',
        description: 'Smart mobile phones',
        parent: phones,
        displayOrder: 1,
        isActive: true,
      });

      assert.ok(electronics);
      assert.ok(phones.parent);
      assert.ok(smartphones.parent);
    });

    test('should query categories by parent using has()', async () => {
      const electronics = await repos.categories.insert({
        name: 'Electronics',
        slug: 'electronics',
        isActive: true,
      });

      const clothing = await repos.categories.insert({
        name: 'Clothing',
        slug: 'clothing',
        isActive: true,
      });

      await repos.categories.insert({
        name: 'Phones',
        slug: 'phones',
        parent: electronics,
        isActive: true,
      });

      await repos.categories.insert({
        name: 'Laptops',
        slug: 'laptops',
        parent: electronics,
        isActive: true,
      });

      await repos.categories.insert({
        name: 'Shirts',
        slug: 'shirts',
        parent: clothing,
        isActive: true,
      });

      // Find subcategories of Electronics
      const electronicsSubcats = await repos.categories.find({
        where: Category.fields.parent.has(Category.fields.slug.eq('electronics')),
      });

      assert.strictEqual(electronicsSubcats.length, 2);
      assert.ok(electronicsSubcats.some(c => c.slug === 'phones'));
      assert.ok(electronicsSubcats.some(c => c.slug === 'laptops'));
    });

    test('should query 3-level deep category hierarchy', async () => {
      const root = await repos.categories.insert({ name: 'Root', slug: 'root', isActive: true });
      const level1 = await repos.categories.insert({ name: 'Level1', slug: 'level1', parent: root, isActive: true });
      const level2 = await repos.categories.insert({ name: 'Level2', slug: 'level2', parent: level1, isActive: true });
      await repos.categories.insert({ name: 'Level3', slug: 'level3', parent: level2, isActive: true });

      // Find categories whose grandparent is 'root'
      const level3Cats = await repos.categories.find({
        where: Category.fields.parent.has(
          Category.fields.parent.has(
            Category.fields.slug.eq('root')
          )
        ),
      });

      assert.strictEqual(level3Cats.length, 1);
      assert.strictEqual(level3Cats[0].slug, 'level2');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Product Tests
  // ─────────────────────────────────────────────────────────────────────────

  describe('Product Management', () => {
    test('should create product with nested specs and array tags', async () => {
      const category = await repos.categories.insert({
        name: 'Electronics',
        slug: 'electronics',
        isActive: true,
      });

      const product = await repos.products.insert({
        name: 'iPhone 15 Pro',
        slug: 'iphone-15-pro',
        description: 'Latest iPhone',
        price: '999.99',
        sku: 'IPHONE15PRO',
        quantity: 100,
        status: 'active',
        isFeatured: true,
        category,
        tags: ['phone', 'apple', 'premium', '5g'],
        specs: {
          weight: '187',
          dimensions: { width: '70.6', height: '146.6', depth: '8.25' },
          color: 'Natural Titanium',
          material: 'Titanium',
        },
        imageUrls: ['https://example.com/iphone1.jpg', 'https://example.com/iphone2.jpg'],
      });

      assert.ok(product);
      assert.strictEqual(product.name, 'iPhone 15 Pro');
      assert.strictEqual(product.tags!.length, 4);
      assert.strictEqual(product.specs!.color, 'Natural Titanium');
      assert.strictEqual(product.specs!.dimensions!.width, '70.6');
    });

    test('should query products by array tags using contains', async () => {
      const category = await repos.categories.insert({ name: 'Cat', slug: 'cat', isActive: true });

      await repos.products.insert({
        name: 'Product A',
        slug: 'product-a',
        description: 'A',
        price: '10.00',
        sku: 'SKU-A',
        status: 'active',
        category,
        tags: ['sale', 'new'],
      });

      await repos.products.insert({
        name: 'Product B',
        slug: 'product-b',
        description: 'B',
        price: '20.00',
        sku: 'SKU-B',
        status: 'active',
        category,
        tags: ['premium'],
      });

      await repos.products.insert({
        name: 'Product C',
        slug: 'product-c',
        description: 'C',
        price: '30.00',
        sku: 'SKU-C',
        status: 'active',
        category,
        tags: ['sale', 'clearance'],
      });

      const saleProducts = await repos.products.find({
        where: Product.fields.tags.contains('sale'),
      });

      assert.strictEqual(saleProducts.length, 2);
      assert.ok(saleProducts.some(p => p.name === 'Product A'));
      assert.ok(saleProducts.some(p => p.name === 'Product C'));
    });

    test('should query products by nested specs', async () => {
      const category = await repos.categories.insert({ name: 'Cat', slug: 'cat', isActive: true });

      await repos.products.insert({
        name: 'Red Phone',
        slug: 'red-phone',
        description: 'Red',
        price: '500.00',
        sku: 'RED',
        status: 'active',
        category,
        specs: { color: 'Red', material: 'Plastic', weight: undefined, dimensions: undefined },
      });

      await repos.products.insert({
        name: 'Blue Phone',
        slug: 'blue-phone',
        description: 'Blue',
        price: '500.00',
        sku: 'BLUE',
        status: 'active',
        category,
        specs: { color: 'Blue', material: 'Metal', weight: undefined, dimensions: undefined },
      });

      const redProducts = await repos.products.find({
        where: Product.fields.specs.color.eq('Red'),
      });

      assert.strictEqual(redProducts.length, 1);
      assert.strictEqual(redProducts[0].name, 'Red Phone');
    });

    test('should query products by category using has()', async () => {
      const electronics = await repos.categories.insert({ name: 'Electronics', slug: 'electronics', isActive: true });
      const clothing = await repos.categories.insert({ name: 'Clothing', slug: 'clothing', isActive: true });

      await repos.products.insert({
        name: 'Phone',
        slug: 'phone',
        description: 'Phone',
        price: '500.00',
        sku: 'PHONE',
        status: 'active',
        category: electronics,
      });

      await repos.products.insert({
        name: 'T-Shirt',
        slug: 'tshirt',
        description: 'Shirt',
        price: '20.00',
        sku: 'SHIRT',
        status: 'active',
        category: clothing,
      });

      const electronicsProducts = await repos.products.find({
        where: Product.fields.category.has(Category.fields.slug.eq('electronics')),
      });

      assert.strictEqual(electronicsProducts.length, 1);
      assert.strictEqual(electronicsProducts[0].name, 'Phone');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Cart & Checkout Flow
  // ─────────────────────────────────────────────────────────────────────────

  describe('Cart & Checkout Flow', () => {
    test('should add items to cart and calculate totals', async () => {
      const customer = await repos.customers.insert({
        email: 'shopper@example.com',
        passwordHash: 'hash',
        firstName: 'Shopper',
        lastName: 'Test',
        status: 'active',
      });

      const category = await repos.categories.insert({ name: 'Cat', slug: 'cat', isActive: true });

      const product1 = await repos.products.insert({
        name: 'Product 1',
        slug: 'product-1',
        description: 'P1',
        price: '25.00',
        sku: 'P1',
        status: 'active',
        quantity: 100,
        category,
      });

      const product2 = await repos.products.insert({
        name: 'Product 2',
        slug: 'product-2',
        description: 'P2',
        price: '50.00',
        sku: 'P2',
        status: 'active',
        quantity: 100,
        category,
      });

      const cart = await repos.carts.insert({
        customer,
        status: 'active',
        discountAmount: '0.00',
      });

      await repos.cartItems.insert({
        cart,
        product: product1,
        quantity: 2,
        unitPrice: '25.00',
      });

      await repos.cartItems.insert({
        cart,
        product: product2,
        quantity: 1,
        unitPrice: '50.00',
      });

      // Get cart items
      const items = await repos.cartItems.find({
        where: CartItem.fields.cart.eq(cart),
      });

      assert.strictEqual(items.length, 2);

      // Calculate total
      let total = 0;
      for (const item of items) {
        total += item.quantity * Number(item.unitPrice);
      }
      assert.strictEqual(total, 100); // 2*25 + 1*50
    });

    test('should query cart items by product category using nested has()', async () => {
      const customer = await repos.customers.insert({
        email: 'test@example.com',
        passwordHash: 'hash',
        firstName: 'Test',
        lastName: 'User',
        status: 'active',
      });

      const electronics = await repos.categories.insert({ name: 'Electronics', slug: 'electronics', isActive: true });
      const clothing = await repos.categories.insert({ name: 'Clothing', slug: 'clothing', isActive: true });

      const phone = await repos.products.insert({
        name: 'Phone',
        slug: 'phone',
        description: 'Phone',
        price: '500.00',
        sku: 'PHONE',
        status: 'active',
        category: electronics,
      });

      const shirt = await repos.products.insert({
        name: 'Shirt',
        slug: 'shirt',
        description: 'Shirt',
        price: '30.00',
        sku: 'SHIRT',
        status: 'active',
        category: clothing,
      });

      const cart = await repos.carts.insert({
        customer,
        status: 'active',
        discountAmount: '0.00',
      });

      await repos.cartItems.insert({ cart, product: phone, quantity: 1, unitPrice: '500.00' });
      await repos.cartItems.insert({ cart, product: shirt, quantity: 2, unitPrice: '30.00' });

      // Find cart items where product is in Electronics category
      const electronicsItems = await repos.cartItems.find({
        where: CartItem.fields.product.has(
          Product.fields.category.has(
            Category.fields.slug.eq('electronics')
          )
        ),
      });

      assert.strictEqual(electronicsItems.length, 1);
      assert.strictEqual(electronicsItems[0].quantity, 1);
    });

    test('should create order from cart', async () => {
      const customer = await repos.customers.insert({
        email: 'buyer@example.com',
        passwordHash: 'hash',
        firstName: 'Buyer',
        lastName: 'Test',
        status: 'active',
        shippingAddress: { street: '1 St', city: 'NYC', state: 'NY', postalCode: '10001', country: 'USA' },
      });

      const category = await repos.categories.insert({ name: 'Cat', slug: 'cat', isActive: true });

      const product = await repos.products.insert({
        name: 'Product',
        slug: 'product',
        description: 'Desc',
        price: '100.00',
        sku: 'PROD',
        status: 'active',
        quantity: 50,
        category,
      });

      // Create order
      const order = await repos.orders.insert({
        orderNumber: 'ORD-001',
        customer,
        status: 'pending',
        paymentStatus: 'pending',
        subtotal: '100.00',
        discountAmount: '0.00',
        shippingAmount: '10.00',
        taxAmount: '10.00',
        total: '120.00',
        currency: 'USD',
        shippingAddress: { street: '1 St', city: 'NYC', state: 'NY', postalCode: '10001', country: 'USA' },
        billingAddress: { street: '1 St', city: 'NYC', state: 'NY', postalCode: '10001', country: 'USA' },
      });

      // Create order item
      await repos.orderItems.insert({
        order,
        product,
        productName: 'Product',
        productSku: 'PROD',
        quantity: 1,
        unitPrice: '100.00',
        totalPrice: '100.00',
      });

      // Verify order
      const savedOrder = await repos.orders.findOne(Order.fields.orderNumber.eq('ORD-001'));
      assert.ok(savedOrder);
      assert.strictEqual(savedOrder.total, '120.00');

      // Verify order items
      const orderItems = await repos.orderItems.find({
        where: OrderItem.fields.order.eq(order),
      });
      assert.strictEqual(orderItems.length, 1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Order Queries
  // ─────────────────────────────────────────────────────────────────────────

  describe('Order Queries', () => {
    test('should find orders by customer using has()', async () => {
      const vipCustomer = await repos.customers.insert({
        email: 'vip@example.com',
        passwordHash: 'hash',
        firstName: 'VIP',
        lastName: 'Customer',
        status: 'active',
      });

      const regularCustomer = await repos.customers.insert({
        email: 'regular@example.com',
        passwordHash: 'hash',
        firstName: 'Regular',
        lastName: 'Customer',
        status: 'active',
      });

      await repos.orders.insert({
        orderNumber: 'VIP-001',
        customer: vipCustomer,
        status: 'delivered',
        paymentStatus: 'captured',
        subtotal: '1000.00',
        total: '1000.00',
        currency: 'USD',
        shippingAddress: { street: '1 St', city: 'NYC', state: 'NY', postalCode: '10001', country: 'USA' },
        billingAddress: { street: '1 St', city: 'NYC', state: 'NY', postalCode: '10001', country: 'USA' },
      });

      await repos.orders.insert({
        orderNumber: 'REG-001',
        customer: regularCustomer,
        status: 'pending',
        paymentStatus: 'pending',
        subtotal: '50.00',
        total: '50.00',
        currency: 'USD',
        shippingAddress: { street: '2 St', city: 'LA', state: 'CA', postalCode: '90001', country: 'USA' },
        billingAddress: { street: '2 St', city: 'LA', state: 'CA', postalCode: '90001', country: 'USA' },
      });

      // Find orders from VIP customers (firstName = 'VIP')
      const vipOrders = await repos.orders.find({
        where: Order.fields.customer.has(Customer.fields.firstName.eq('VIP')),
      });

      assert.strictEqual(vipOrders.length, 1);
      assert.strictEqual(vipOrders[0].orderNumber, 'VIP-001');
    });

    test('should find orders by shipping address city', async () => {
      const customer = await repos.customers.insert({
        email: 'test@example.com',
        passwordHash: 'hash',
        firstName: 'Test',
        lastName: 'User',
        status: 'active',
      });

      await repos.orders.insert({
        orderNumber: 'NYC-001',
        customer,
        status: 'pending',
        paymentStatus: 'pending',
        subtotal: '100.00',
        total: '100.00',
        currency: 'USD',
        shippingAddress: { street: '1 St', city: 'New York', state: 'NY', postalCode: '10001', country: 'USA' },
        billingAddress: { street: '1 St', city: 'New York', state: 'NY', postalCode: '10001', country: 'USA' },
      });

      await repos.orders.insert({
        orderNumber: 'LA-001',
        customer,
        status: 'pending',
        paymentStatus: 'pending',
        subtotal: '100.00',
        total: '100.00',
        currency: 'USD',
        shippingAddress: { street: '2 St', city: 'Los Angeles', state: 'CA', postalCode: '90001', country: 'USA' },
        billingAddress: { street: '2 St', city: 'Los Angeles', state: 'CA', postalCode: '90001', country: 'USA' },
      });

      const nycOrders = await repos.orders.find({
        where: Order.fields.shippingAddress.city.eq('New York'),
      });

      assert.strictEqual(nycOrders.length, 1);
      assert.strictEqual(nycOrders[0].orderNumber, 'NYC-001');
    });

    test('should find order items by product category (3-level has)', async () => {
      const customer = await repos.customers.insert({
        email: 'test@example.com',
        passwordHash: 'hash',
        firstName: 'Test',
        lastName: 'User',
        status: 'active',
      });

      const electronics = await repos.categories.insert({ name: 'Electronics', slug: 'electronics', isActive: true });
      const clothing = await repos.categories.insert({ name: 'Clothing', slug: 'clothing', isActive: true });

      const phone = await repos.products.insert({
        name: 'Phone',
        slug: 'phone',
        description: 'Phone',
        price: '500.00',
        sku: 'PHONE',
        status: 'active',
        category: electronics,
      });

      const shirt = await repos.products.insert({
        name: 'Shirt',
        slug: 'shirt',
        description: 'Shirt',
        price: '30.00',
        sku: 'SHIRT',
        status: 'active',
        category: clothing,
      });

      const order = await repos.orders.insert({
        orderNumber: 'ORD-001',
        customer,
        status: 'pending',
        paymentStatus: 'pending',
        subtotal: '530.00',
        total: '530.00',
        currency: 'USD',
        shippingAddress: { street: '1 St', city: 'NYC', state: 'NY', postalCode: '10001', country: 'USA' },
        billingAddress: { street: '1 St', city: 'NYC', state: 'NY', postalCode: '10001', country: 'USA' },
      });

      await repos.orderItems.insert({ order, product: phone, productName: 'Phone', productSku: 'PHONE', quantity: 1, unitPrice: '500.00', totalPrice: '500.00' });
      await repos.orderItems.insert({ order, product: shirt, productName: 'Shirt', productSku: 'SHIRT', quantity: 1, unitPrice: '30.00', totalPrice: '30.00' });

      // Find order items where product is in Electronics
      const electronicsItems = await repos.orderItems.find({
        where: OrderItem.fields.product.has(
          Product.fields.category.has(
            Category.fields.slug.eq('electronics')
          )
        ),
      });

      assert.strictEqual(electronicsItems.length, 1);
      assert.strictEqual(electronicsItems[0].productName, 'Phone');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Reviews
  // ─────────────────────────────────────────────────────────────────────────

  describe('Reviews', () => {
    test('should find reviews by product category', async () => {
      const customer = await repos.customers.insert({
        email: 'reviewer@example.com',
        passwordHash: 'hash',
        firstName: 'Reviewer',
        lastName: 'Test',
        status: 'active',
      });

      const electronics = await repos.categories.insert({ name: 'Electronics', slug: 'electronics', isActive: true });

      const phone = await repos.products.insert({
        name: 'Phone',
        slug: 'phone',
        description: 'Phone',
        price: '500.00',
        sku: 'PHONE',
        status: 'active',
        category: electronics,
      });

      await repos.reviews.insert({
        product: phone,
        customer,
        rating: 5,
        title: 'Great phone!',
        body: 'Absolutely love it.',
        status: 'approved',
        isVerifiedPurchase: true,
      });

      // Find reviews for electronics products
      const electronicsReviews = await repos.reviews.find({
        where: Review.fields.product.has(
          Product.fields.category.has(
            Category.fields.slug.eq('electronics')
          )
        ),
      });

      assert.strictEqual(electronicsReviews.length, 1);
      assert.strictEqual(electronicsReviews[0].rating, 5);
    });

    test('should find reviews by customer status', async () => {
      const activeCustomer = await repos.customers.insert({
        email: 'active@example.com',
        passwordHash: 'hash',
        firstName: 'Active',
        lastName: 'Customer',
        status: 'active',
      });

      const suspendedCustomer = await repos.customers.insert({
        email: 'suspended@example.com',
        passwordHash: 'hash',
        firstName: 'Suspended',
        lastName: 'Customer',
        status: 'suspended',
      });

      const category = await repos.categories.insert({ name: 'Cat', slug: 'cat', isActive: true });
      const product = await repos.products.insert({
        name: 'Product',
        slug: 'product',
        description: 'Desc',
        price: '10.00',
        sku: 'PROD',
        status: 'active',
        category,
      });

      await repos.reviews.insert({
        product,
        customer: activeCustomer,
        rating: 5,
        body: 'Good',
        status: 'approved',
      });

      await repos.reviews.insert({
        product,
        customer: suspendedCustomer,
        rating: 1,
        body: 'Bad',
        status: 'approved',
      });

      // Find reviews from active customers
      const activeReviews = await repos.reviews.find({
        where: Review.fields.customer.has(Customer.fields.status.eq('active')),
      });

      assert.strictEqual(activeReviews.length, 1);
      assert.strictEqual(activeReviews[0].rating, 5);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Coupons
  // ─────────────────────────────────────────────────────────────────────────

  describe('Coupons', () => {
    test('should create and query coupons with array restrictions', async () => {
      await repos.coupons.insert({
        code: 'ELECTRONICS10',
        description: '10% off electronics',
        discountType: 'percentage',
        discountValue: '10.00',
        isActive: true,
        applicableCategories: ['electronics', 'phones'],
      });

      await repos.coupons.insert({
        code: 'SAVE20',
        description: '$20 off any order',
        discountType: 'fixed',
        discountValue: '20.00',
        minOrderAmount: '100.00',
        isActive: true,
      });

      // Find coupons applicable to electronics
      const electronicsCoupons = await repos.coupons.find({
        where: Coupon.fields.applicableCategories.contains('electronics'),
      });

      assert.strictEqual(electronicsCoupons.length, 1);
      assert.strictEqual(electronicsCoupons[0].code, 'ELECTRONICS10');
    });

    test('should validate coupon with model method', async () => {
      const couponData = await repos.coupons.insert({
        code: 'MIN50',
        description: 'Test coupon',
        discountType: 'percentage',
        discountValue: '10.00',
        minOrderAmount: '50.00',
        maxDiscountAmount: '20.00',
        isActive: true,
      });

      const coupon = new Coupon(couponData);

      // Test validation
      assert.strictEqual(coupon.isValid(30), false); // Below minimum
      assert.strictEqual(coupon.isValid(100), true); // Above minimum

      // Test discount calculation
      assert.strictEqual(coupon.calculateDiscount(100), 10); // 10% of 100
      assert.strictEqual(coupon.calculateDiscount(300), 20); // Capped at max
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Wishlist
  // ─────────────────────────────────────────────────────────────────────────

  describe('Wishlist', () => {
    test('should track wishlist items with price history', async () => {
      const customer = await repos.customers.insert({
        email: 'wisher@example.com',
        passwordHash: 'hash',
        firstName: 'Wisher',
        lastName: 'Test',
        status: 'active',
      });

      const category = await repos.categories.insert({ name: 'Cat', slug: 'cat', isActive: true });

      const product = await repos.products.insert({
        name: 'Expensive Product',
        slug: 'expensive',
        description: 'Desc',
        price: '500.00',
        sku: 'EXP',
        status: 'active',
        category,
      });

      await repos.wishlistItems.insert({
        customer,
        product,
        priority: 1,
        priceWhenAdded: '500.00',
        notes: 'Waiting for sale',
      });

      // Update product price
      using locked = await repos.products.lock(Product.ref(product));
      assert.ok(locked, 'Product should be lockable');
      await repos.products.update(locked, { price: '400.00' });

      // Find wishlist items where price dropped
      const wishlistItems = await repos.wishlistItems.find({
        where: WishlistItem.fields.customer.eq(customer),
      });

      assert.strictEqual(wishlistItems.length, 1);
      assert.strictEqual(wishlistItems[0].priceWhenAdded, '500.00');

      // Get current product price
      const currentProduct = await repos.products.get(Product.ref(product));
      assert.ok(currentProduct);
      assert.strictEqual(currentProduct.price, '400.00');

      // Price dropped!
      const savedPrice = Number(wishlistItems[0].priceWhenAdded) - Number(currentProduct.price);
      assert.strictEqual(savedPrice, 100);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Complex Combined Queries
  // ─────────────────────────────────────────────────────────────────────────

  describe('Complex Combined Queries', () => {
    test('should combine multiple has() with local conditions', async () => {
      const vipCustomer = await repos.customers.insert({
        email: 'vip@example.com',
        passwordHash: 'hash',
        firstName: 'VIP',
        lastName: 'User',
        status: 'active',
        preferences: { newsletter: true, currency: 'USD', language: 'en-US' },
      });

      const regularCustomer = await repos.customers.insert({
        email: 'regular@example.com',
        passwordHash: 'hash',
        firstName: 'Regular',
        lastName: 'User',
        status: 'active',
        preferences: { newsletter: false, currency: 'USD', language: 'en-US' },
      });

      await repos.orders.insert({
        orderNumber: 'VIP-BIG',
        customer: vipCustomer,
        status: 'delivered',
        paymentStatus: 'captured',
        subtotal: '1000.00',
        total: '1000.00',
        currency: 'USD',
        shippingAddress: { street: '1 St', city: 'NYC', state: 'NY', postalCode: '10001', country: 'USA' },
        billingAddress: { street: '1 St', city: 'NYC', state: 'NY', postalCode: '10001', country: 'USA' },
      });

      await repos.orders.insert({
        orderNumber: 'VIP-SMALL',
        customer: vipCustomer,
        status: 'delivered',
        paymentStatus: 'captured',
        subtotal: '50.00',
        total: '50.00',
        currency: 'USD',
        shippingAddress: { street: '1 St', city: 'NYC', state: 'NY', postalCode: '10001', country: 'USA' },
        billingAddress: { street: '1 St', city: 'NYC', state: 'NY', postalCode: '10001', country: 'USA' },
      });

      await repos.orders.insert({
        orderNumber: 'REG-BIG',
        customer: regularCustomer,
        status: 'delivered',
        paymentStatus: 'captured',
        subtotal: '500.00',
        total: '500.00',
        currency: 'USD',
        shippingAddress: { street: '2 St', city: 'LA', state: 'CA', postalCode: '90001', country: 'USA' },
        billingAddress: { street: '2 St', city: 'LA', state: 'CA', postalCode: '90001', country: 'USA' },
      });

      // Find large orders (>100) from newsletter subscribers
      const bigVipOrders = await repos.orders.find({
        where: q.and(
          Order.fields.customer.has(Customer.fields.preferences.newsletter.eq(true)),
          (Order.fields.total as any).gt('100.00')
        ),
      });

      assert.strictEqual(bigVipOrders.length, 1);
      assert.strictEqual(bigVipOrders[0].orderNumber, 'VIP-BIG');
    });

    test('should use OR with multiple has() conditions', async () => {
      const nyCustomer = await repos.customers.insert({
        email: 'ny@example.com',
        passwordHash: 'hash',
        firstName: 'NY',
        lastName: 'User',
        status: 'active',
        shippingAddress: { street: '1 St', city: 'New York', state: 'NY', postalCode: '10001', country: 'USA' },
      });

      const laCustomer = await repos.customers.insert({
        email: 'la@example.com',
        passwordHash: 'hash',
        firstName: 'LA',
        lastName: 'User',
        status: 'active',
        shippingAddress: { street: '2 St', city: 'Los Angeles', state: 'CA', postalCode: '90001', country: 'USA' },
      });

      const chicagoCustomer = await repos.customers.insert({
        email: 'chicago@example.com',
        passwordHash: 'hash',
        firstName: 'Chicago',
        lastName: 'User',
        status: 'active',
        shippingAddress: { street: '3 St', city: 'Chicago', state: 'IL', postalCode: '60601', country: 'USA' },
      });

      await repos.orders.insert({
        orderNumber: 'NY-001',
        customer: nyCustomer,
        status: 'pending',
        paymentStatus: 'pending',
        subtotal: '100.00',
        total: '100.00',
        currency: 'USD',
        shippingAddress: { street: '1 St', city: 'New York', state: 'NY', postalCode: '10001', country: 'USA' },
        billingAddress: { street: '1 St', city: 'New York', state: 'NY', postalCode: '10001', country: 'USA' },
      });

      await repos.orders.insert({
        orderNumber: 'LA-001',
        customer: laCustomer,
        status: 'pending',
        paymentStatus: 'pending',
        subtotal: '100.00',
        total: '100.00',
        currency: 'USD',
        shippingAddress: { street: '2 St', city: 'Los Angeles', state: 'CA', postalCode: '90001', country: 'USA' },
        billingAddress: { street: '2 St', city: 'Los Angeles', state: 'CA', postalCode: '90001', country: 'USA' },
      });

      await repos.orders.insert({
        orderNumber: 'CHI-001',
        customer: chicagoCustomer,
        status: 'pending',
        paymentStatus: 'pending',
        subtotal: '100.00',
        total: '100.00',
        currency: 'USD',
        shippingAddress: { street: '3 St', city: 'Chicago', state: 'IL', postalCode: '60601', country: 'USA' },
        billingAddress: { street: '3 St', city: 'Chicago', state: 'IL', postalCode: '60601', country: 'USA' },
      });

      // Find orders from customers in NY or LA
      const coastalOrders = await repos.orders.find({
        where: q.or(
          Order.fields.customer.has(Customer.fields.shippingAddress.city.eq('New York')),
          Order.fields.customer.has(Customer.fields.shippingAddress.city.eq('Los Angeles')),
        ),
      });

      assert.strictEqual(coastalOrders.length, 2);
      assert.ok(coastalOrders.some(o => o.orderNumber === 'NY-001'));
      assert.ok(coastalOrders.some(o => o.orderNumber === 'LA-001'));
    });
  });
});
