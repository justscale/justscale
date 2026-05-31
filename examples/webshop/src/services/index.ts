/**
 * Webshop Services
 *
 * Business logic layer following the DDD Repository/Service pattern.
 */

export {
  ProductService,
  type ProductServiceType,
  type ProductSearchParams,
  type ProductSearchResult,
  type CategoryTree,
} from './product.service.js';
export {
  CartService,
  type CartServiceType,
  type CartSummary,
  type CartItemWithProduct,
  type AddToCartParams,
} from './cart.service.js';
export {
  OrderService,
  type OrderServiceType,
  type CheckoutParams,
  type OrderSearchParams,
  type OrderWithItems,
} from './order.service.js';
