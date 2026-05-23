/**
 * Contract-Based Services
 *
 * Contracts define the shape of a service (methods, inputs, outputs).
 * Controllers can implement contracts to provide type-safe RPC handlers.
 */

// ============================================================================
// Core Types
// ============================================================================

/** Streaming modes for RPC methods */
export type StreamingMode = 'unary' | 'server' | 'client' | 'bidi';

/**
 * A message schema defines runtime encode/decode capabilities.
 * This is the interface that defineMessage() will implement.
 */
export interface MessageSchema<T = unknown> {
  /** Type brand for type inference */
  readonly $type: 'message'
  /** Message name (e.g., "HelloRequest") */
  readonly $name: string
  /** Create a new instance with defaults */
  create(partial?: Partial<T>): T
  /** Encode to binary (protobuf wire format) */
  encode?(value: T): Uint8Array
  /** Decode from binary */
  decode?(data: Uint8Array): T
  /** Convert to JSON-safe object */
  toJSON?(value: T): unknown
  /** Convert from JSON */
  fromJSON?(json: unknown): T
}

/** Extract the type from a MessageSchema */
export type MessageType<S> = S extends MessageSchema<infer T> ? T : never;

/**
 * A MessageSchema with guaranteed binary encode/decode.
 * Proto codegen generates this type - encode and decode are always present.
 */
export interface ProtoSchema<T = unknown> extends MessageSchema<T> {
  encode(value: T): Uint8Array
  decode(data: Uint8Array): T
}

// ============================================================================
// Message Definition
// ============================================================================

/** Field descriptor for message fields */
export interface FieldDescriptor {
  /** Field number (1-based, from protobuf) */
  number: number
  /** Field type (primitive or message reference) */
  type: string
  /** Whether this field is repeated */
  repeated?: boolean
  /** Whether this field is a map */
  map?: boolean
  /** Map key type (if map) */
  mapKey?: string
  /** Optional field (proto3 optional keyword or proto2 optional) */
  optional?: boolean
  /** Oneof group name (if part of a oneof) */
  oneof?: string
}

/** Configuration for defineMessage */
export interface MessageConfig<T> {
  /** Fully qualified message name (e.g., "helloworld.HelloRequest") */
  name: string
  /** Field descriptors */
  fields: Record<keyof T & string, FieldDescriptor>
  /** Create default instance */
  create?: (partial?: Partial<T>) => T
  /** Encode to binary */
  encode?: (value: T) => Uint8Array
  /** Decode from binary */
  decode?: (data: Uint8Array) => T
  /** Convert to JSON-safe object */
  toJSON?: (value: T) => unknown
  /** Convert from JSON */
  fromJSON?: (json: unknown) => T
}

/**
 * Define a message schema for runtime encode/decode.
 * This is used by code generators (protobuf, etc.) to create
 * message schemas that can serialize/deserialize data.
 *
 * @example
 * ```typescript
 * // Generated from .proto
 * export interface HelloRequest {
 *   name: string
 * }
 *
 * export const HelloRequestSchema = defineMessage<HelloRequest>({
 *   name: 'helloworld.HelloRequest',
 *   fields: {
 *     name: { number: 1, type: 'string' },
 *   },
 *   create: (partial) => ({ name: '', ...partial }),
 *   encode: (value) => { ... },
 *   decode: (data) => { ... },
 * })
 * ```
 */
export function defineMessage<T>(config: MessageConfig<T>): MessageSchema<T> {
  const shortName = config.name.split('.').pop() ?? config.name;

  const schema: MessageSchema<T> = {
    $type: 'message',
    $name: shortName,
    create: config.create ?? ((partial?: Partial<T>) => ({ ...partial } as T)),
    encode: config.encode,
    decode: config.decode,
    toJSON: config.toJSON,
    fromJSON: config.fromJSON,
  };

  // Forward Processable descriptor so proto schemas retain [Symbol.process]
  if (typeof Symbol.process === 'symbol' && Symbol.process in config) {
    Object.defineProperty(schema, Symbol.process, {
      value: (config as any)[Symbol.process],
      enumerable: false,
    });
  }

  return schema;
}

