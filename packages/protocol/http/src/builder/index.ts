/**
 * HTTP Builder Module
 *
 * Exports HTTP-specific route builder types and factories.
 *
 * HTTP transport no longer uses a module-load side effect. Instead, each
 * Get/Post/Put/... factory installs HTTP_ADAPTER into the build-phase ALS
 * context at call time. The kernel picks up installed adapters and starts
 * them after `await app.ready`.
 */

export type {
  HttpRouteBuilder,
  HttpRouteDef,
  HttpMethod,
  HttpBaseContext,
} from './types.js';

export {
  createHttpRouteBuilder,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Head,
  Options,
} from './create-http-builder.js';

// Validation plugins
export { body, query, ValidationErrorSchema } from './plugins/index.js';
// Upload plugin
export { upload } from './plugins/index.js';
export type { UploadedFile, ParsedUpload } from './plugins/index.js';
// Pagination
export { pagination } from './plugins/index.js';
export type { PaginationOptions } from './plugins/index.js';
