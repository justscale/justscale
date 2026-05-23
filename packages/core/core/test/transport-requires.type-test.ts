/**
 * Type-level spec for transport-requires aggregation added in step 3.
 * Compile-time only — no runtime test runner needed. If the type operators
 * regress, `ptsc --noEmit` will fail.
 */

import type { RequiresOf } from '../src/builder/types.js';
import type { RouteDef } from '../src/builder/types.js';
import type { ControllerDef } from '../src/core/controller.js';

// Each class needs a unique brand to break TypeScript's structural-subtyping
// equality for empty classes (`class A {}` equals `class B {}` structurally).
class Svc { readonly __svc = 'svc' as const; }
class CfgA { readonly __cfgA = 'cfgA' as const; }
class CfgB { readonly __cfgB = 'cfgB' as const; }

type BasicRoute = RouteDef<'/foo', unknown, never, unknown>;

interface RouteWithRequiresA extends RouteDef<'/bar', unknown, never, unknown> {
  readonly __transportRequires: readonly [typeof CfgA];
}

interface RouteWithRequiresAB extends RouteDef<'/baz', unknown, never, unknown> {
  readonly __transportRequires: readonly [typeof CfgA, typeof CfgB];
}

type Element<T> = T extends (infer U)[] ? U : never;
type IsMember<U, M> = M extends U ? true : false;

// -----------------------------------------------------------------------------
// 1. Controller with no transport-stamped routes: CfgA must NOT be in the union.
// -----------------------------------------------------------------------------
type C1 = ControllerDef<{ svc: typeof Svc }, { list: BasicRoute }>;
type R1Element = Element<RequiresOf<C1>>;
const svcIsMember: IsMember<R1Element, typeof Svc> = true;
const cfgANotInR1: IsMember<R1Element, typeof CfgA> = false;
void svcIsMember; void cfgANotInR1;

// -----------------------------------------------------------------------------
// 2. Route with __transportRequires — CfgA bubbles up into controller requires.
// -----------------------------------------------------------------------------
type C2 = ControllerDef<{ svc: typeof Svc }, { list: RouteWithRequiresA }>;
type R2Element = Element<RequiresOf<C2>>;
const cfgAInR2: IsMember<R2Element, typeof CfgA> = true;
const svcInR2: IsMember<R2Element, typeof Svc> = true;
void cfgAInR2; void svcInR2;

// -----------------------------------------------------------------------------
// 3. Multi-token brand — both tokens flow in.
// -----------------------------------------------------------------------------
type C3 = ControllerDef<{ svc: typeof Svc }, { a: RouteWithRequiresAB }>;
type R3Element = Element<RequiresOf<C3>>;
const cfgAInR3: IsMember<R3Element, typeof CfgA> = true;
const cfgBInR3: IsMember<R3Element, typeof CfgB> = true;
void cfgAInR3; void cfgBInR3;

// -----------------------------------------------------------------------------
// 4. Array form aggregates the same way as record form.
// -----------------------------------------------------------------------------
type C4 = ControllerDef<Record<string, never>, RouteWithRequiresA[]>;
type R4Element = Element<RequiresOf<C4>>;
const cfgAInR4: IsMember<R4Element, typeof CfgA> = true;
void cfgAInR4;

export {};