/**
 * Create a simple message schema without encode/decode.
 * Use this for manual contract definitions where you don't need
 * binary serialization.
 *
 * @example
 * ```typescript
 * const HelloRequestSchema = simpleMessage<HelloRequest>('HelloRequest')
 * ```
 */
export function simpleMessage<T>(name: string): MessageSchema<T> {
  return {
    $type: 'message',
    $name: name,
    create: (partial?: Partial<T>) => ({ ...partial } as T),
  };
}

// ============================================================================
// RPC Method Definition
// ============================================================================

/** Definition of an RPC method */
export interface RpcMethodDef<
  TInput = unknown,
  TOutput = unknown,
  TStreaming extends StreamingMode = StreamingMode,
> {
  readonly input: MessageSchema<TInput>
  readonly output: MessageSchema<TOutput>
  readonly streaming: TStreaming
}

/** Builder interface returned by rpc() before streaming is set */
export interface RpcMethodBuilder<TInput, TOutput> {
  /** Make this a server streaming RPC (client sends one, server streams many) */
  serverStream(): RpcMethodDef<TInput, TOutput, 'server'>
  /** Make this a client streaming RPC (client streams many, server sends one) */
  clientStream(): RpcMethodDef<TInput, TOutput, 'client'>
  /** Make this a bidirectional streaming RPC */
  bidiStream(): RpcMethodDef<TInput, TOutput, 'bidi'>
}

/**
 * Define an RPC method with input and output schemas.
 *
 * @example
 * ```typescript
 * // Unary (default)
 * rpc(HelloRequestSchema, HelloReplySchema)
 *
 * // Server streaming
 * rpc(HelloRequestSchema, HelloReplySchema).serverStream()
 *
 * // Bidirectional streaming
 * rpc(ChatMessageSchema, ChatMessageSchema).bidiStream()
 * ```
 */
export function rpc<TInput, TOutput>(
  input: MessageSchema<TInput>,
  output: MessageSchema<TOutput>,
): RpcMethodDef<TInput, TOutput, 'unary'> & RpcMethodBuilder<TInput, TOutput> {
  const def: RpcMethodDef<TInput, TOutput, 'unary'> = {
    input,
    output,
    streaming: 'unary',
  };

  return Object.assign(def, {
    serverStream: (): RpcMethodDef<TInput, TOutput, 'server'> => ({
      input,
      output,
      streaming: 'server',
    }),
    clientStream: (): RpcMethodDef<TInput, TOutput, 'client'> => ({
      input,
      output,
      streaming: 'client',
    }),
    bidiStream: (): RpcMethodDef<TInput, TOutput, 'bidi'> => ({
      input,
      output,
      streaming: 'bidi',
    }),
  });
}

// ============================================================================
// Contract Definition
// ============================================================================

/** Symbol for contract metadata */
export const CONTRACT_METADATA = Symbol('justscale:contractMetadata');

/** Symbol for unique contract ID */
export const CONTRACT_ID = Symbol('justscale:contractId');

/** Symbol for global counter */
const CONTRACT_ID_COUNTER = Symbol.for('justscale:contractIdCounter');

// Use global counter to handle multiple module instances
const _global = globalThis as { [CONTRACT_ID_COUNTER]?: number };
_global[CONTRACT_ID_COUNTER] = _global[CONTRACT_ID_COUNTER] ?? 0;

/** Get next unique ID (global) */
function nextContractId(): number {
  return ++_global[CONTRACT_ID_COUNTER]!;
}

/** Runtime metadata stored on contract classes */
export interface ContractMetadata<
  TProtocol extends string = string,
  TMethods extends Record<string, RpcMethodDef> = Record<string, RpcMethodDef>,
