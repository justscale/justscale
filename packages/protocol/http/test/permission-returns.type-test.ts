/**
 * Type-level tests for permission-scoped `.returns()`.
 *
 * These tests verify that the TYPE SYSTEM enforces:
 * - `switch(res.permission)` narrows `res.json()` per case
 * - Missing cases trigger compile error via `assertNever`
 * - Object literals get excess property checking per permission
 * - `res.status(404).json()` still works for unpermissioned responses
 * - Routes without permission-scoped returns work as before
 *
 * Run: npx tsc --noEmit (via pnpm typecheck)
 */

import { Get } from '../src/builder/create-http-builder.js';
import { z } from 'zod';

// ============================================================================
// Test permission defs (structurally match PermissionDefLike)
// ============================================================================

const fullAccess = { name: 'fullAccess' as const };
const viewOnly = { name: 'view' as const };

// ============================================================================
// Response schemas
// ============================================================================

const EmployeeFull = z.object({
  name: z.string(),
  salary: z.string(),
  department: z.string(),
});

const EmployeeLimited = z.object({
  name: z.string(),
});

const ErrorResponse = z.object({
  error: z.string(),
});

function assertNever(x: never): never {
  throw new Error(`Unhandled: ${String(x)}`);
}

// ============================================================================
// TEST: switch/case narrows res.json() per permission
// ============================================================================

Get('/employees/:id')
  .returns(200, EmployeeFull, fullAccess)
  .returns(200, EmployeeLimited, viewOnly)
  .returns(404, ErrorResponse)
  .handle(async ({ res }) => {
    // 404 via status() - always available
    res.status(404).json({ error: 'not found' });

    // Discriminated union on res.permission
    switch (res.permission) {
      case 'fullAccess':
        res.json({
          name: 'Admin',
          salary: '100k',
          department: 'Eng',
        });
        return;
      case 'view':
        res.json({ name: 'Viewer' });
        return;
      default:
        assertNever(res);
    }
  });

// ============================================================================
// TEST: backwards compat - no permission-scoped returns
// ============================================================================

Get('/users')
  .returns(200, z.object({ users: z.array(z.string()) }))
  .returns(404, ErrorResponse)
  .handle(async ({ res }) => {
    // res is the classic TypedJsonResponse - status-indexed narrowing
    res.json({ users: ['alice'] });
    res.status(404).json({ error: 'not found' });
  });

// ============================================================================
// TEST: three permission levels
// ============================================================================

const owner = { name: 'owner' as const };
const editor = { name: 'editor' as const };
const viewer = { name: 'viewer' as const };

Get('/projects/:id')
  .returns(200, z.object({ name: z.string(), secrets: z.string(), budget: z.string() }), owner)
  .returns(200, z.object({ name: z.string(), budget: z.string() }), editor)
  .returns(200, z.object({ name: z.string() }), viewer)
  .handle(async ({ res }) => {
    switch (res.permission) {
      case 'owner':
        res.json({ name: 'P', secrets: 'x', budget: 'y' });
        return;
      case 'editor':
        res.json({ name: 'P', budget: 'y' });
        return;
      case 'viewer':
        res.json({ name: 'P' });
        return;
      default:
        assertNever(res);
    }
  });
