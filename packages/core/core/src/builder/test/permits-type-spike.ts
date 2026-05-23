/**
 * Fix: avoid multiple infers in the same extends clause on unions.
 * Use Extract + separate conditionals instead.
 *
 * Run: npx tsc --noEmit --strict --target ES2022 --ignoreConfig <this file>
 */

// ============================================================================
// Setup
// ============================================================================

interface PermDef<TSubject, TName extends string = string> {
  readonly __subject: TSubject
  readonly name: TName
}

class Agent { declare _a: string; }
class Customer { declare _c: string; }
class Admin { declare _admin: true; }

interface Entry<S extends number, B, P = unknown> {
  status: S; body: B; permission: P
}

type EmployeeFull = { name: string; salary: string; department: string };
type EmployeeLimited = { name: string };
type ErrorBody = { error: string };

const Employee = {
  can: {
    fullAccess: { name: 'fullAccess' } as PermDef<Agent, 'fullAccess'>,
    view: { name: 'view' } as PermDef<Customer, 'view'>,
  },
};

// ============================================================================
// Type utilities — single infer per extends
// ============================================================================

// Extract permission from entry (single infer)
type PermOf<E> = E extends Entry<any, any, infer P> ? P : never;

// Extract body from entry (single infer)
type BodyOf<E> = E extends Entry<any, infer B, any> ? B : never;

// Extract status from entry (single infer)
type StatusOf<E> = E extends Entry<infer S, any, any> ? S : never;

// Filter entries with permissions
type PermEntries<R> = R extends Entry<any, any, infer P>
  ? P extends PermDef<any, any> ? R : never
  : never;

// Extract name from a PermDef
type NameOf<P> = P extends PermDef<any, infer N> ? N : never;

// Build variant: for each entry E, create { permission, json }
// Uses single-infer helpers instead of multi-infer extends
type ToVariant<E> = E extends any  // distribute over E
  ? {
    readonly permission: NameOf<PermOf<E>>
    json(data: BodyOf<E>): void
  }
  : never;

// Body for a status code
type BodyForStatus<R, S extends number> = R extends Entry<S, infer B, any> ? B : never;

// ============================================================================
// PermissionedRes
// ============================================================================

type PermissionedRes<R> = ToVariant<PermEntries<R>> & {
  status<S extends number>(code: S): {
    json(data: BodyForStatus<R, S>): void
    end(): void
  }
};

type PlainRes<R> = {
  json(data: BodyForStatus<R, 200>): void
  status<S extends number>(code: S): {
    json(data: BodyForStatus<R, S>): void
    end(): void
  }
};

// ============================================================================
// Test types
// ============================================================================

type Returns =
  | Entry<200, EmployeeFull, PermDef<Agent, 'fullAccess'>>
  | Entry<200, EmployeeLimited, PermDef<Customer, 'view'>>
  | Entry<404, ErrorBody>;

type MyRes = PermissionedRes<Returns>;

function assertNever(x: never): never {
  throw new Error(`Unhandled: ${x}`);
}

// ============================================================================
// TEST 1: switch/case — exhaustive
// ============================================================================

function handler1(ctx: { res: MyRes }) {
  switch (ctx.res.permission) {
    case 'fullAccess':
      ctx.res.json({ name: 'Admin', salary: '100k', department: 'Eng' });
      return;
    case 'view':
      ctx.res.json({ name: 'Viewer' });
      return;
    default:
      assertNever(ctx.res);
  }
}

// ============================================================================
// TEST 2: Missing case
// ============================================================================

function handler2(ctx: { res: MyRes }) {
  switch (ctx.res.permission) {
    case 'fullAccess':
      ctx.res.json({ name: 'Admin', salary: '100k', department: 'Eng' });
      return;
    default:
      // @ts-expect-error — 'view' not handled
      assertNever(ctx.res);
  }
}

// ============================================================================
// TEST 3: Excess properties
// ============================================================================

function handler3(ctx: { res: MyRes }) {
  switch (ctx.res.permission) {
    case 'view':
      // @ts-expect-error — salary not in EmployeeLimited
      ctx.res.json({ name: 'a', salary: 'oops' });
      return;
    case 'fullAccess':
      ctx.res.json({ name: 'a', salary: 'b', department: 'c' });
      return;
  }
}

// ============================================================================
// TEST 4: Wrong types
// ============================================================================

function handler4(ctx: { res: MyRes }) {
  switch (ctx.res.permission) {
    case 'fullAccess':
      // @ts-expect-error — salary must be string
      ctx.res.json({ name: 'a', salary: 123, department: 'c' });
      return;
    case 'view':
      ctx.res.json({ name: 'a' });
      return;
  }
}

// ============================================================================
// TEST 5: 404 via status()
// ============================================================================

function handler5(ctx: { res: MyRes }) {
  ctx.res.status(404).json({ error: 'not found' });
}

// ============================================================================
// TEST 6: Three levels
// ============================================================================

type ProjectReturns =
  | Entry<200, { name: string; secrets: string; budget: string }, PermDef<Admin, 'owner'>>
  | Entry<200, { name: string; budget: string }, PermDef<Agent, 'editor'>>
  | Entry<200, { name: string }, PermDef<Customer, 'viewer'>>;

function handler6(ctx: { res: PermissionedRes<ProjectReturns> }) {
  switch (ctx.res.permission) {
    case 'owner':
      ctx.res.json({ name: 'x', secrets: 'y', budget: 'z' });
      return;
    case 'editor':
      ctx.res.json({ name: 'x', budget: 'z' });
      return;
    case 'viewer':
      ctx.res.json({ name: 'x' });
      return;
    default:
      assertNever(ctx.res);
  }
}

function handler6_missing(ctx: { res: PermissionedRes<ProjectReturns> }) {
  switch (ctx.res.permission) {
    case 'owner':
      ctx.res.json({ name: 'x', secrets: 'y', budget: 'z' });
      return;
    case 'viewer':
      ctx.res.json({ name: 'x' });
      return;
    default:
      // @ts-expect-error — 'editor' missing
      assertNever(ctx.res);
  }
}

// ============================================================================
// TEST 7: Backwards compat — PlainRes
// ============================================================================

type SimpleReturns =
  | Entry<200, { users: string[] }>
  | Entry<404, ErrorBody>;

function handler7(ctx: { res: PlainRes<SimpleReturns> }) {
  ctx.res.json({ users: ['alice'] });
  ctx.res.status(404).json({ error: 'nope' });
}