> {
  readonly protocol: TProtocol
  readonly serviceName: string
  readonly methods: TMethods
}

/** Base class for contracts (never instantiated) */
export abstract class ContractBase {
  static readonly [CONTRACT_METADATA]: ContractMetadata;
  static readonly [CONTRACT_ID]: number;
}

/**
 * The "class" type returned by defineContract.
 * This is an abstract class that carries contract metadata.
 *
 * Supports both direct usage and `abstract class X extends defineContract(...)` pattern.
 */
export interface Contract<
  TProtocol extends string = string,
  TMethods extends Record<string, RpcMethodDef> = Record<string, RpcMethodDef>,
> {
  /** Abstract constructor signature - makes it extendable (never actually called) */
  new (...args: never[]): ContractBase

  /** Runtime contract metadata */
  readonly [CONTRACT_METADATA]: ContractMetadata<TProtocol, TMethods>

  /** Unique ID for cross-module matching */
  readonly [CONTRACT_ID]: number
}

/**
 * Extract the contract type from an abstract class that extends defineContract().
 * Works with both `Contract<...>` directly and `typeof MyContract` where MyContract
 * is an abstract class extending defineContract().
 */
export type ExtractContract<T> = T extends { [CONTRACT_METADATA]: ContractMetadata<infer P, infer M> }
  ? Contract<P, M>
  : never;

/**
 * Any type that has contract metadata (Contract or abstract class extending it).
 */
export type AnyContract = { readonly [CONTRACT_METADATA]: ContractMetadata<any, any> };

/**
 * Define a contract (service interface) for RPC.
 *
 * Returns an abstract class that can be extended for named exports,
 * carrying runtime metadata for protocol adapters and code generation.
 *
 * @example
 * ```typescript
 * // Manual definition
 * export abstract class GreeterService extends defineContract({
 *   protocol: 'grpc',
 *   serviceName: 'helloworld.Greeter',
 *   methods: {
 *     sayHello: rpc(HelloRequestSchema, HelloReplySchema),
 *     sayHelloStream: rpc(HelloRequestSchema, HelloReplySchema).serverStream(),
 *     chat: rpc(ChatMessageSchema, ChatMessageSchema).bidiStream(),
 *   },
 * }) {}
 *
 * // Generated from .proto
 * export abstract class UserService extends defineContract({
 *   protocol: 'grpc',
 *   serviceName: 'user.UserService',
 *   methods: {
 *     createUser: rpc(CreateUserRequestSchema, CreateUserResponseSchema),
 *     getUser: rpc(GetUserRequestSchema, UserSchema),
 *   },
 * }) {}
 * ```
 */
export function defineContract<
  TProtocol extends string,
  TMethods extends Record<string, RpcMethodDef>,
>(config: {
  protocol: TProtocol
  serviceName: string
  methods: TMethods
}): Contract<TProtocol, TMethods> {
  const id = nextContractId();

  function ContractImpl(this: unknown) {
    throw new Error(
      `Contract '${config.serviceName}' cannot be instantiated directly. ` +
      'Use createController.implements() to create an implementation.'
    );
  }

  Object.defineProperty(ContractImpl, 'name', {
    value: config.serviceName.split('.').pop() ?? config.serviceName,
    configurable: true,
  })

  ;(ContractImpl as any)[CONTRACT_METADATA] = {
    protocol: config.protocol,
    serviceName: config.serviceName,
    methods: config.methods,
  }
  ;(ContractImpl as any)[CONTRACT_ID] = id;

  return ContractImpl as unknown as Contract<TProtocol, TMethods>;
}

// ============================================================================
// Type Inference Utilities
// ============================================================================

/** Helper to extract methods from any contract-like type */
type ExtractMethods<C> = C extends { [CONTRACT_METADATA]: ContractMetadata<any, infer M> } ? M : never;

