/**
 * Product Service
 *
 * Business logic for product management, search, and catalog operations.
 */

import { Logger, defineService } from '@justscale/core';
import { type Persistent, type Ref, ModelRepository, q } from '@justscale/core/models';

import {
  Category,
  Product,
  Review,
} from '../models/index.js';

// ============================================================================
// Types
// ============================================================================

export interface ProductSearchParams {
  query?: string
  categoryId?: string
  minPrice?: number
  maxPrice?: number
  tags?: string[]
  inStock?: boolean
  isFeatured?: boolean
  status?: 'draft' | 'active' | 'archived'
  sortBy?: 'price' | 'name' | 'createdAt' | 'salesCount' | 'averageRating'
  sortOrder?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export interface ProductSearchResult {
  products: Persistent<Product>[]
  total: number
  hasMore: boolean
}

export interface CategoryTree {
  category: Persistent<Category>
  children: CategoryTree[]
  productCount?: number
}

// ============================================================================
// Service Definition
// ============================================================================

export class ProductService extends defineService({
  inject: {
    products: ModelRepository.of(Product),
    categories: ModelRepository.of(Category),
    reviews: ModelRepository.of(Review),
    logger: Logger,
  },

  factory: ({ products, categories, reviews, logger }) => ({
    // ─────────────────────────────────────────────────────────────────────────
    // Product CRUD
    // ─────────────────────────────────────────────────────────────────────────

    async createProduct(
      data: Omit<Persistent<Product>, 'id' | 'createdAt' | 'updatedAt' | 'version'>,
    ): Promise<Persistent<Product>> {
      logger.info('Creating product', { sku: data.sku, name: data.name });

      // Verify category exists
      const category = await categories.get(data.category);
      if (!category) {
        throw new Error(`Category not found: ${data.category}`);
      }

      const product = await products.insert(data);
      const productId = Product.ref(product).identifier;
      logger.info('Product created', { id: productId, sku: product.sku });
      return product;
    },

    async updateProduct(
      product: Ref<Product>,
      data: Partial<Persistent<Product>>,
    ): Promise<Persistent<Product>> {
      logger.info('Updating product');
      using locked = await products.lock(product);
      if (!locked) throw new Error('Product not found');
      return await products.update(locked, data);
    },

    async getProduct(product: Ref<Product>): Promise<Persistent<Product> | undefined> {
      return await products.get(product);
    },

    async getProductBySku(sku: string): Promise<Persistent<Product> | undefined> {
      return await products.findOne(Product.fields.sku.eq(sku));
    },

    async getProductBySlug(slug: string): Promise<Persistent<Product> | undefined> {
      return await products.findOne(Product.fields.slug.eq(slug));
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Product Search
    // ─────────────────────────────────────────────────────────────────────────

    async searchProducts(
      params: ProductSearchParams = {},
    ): Promise<ProductSearchResult> {
      const conditions: any[] = [];

      // Status filter (default to active)
      conditions.push(Product.fields.status.eq(params.status ?? 'active'));

      // Category filter
      if (params.categoryId) {
        conditions.push(Product.fields.category.eq(params.categoryId));
      }

      // Price range
      if (params.minPrice !== undefined) {
        conditions.push((Product.fields.price as any).gte(params.minPrice.toFixed(2)));
      }
      if (params.maxPrice !== undefined) {
        conditions.push((Product.fields.price as any).lte(params.maxPrice.toFixed(2)));
      }

      // Tags filter
      if (params.tags && params.tags.length > 0) {
        conditions.push(Product.fields.tags.hasAny(params.tags));
      }

      // In stock filter
      if (params.inStock) {
        conditions.push(
          q.or(
            Product.fields.trackInventory.eq(false),
            Product.fields.quantity.gt(0),
          ),
        );
      }

      // Featured filter
      if (params.isFeatured) {
        conditions.push(Product.fields.isFeatured.eq(true));
      }

      const where = conditions.length > 0 ? q.and(...conditions) : undefined;

      // Build sort
      const sortField = params.sortBy ?? 'createdAt';
      const sortOrder = params.sortOrder ?? 'desc';
      const orderBy: Record<string, 'asc' | 'desc'> = { [sortField]: sortOrder };

      // Get total count
      const total = await products.count(where);

      // Get products
      const productList = await products.find({
        where,
        orderBy,
        limit: params.limit ?? 20,
        offset: params.offset ?? 0,
      });

      return {
        products: productList,
        total,
        hasMore: (params.offset ?? 0) + productList.length < total,
      };
    },

    async getFeaturedProducts(limit = 10): Promise<Persistent<Product>[]> {
      return await products.find({
        where: q.and(
          Product.fields.status.eq('active'),
          Product.fields.isFeatured.eq(true),
        ),
        orderBy: { createdAt: 'desc' },
        limit,
      });
    },

    async getRelatedProducts(
      product: Ref<Product>,
      limit = 5,
    ): Promise<Persistent<Product>[]> {
      const found = await products.get(product);
      if (!found) return [];

      const productId = Product.ref(found).identifier;
      // Find products in same category, excluding current
      return await products.find({
        where: q.and(
          Product.fields.status.eq('active'),
          Product.fields.category.eq(found.category),
          q.raw(`id != '${productId}'`),
        ),
        orderBy: { salesCount: 'desc' },
        limit,
      });
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Inventory Management
    // ─────────────────────────────────────────────────────────────────────────

    async adjustInventory(
      product: Ref<Product>,
      quantityDelta: number,
    ): Promise<Persistent<Product>> {
      using locked = await products.lock(product);
      if (!locked) {
        throw new Error('Product not found');
      }

      const newQuantity = locked.quantity + quantityDelta;
      if (newQuantity < 0) {
        throw new Error('Insufficient inventory for product');
      }

      return await products.update(locked, {
        quantity: newQuantity,
      });
    },

    async getLowStockProducts(): Promise<Persistent<Product>[]> {
      return await products.find({
        where: q.and(
          Product.fields.status.eq('active'),
          Product.fields.trackInventory.eq(true),
          Product.fields.quantity.lte(10),
        ),
        orderBy: { quantity: 'asc' },
      });
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Category Operations
    // ─────────────────────────────────────────────────────────────────────────

    async createCategory(
      data: Omit<Persistent<Category>, 'id' | 'createdAt' | 'updatedAt' | 'version'>,
    ): Promise<Persistent<Category>> {
      logger.info('Creating category', { name: data.name, slug: data.slug });
      return await categories.insert(data);
    },

    async getCategory(category: Ref<Category>): Promise<Persistent<Category> | undefined> {
      return await categories.get(category);
    },

    async getCategoryBySlug(slug: string): Promise<Persistent<Category> | undefined> {
      return await categories.findOne(Category.fields.slug.eq(slug));
    },

    async getActiveCategories(): Promise<Persistent<Category>[]> {
      return await categories.find({
        where: Category.fields.isActive.eq(true),
        orderBy: { displayOrder: 'asc' },
      });
    },

    async getCategoryTree(): Promise<CategoryTree[]> {
      const allCategories = await categories.find({
        where: Category.fields.isActive.eq(true),
        orderBy: { displayOrder: 'asc' },
      });

      // Build tree structure
      const categoryMap = new Map<string, CategoryTree>();
      const roots: CategoryTree[] = [];

      // First pass: create nodes
      for (const cat of allCategories) {
        const catId = Category.ref(cat).identifier;
        categoryMap.set(catId, { category: cat, children: [] });
      }

      // Second pass: build tree
      for (const cat of allCategories) {
        const catId = Category.ref(cat).identifier;
        const node = categoryMap.get(catId)!;
        const parentRef = cat.parent;
        const parentId = parentRef?.identifier;
        if (parentId && categoryMap.has(parentId)) {
          categoryMap.get(parentId)!.children.push(node);
        } else {
          roots.push(node);
        }
      }

      return roots;
    },

    async getProductCountByCategory(category: Ref<Category>): Promise<number> {
      return await products.count(
        q.and(
          Product.fields.status.eq('active'),
          Product.fields.category.eq(category),
        ),
      );
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Reviews
    // ─────────────────────────────────────────────────────────────────────────

    async getProductReviews(
      product: Ref<Product>,
      status: 'pending' | 'approved' | 'rejected' = 'approved',
    ): Promise<any[]> {
      return await reviews.find({
        where: q.and(
          Review.fields.product.eq(product),
          Review.fields.status.eq(status),
        ),
        orderBy: { createdAt: 'desc' },
      });
    },

    async updateProductRatingStats(product: Ref<Product>): Promise<void> {
      // Get approved reviews for this product
      const productReviews = await reviews.find({
        where: q.and(
          Review.fields.product.eq(product),
          Review.fields.status.eq('approved'),
        ),
      });

      using locked = await products.lock(product);
      if (!locked) throw new Error('Product not found');

      if (productReviews.length === 0) {
        await products.update(locked, {
          averageRating: undefined,
          reviewCount: 0,
        });
        return;
      }

      const totalRating = productReviews.reduce(
        (sum, r) => sum + r.rating,
        0,
      );
      const averageRating = totalRating / productReviews.length;

      await products.update(locked, {
        averageRating: (Math.round(averageRating * 100) / 100).toFixed(2),
        reviewCount: productReviews.length,
      });
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Analytics
    // ─────────────────────────────────────────────────────────────────────────

    async incrementViewCount(product: Ref<Product>): Promise<void> {
      using locked = await products.lock(product);
      if (locked) {
        await products.update(locked, {
          viewCount: locked.viewCount + 1,
        });
      }
    },

    async getTopSellingProducts(limit = 10): Promise<Persistent<Product>[]> {
      return await products.find({
        where: Product.fields.status.eq('active'),
        orderBy: { salesCount: 'desc' },
        limit,
      });
    },

    async getTopRatedProducts(
      minReviews = 5,
      limit = 10,
    ): Promise<Persistent<Product>[]> {
      return await products.find({
        where: q.and(
          Product.fields.status.eq('active'),
          Product.fields.reviewCount.gte(minReviews),
        ),
        orderBy: { averageRating: 'desc' },
        limit,
      });
    },
  }),
}) {}

export type ProductServiceType = ReturnType<(typeof ProductService)['factory']>;
