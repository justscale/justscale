/**
 * @justscale/cluster
 *
 * Cluster capabilities for JustScale applications.
 *
 * The main entry point is now JustScale() from '@justscale/core':
 *
 * @example Creating an app
 * ```typescript
 * import JustScale from '@justscale/core'
 * import '@justscale/http'
 *
 * const app = JustScale()
 *   .add(UserService)
 *   .add(UserController)
 *   .build()
 *
 * await app.serve({ http: 3000 })
 * ```
 *
 * @example Using the CLI client directly
 * ```typescript
 * import { connectToCluster } from "@justscale/cluster"
 *
 * const client = await connectToCluster()
 * const result = await client.invoke("auth create-user", {
 *   email: "test@example.com",
 *   password: "secret",
 * })
 * ```
 *
 * @module @justscale/cluster
 */

// Protocol
export {
  PROTOCOL_VERSION,
  PROTOCOL_V1_CBOR,
  PROTOCOL_V2_PROTO,
  WIRE_FORMAT_CBOR,
  WIRE_FORMAT_PROTO,
  type WireFormat,
  type ProtoCodec,
  setProtoCodec,
  getProtoCodec,
  encodeFrameV2,
  type MessageType,
  type AuthLevel,
  type AuthInfo,
  type AuthNone,
  type AuthSocket,
  type AuthSharedSecret,
  type AuthPubkey,
  type Message,
  type RequestMessage,
  type ResponseMessage,
  type SuccessResponse,
  type ErrorResponse,
  type StreamMessage,
  type EventMessage,
  type PromptType,
  type PromptRequest,
  type PromptResponseData,
  ErrorCodes,
  type ErrorCode,
  Methods,
  encodeFrame,
  FrameDecoder,
  createRequest,
  createResponse,
  createErrorResponse,
  createStream,
  createEvent,
  isRequest,
  isResponse,
  isSuccessResponse,
  isErrorResponse,
  isStream,
  isEvent,
} from './protocol.js';

// Transport
export {
  type Transport,
  type TransportEvents,
  SocketTransport,
  type SocketTransportOptions,
  getSocketDir,
  getSocketPath,
  cleanupSocket,
  getPeerCredentials,
} from './transport.js';

// Server
export {
  ClusterServer,
  createClusterServer,
  type ServerOptions,
  type ServerEvents,
  type MethodHandler,
  type HandlerContext,
  type PromptOptions,
} from './server.js';

// Client
export {
  ClusterClient,
  createClusterClient,
  connectToCluster,
  type ClientOptions,
  type ClientEvents,
  type CallOptions,
  type PromptHandler,
} from './client.js';

// Proto codec: import { clusterProtoCodec } from '@justscale/core/cluster/proto-codec'
// Requires .proto module resolution via ptsc - not in default build output.

// Coordinator (cluster-as-a-process)
export {
  ClusterNode,
  ClusterNodeStatus,
  ClusterSignals,
  clusterCoordinator,
  COORDINATOR_PATH,
  NodeLifecycleService,
  type NodeLifecycleOptions,
} from './coordinator/index.js';

// Cluster (transport system)
export {
  type Cluster,
  type TransportPlugin,
  type ServeOptions,
  registerTransport,
  getRegisteredTransports,
} from './cluster.js';

// ============================================================================
// Re-exports from @justscale/core for convenience
// ============================================================================

// Main entry point
export { default as JustScale } from '../justscale.js';
export type { BuiltApp } from '../justscale.js';

// Builder utilities
export {
  bindRepository,
  bindService,
  bindInstance,
} from '../index.js';

// Builder types
export type {
  Token,
  AnyToken,
  Component,
  Builder,
  RepositoryBinding,
  ServiceBinding,
  InstanceBinding,
  FeatureToken,
  FeatureMetadata,
  BuilderCallback,
  StartHook,
  StopHook,
  ProvidesOf,
  RequiresOf,
} from '../index.js';

// Type guards
export {
  isServiceDef,
  isControllerDef,
  isRepositoryBinding,
  isServiceBinding,
  isInstanceBinding,
  isFeatureToken,
  isBuilderCallback,
  isComponentArray,
  FEATURE_TOKEN,
  FEATURE_META,
  REPO_BINDING,
  SERVICE_BINDING,
  INSTANCE_BINDING,
} from '../index.js';