/** Extract method names from a contract */
export type ContractMethods<C extends AnyContract> = keyof ExtractMethods<C> & string;

/** Extract input type for a method */
export type MethodInput<
  C extends AnyContract,
  M extends ContractMethods<C>,
> = ExtractMethods<C>[M] extends RpcMethodDef<infer TInput, any, any> ? TInput : never;

/** Extract output type for a method */
export type MethodOutput<
  C extends AnyContract,
  M extends ContractMethods<C>,
> = ExtractMethods<C>[M] extends RpcMethodDef<any, infer TOutput, any> ? TOutput : never;

/** Extract streaming mode for a method */
export type MethodStreaming<
  C extends AnyContract,
  M extends ContractMethods<C>,
> = ExtractMethods<C>[M] extends RpcMethodDef<any, any, infer TStreaming> ? TStreaming : never;

/** Get contract metadata from a contract class */
export function getContractMetadata<C extends AnyContract>(
  contract: C
): ContractMetadata {
  const metadata = (contract as any)[CONTRACT_METADATA];
  if (!metadata) {
    throw new Error(`Not a valid contract: missing ${String(CONTRACT_METADATA)}`);
  }
  return metadata;
}

// ============================================================================
// RPC Context Type
// ============================================================================

/** Context passed to RPC handlers */
export interface RpcContext<TBody, TSession = unknown> {
  /** Request body (or async iterable for client/bidi streaming) */
  body: TBody
  /** gRPC metadata / HTTP headers */
  metadata: Map<string, string>
  /** Cancellation signal */
  signal: AbortSignal
  /** Request deadline (if set) */
  deadline?: Date
  /** Session data (set by auth middleware) */
  session: TSession
}

/** Streaming context for client/bidi streaming */
export interface StreamingRpcContext<TBody, TSession = unknown>
  extends Omit<RpcContext<TBody, TSession>, 'body'> {
  /** Incoming message stream */
  body: AsyncIterable<TBody>
}

// ============================================================================
// Handler Types
// ============================================================================

/** Handler for unary RPC */
export type UnaryHandler<TInput, TOutput, TSession = unknown> = (
  ctx: RpcContext<TInput, TSession>
) => Promise<TOutput> | TOutput;

/** Handler for server streaming RPC */
export type ServerStreamHandler<TInput, TOutput, TSession = unknown> = (
  ctx: RpcContext<TInput, TSession>
) => AsyncGenerator<TOutput, void, unknown>;

/** Handler for client streaming RPC */
export type ClientStreamHandler<TInput, TOutput, TSession = unknown> = (
  ctx: StreamingRpcContext<TInput, TSession>
) => Promise<TOutput> | TOutput;

/** Handler for bidirectional streaming RPC */
export type BidiStreamHandler<TInput, TOutput, TSession = unknown> = (
  ctx: StreamingRpcContext<TInput, TSession>
) => AsyncGenerator<TOutput, void, unknown>;

/** Get the handler type for a method based on its streaming mode */
export type MethodHandler<
  C extends AnyContract,
  M extends ContractMethods<C>,
  TSession = unknown,
> = MethodStreaming<C, M> extends 'unary'
  ? UnaryHandler<MethodInput<C, M>, MethodOutput<C, M>, TSession>
  : MethodStreaming<C, M> extends 'server'
    ? ServerStreamHandler<MethodInput<C, M>, MethodOutput<C, M>, TSession>
    : MethodStreaming<C, M> extends 'client'
      ? ClientStreamHandler<MethodInput<C, M>, MethodOutput<C, M>, TSession>
      : MethodStreaming<C, M> extends 'bidi'
        ? BidiStreamHandler<MethodInput<C, M>, MethodOutput<C, M>, TSession>
        : never;

/** Required implementation shape for a contract */
export type ContractImplementation<
  C extends AnyContract,
  TSession = unknown,
> = {
  [M in ContractMethods<C>]: MethodHandler<C, M, TSession>
};
