/**
 * Type-level spec for middleware/guard requires aggregation (Phase 1).
 *
 * Ensures that `.use(MwDef)` and `.guard(GuardDef)` contribute their
 * `inject` deps to the route's TRequirements, which in turn flows up
 * through `ControllerRouteRequirements` into `RequiresOf<ControllerDef>`.
 *
 * Compile-only. If the aggregation regresses, `ptsc --noEmit` fails.
 */

import type { RequiresOf } from '../src/builder/types.js';
import type { RouteDef } from '../src/builder/types.js';
import type { ControllerDef } from '../src/core/controller.js';
import type { MiddlewareDef, GuardDef } from '../src/core/middleware.js';

// Unique classes/brands so TS doesn't collapse them structurally.
class SessionSvc { readonly __session = 'session' as const; }
class AuditSvc { readonly __audit = 'audit' as const; }
class PolicyEngine { readonly __policy = 'policy' as const; }
class Svc { readonly __svc = 'svc' as const; }

// Simulate middleware/guard defs that inject specific services.
type AuthMw = MiddlewareDef<{ user: string }, { session: typeof SessionSvc; audit: typeof AuditSvc }>;
type PermGuard = GuardDef<{ policy: typeof PolicyEngine }>;

// Routes as the builder would emit them — TRequirements holds the deps
// extracted from the middleware/guard steps attached via .use()/.guard().
type RouteWithAuthMw = RouteDef<
  '/secured',
  unknown,
  /* TRequirements */ typeof SessionSvc | typeof AuditSvc,
  unknown
>;

type RouteWithPermGuard = RouteDef<
  '/locked',
  unknown,
  /* TRequirements */ typeof PolicyEngine,
  unknown
>;

type RouteWithBoth = RouteDef<
  '/both',
  unknown,
  /* TRequirements */ typeof SessionSvc | typeof AuditSvc | typeof PolicyEngine,
  unknown
>;

type RoutePlain = RouteDef<'/plain', unknown, never, unknown>;

type Element<T> = T extends (infer U)[] ? U : never;
type IsMember<U, M> = M extends U ? true : false;

// ---------------------------------------------------------------------------
// 1. Controller with middleware-bearing route: deps flow into RequiresOf.
// ---------------------------------------------------------------------------
type C1 = ControllerDef<{ svc: typeof Svc }, { list: RouteWithAuthMw }>;
type R1 = Element<RequiresOf<C1>>;
const sessionInR1: IsMember<R1, typeof SessionSvc> = true;
const auditInR1: IsMember<R1, typeof AuditSvc> = true;
const svcInR1: IsMember<R1, typeof Svc> = true;
void sessionInR1; void auditInR1; void svcInR1;

// ---------------------------------------------------------------------------
// 2. Controller with guard-bearing route: guard deps flow in too.
// ---------------------------------------------------------------------------
type C2 = ControllerDef<{ svc: typeof Svc }, { list: RouteWithPermGuard }>;
type R2 = Element<RequiresOf<C2>>;
const policyInR2: IsMember<R2, typeof PolicyEngine> = true;
void policyInR2;

// ---------------------------------------------------------------------------
// 3. Mixed middleware + guard requirements aggregate.
// ---------------------------------------------------------------------------
type C3 = ControllerDef<{ svc: typeof Svc }, { x: RouteWithBoth }>;
type R3 = Element<RequiresOf<C3>>;
const sessionInR3: IsMember<R3, typeof SessionSvc> = true;
const policyInR3: IsMember<R3, typeof PolicyEngine> = true;
void sessionInR3; void policyInR3;

// ---------------------------------------------------------------------------
// 4. Plain route (no middleware/guard deps): no pollution from TRequirements.
// ---------------------------------------------------------------------------
type C4 = ControllerDef<{ svc: typeof Svc }, { list: RoutePlain }>;
type R4 = Element<RequiresOf<C4>>;
const svcInR4: IsMember<R4, typeof Svc> = true;
const sessionNotInR4: IsMember<R4, typeof SessionSvc> = false;
const policyNotInR4: IsMember<R4, typeof PolicyEngine> = false;
void svcInR4; void sessionNotInR4; void policyNotInR4;

// ---------------------------------------------------------------------------
// 5. Multi-route controller: union across routes.
// ---------------------------------------------------------------------------
type C5 = ControllerDef<
  { svc: typeof Svc },
  { a: RouteWithAuthMw; b: RouteWithPermGuard }
>;
type R5 = Element<RequiresOf<C5>>;
const sessionInR5: IsMember<R5, typeof SessionSvc> = true;
const policyInR5: IsMember<R5, typeof PolicyEngine> = true;
void sessionInR5; void policyInR5;

// Prevent the file from becoming a no-op type declaration.
// (not strictly needed but node:test's loader expects executable code).
void 0;
