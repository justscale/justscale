import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { filterByAccess } from '../access.js';
import { ACCESS_RULES, REFERENCE } from '../symbols.js';

// ─── Mock subject classes ───────────────────────────────────────────
class Agent {}
class Customer {}
class Admin {}

// ─── Mock permission def helpers ────────────────────────────────────
const PERMISSION_DEF = Symbol.for('@justscale/permission:permissionDef');

function mockAlwaysPermission(subjectClass: Function) {
  return { [PERMISSION_DEF]: true, subjectClass, mode: 'always' };
}

function mockWhenPermission(subjectClass: Function, fieldAccessor: { eq: (v: unknown) => { field: string } }) {
  return { [PERMISSION_DEF]: true, subjectClass, mode: 'when', fieldAccessor };
}

// ─── Mock principal helpers ─────────────────────────────────────────
function principal(type: abstract new (...a: any[]) => any, identifier: string) {
  return { type, ref: { identifier } };
}

// ─── Mock reference helper ──────────────────────────────────────────
function mockRef(identifier: string) {
  return { [REFERENCE]: true, identifier };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('filterByAccess', () => {
  test('no access rules on model returns all fields unchanged', () => {
    const entity = { name: 'Alice', email: 'alice@example.com', secret: 42 };
    const model = {}; // no ACCESS_RULES
    const result = filterByAccess(entity, model, [principal(Agent, 'a1')]);
    assert.deepStrictEqual(result, { name: 'Alice', email: 'alice@example.com', secret: 42 });
  });

  test('field with always permission — visible when principal type matches', () => {
    const model = { [ACCESS_RULES]: { secret: mockAlwaysPermission(Agent) } };
    const entity = { name: 'Alice', secret: 42 };
    const result = filterByAccess(entity, model, [principal(Agent, 'a1')]);
    assert.deepStrictEqual(result, { name: 'Alice', secret: 42 });
  });

  test('field with always permission — hidden when principal type does not match', () => {
    const model = { [ACCESS_RULES]: { secret: mockAlwaysPermission(Agent) } };
    const entity = { name: 'Alice', secret: 42 };
    const result = filterByAccess(entity, model, [principal(Customer, 'c1')]);
    assert.deepStrictEqual(result, { name: 'Alice' });
  });

  test('field not listed in access rules is always visible', () => {
    const model = { [ACCESS_RULES]: { secret: mockAlwaysPermission(Agent) } };
    const entity = { name: 'Alice', email: 'alice@example.com', secret: 42 };
    const result = filterByAccess(entity, model, [principal(Customer, 'c1')]);
    assert.deepStrictEqual(result, { name: 'Alice', email: 'alice@example.com' });
    assert.equal('secret' in result, false);
  });

  test('empty array rule — field never visible regardless of principal', () => {
    const model = { [ACCESS_RULES]: { hidden: [] as const } };
    const entity = { name: 'Alice', hidden: 'top-secret' };

    const resultAgent = filterByAccess(entity, model, [principal(Agent, 'a1')]);
    assert.deepStrictEqual(resultAgent, { name: 'Alice' });

    const resultCustomer = filterByAccess(entity, model, [principal(Customer, 'c1')]);
    assert.deepStrictEqual(resultCustomer, { name: 'Alice' });

    const resultNone = filterByAccess(entity, model, []);
    assert.deepStrictEqual(resultNone, { name: 'Alice' });
  });

  test('array of permissions (OR semantics) — visible if ANY principal matches', () => {
    const model = {
      [ACCESS_RULES]: {
        notes: [mockAlwaysPermission(Agent), mockAlwaysPermission(Admin)],
      },
    };
    const entity = { name: 'Alice', notes: 'internal' };

    // Agent matches
    assert.deepStrictEqual(
      filterByAccess(entity, model, [principal(Agent, 'a1')]),
      { name: 'Alice', notes: 'internal' },
    );

    // Admin matches
    assert.deepStrictEqual(
      filterByAccess(entity, model, [principal(Admin, 'x1')]),
      { name: 'Alice', notes: 'internal' },
    );

    // Customer matches neither
    assert.deepStrictEqual(
      filterByAccess(entity, model, [principal(Customer, 'c1')]),
      { name: 'Alice' },
    );

    // Both Agent and Admin — still visible
    assert.deepStrictEqual(
      filterByAccess(entity, model, [principal(Agent, 'a1'), principal(Admin, 'x1')]),
      { name: 'Alice', notes: 'internal' },
    );
  });

  test('object form { see: perm } — visibility controlled, other fields unaffected', () => {
    const model = {
      [ACCESS_RULES]: {
        salary: { see: mockAlwaysPermission(Admin) },
      },
    };
    const entity = { name: 'Alice', salary: 100_000 };

    // Admin can see
    assert.deepStrictEqual(
      filterByAccess(entity, model, [principal(Admin, 'x1')]),
      { name: 'Alice', salary: 100_000 },
    );

    // Agent cannot see
    assert.deepStrictEqual(
      filterByAccess(entity, model, [principal(Agent, 'a1')]),
      { name: 'Alice' },
    );
  });

  test('object form { set: perm } without see — field visible to everyone', () => {
    const model = {
      [ACCESS_RULES]: {
        bio: { set: mockAlwaysPermission(Admin) },
      },
    };
    const entity = { name: 'Alice', bio: 'Hello world' };

    // Anyone can see (no see restriction)
    assert.deepStrictEqual(
      filterByAccess(entity, model, [principal(Customer, 'c1')]),
      { name: 'Alice', bio: 'Hello world' },
    );

    assert.deepStrictEqual(
      filterByAccess(entity, model, []),
      { name: 'Alice', bio: 'Hello world' },
    );
  });

  test('object form { see: [], set: perm } — never visible (write-only)', () => {
    const model = {
      [ACCESS_RULES]: {
        password: { see: [] as const, set: mockAlwaysPermission(Admin) },
      },
    };
    const entity = { name: 'Alice', password: 'hashed' };

    // Nobody can see, not even Admin
    assert.deepStrictEqual(
      filterByAccess(entity, model, [principal(Admin, 'x1')]),
      { name: 'Alice' },
    );

    assert.deepStrictEqual(
      filterByAccess(entity, model, [principal(Agent, 'a1')]),
      { name: 'Alice' },
    );
  });

  test('when mode — field visible only when entity ref field matches principal ref', () => {
    const fieldAccessor = {
      eq: (value: unknown) => ({ field: 'assignee' }),
    };
    const model = {
      [ACCESS_RULES]: {
        internalNotes: mockWhenPermission(Agent, fieldAccessor),
      },
    };

    // Entity has a reference-like assignee field matching agent-1
    const entity = {
      title: 'Ticket',
      assignee: mockRef('agent-1'),
      internalNotes: 'secret stuff',
    };

    // Matching agent can see
    assert.deepStrictEqual(
      filterByAccess(entity, model, [principal(Agent, 'agent-1')]),
      { title: 'Ticket', assignee: entity.assignee, internalNotes: 'secret stuff' },
    );

    // Non-matching agent cannot see
    assert.deepStrictEqual(
      filterByAccess(entity, model, [principal(Agent, 'agent-2')]),
      { title: 'Ticket', assignee: entity.assignee },
    );

    // Customer cannot see (wrong type)
    assert.deepStrictEqual(
      filterByAccess(entity, model, [principal(Customer, 'agent-1')]),
      { title: 'Ticket', assignee: entity.assignee },
    );
  });

  test('when mode — non-reference field with identifier property', () => {
    const fieldAccessor = {
      eq: (value: unknown) => ({ field: 'owner' }),
    };
    const model = {
      [ACCESS_RULES]: {
        draft: mockWhenPermission(Customer, fieldAccessor),
      },
    };

    // Entity owner is a plain object with identifier (not a Reference)
    const entity = {
      title: 'Doc',
      owner: { identifier: 'cust-1' },
      draft: 'WIP content',
    };

    // Matching customer
    assert.deepStrictEqual(
      filterByAccess(entity, model, [principal(Customer, 'cust-1')]),
      { title: 'Doc', owner: entity.owner, draft: 'WIP content' },
    );

    // Non-matching customer
    assert.deepStrictEqual(
      filterByAccess(entity, model, [principal(Customer, 'cust-2')]),
      { title: 'Doc', owner: entity.owner },
    );
  });
});
