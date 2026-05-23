export {
  listen,
  registerUpgradeHandler,
  registerRequestHandler,
  type UpgradeHandler,
  type RequestHandler,
} from './server.js';
export type { JsonResponse } from './server.js';
export { getClientIp } from './client-ip.js';

export {
  createHttpRouteBuilder,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Head,
  Options,
  body,
  query,
  upload,
  pagination,
  ValidationErrorSchema,
} from './builder/index.js';
export type {
  HttpRouteBuilder,
  HttpRouteDef,
  HttpMethod,
  HttpBaseContext,
  UploadedFile,
  ParsedUpload,
  PaginationOptions,
} from './builder/index.js';

export { HttpConfig } from './config.js';
export { httpEnv } from './env.js';

export { AbstractHttpAdapter, HttpService } from './service.js';
export type { HttpAdapter } from './service.js';

export {
  populate,
  lock,
  BODY_SCHEMA,
  QUERY_SCHEMA,
  RESPONSE_SCHEMA,
  RESPONSE_SCHEMAS,
  MIDDLEWARE_RESPONSES,
  type SchemaMiddleware,
  type MiddlewareWithResponses,
  type ExtractMiddlewareResponses,
} from './middleware.js';

export type {
  HttpContext,
  HttpRouteContext,
  ResponseMap,
  TypedJsonResponse,
  TypedStatusedResponse,
} from './types.js';

import './types.js';

export { HTTP_ADAPTER, HTTP_TRANSPORT_REQUIRES } from './adapter.js';
