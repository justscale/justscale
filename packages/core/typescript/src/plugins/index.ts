/**
 * Public-release version of the plugin barrel.
 *
 * Registers nothing. Swapping index.ts for this file (and excluding dist/plugins/
 * from package.json#files) produces a published @justscale/typescript package
 * that compiles durable processes and DI without protobuf/capnp/graphql support.
 *
 * To apply the patch:
 *   cp src/plugins/index.public.ts src/plugins/index.ts
 *   # then update package.json#files to exclude "dist/plugins"
 */

export {};
