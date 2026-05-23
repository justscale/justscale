/**
 * Type-level spec: defineApp preserves both TEnv and TBuilder types.
 *
 * Recommended form — annotate the factory param with AppEnv, no generic
 * args. Both type params infer cleanly:
 *
 *     defineApp(meta, (env: AppEnv) => JustScale()...)
 *
 * This works because TS infers both TEnv (from the factory parameter
 * annotation) and TBuilder (from the factory return) without hitting
 * the partial-inference limitation.
 */

import type { DefinedApp } from '../../src/cli/define-app.js';
import { defineApp } from '../../src/cli/define-app.js';
import type { Environment } from '../../src/features/environment/index.js';

type FakeEnv = Environment<readonly [], readonly []>;

class FakeBuilder {
  readonly __builder = 'b' as const;
  add(_: unknown): this { return this; }
  build(): { compile(): { ready: Promise<void> }; serve(): Promise<void> } {
    return { compile: () => ({ ready: Promise.resolve() }), serve: async () => {} };
  }
}

// Recommended form: annotate factory param, let inference do the rest.
const app1 = defineApp(
  { url: 'file:///nope.ts' },
  (_env: FakeEnv) => new FakeBuilder(),
);
type App1 = typeof app1;
const _app1TypeCheck: App1 extends DefinedApp<FakeEnv, FakeBuilder> ? true : false = true;
void _app1TypeCheck;

// Explicit form — caller writes both type params. Works but verbose.
const app2 = defineApp<FakeEnv, FakeBuilder>(
  { url: 'file:///nope.ts' },
  (_env) => new FakeBuilder(),
);
type App2 = typeof app2;
const _app2TypeCheck: App2 extends DefinedApp<FakeEnv, FakeBuilder> ? true : false = true;
void _app2TypeCheck;

// Fully inferred with no type annotations — TEnv defaults to Environment.
const app3 = defineApp(
  { url: 'file:///nope.ts' },
  (_env) => new FakeBuilder(),
);
type App3 = typeof app3;
const _app3TypeCheck: App3 extends DefinedApp<Environment, FakeBuilder> ? true : false = true;
void _app3TypeCheck;

export {};
