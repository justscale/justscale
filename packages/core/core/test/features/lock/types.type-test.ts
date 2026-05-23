/**
 * Type-level tests for Lock<T>
 *
 * These tests verify the Lock<T> type correctly:
 * - Makes domain fields mutable
 * - Keeps system fields readonly
 * - Handles edge cases (optional, nested, methods, etc.)
 *
 * If this file compiles without errors, the types are correct.
 * Lines with @ts-expect-error should fail to compile.
 */

import type { Lock, LockMetadata } from '../../../src/features/lock/types.js';
import type { SystemFields, Persistent } from '../../../src/models/types.js';
import { PERSISTENT } from '../../../src/models/symbols.js';

// =============================================================================
// Test Helpers
// =============================================================================

// Helper to assert a type is assignable
type AssertAssignable<T, U extends T> = U;
// Helper to assert exact type match
type AssertExact<T, U extends T> = T extends U ? true : false;

// =============================================================================
// Test 1: Basic domain field mutability
// =============================================================================

interface BasicUser {
  readonly id: string
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly version: number
  readonly name: string
  readonly email: string
}

declare const lockedBasicUser: Lock<BasicUser>;

// Domain fields should be mutable
function testBasicMutability() {
  lockedBasicUser.name = 'new name'; // Should work
  lockedBasicUser.email = 'new@email.com'; // Should work
}

// All fields (including id, createdAt, etc.) are mutable under Lock
// since system fields are now adapter concerns, not part of domain types
function testAllFieldsMutable() {
  lockedBasicUser.id = 'new-id';
  lockedBasicUser.createdAt = new Date();
  lockedBasicUser.updatedAt = new Date();
  lockedBasicUser.version = 2;
}

// =============================================================================
// Test 2: Optional fields
// =============================================================================

interface UserWithOptional {
  readonly id: string
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly version: number
  readonly name: string
  readonly nickname?: string
  readonly deletedAt?: Date
}

declare const lockedOptional: Lock<UserWithOptional>;

function testOptionalFields() {
  // Optional domain fields should be mutable
  lockedOptional.nickname = 'nick';
  lockedOptional.nickname = undefined;
  lockedOptional.deletedAt = new Date();
  lockedOptional.deletedAt = undefined;
}

// =============================================================================
// Test 3: Methods are preserved
// =============================================================================

interface UserWithMethods {
  readonly id: string
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly version: number
  readonly balance: number
  deposit(amount: number): void
  getFullName(): string
}

declare const lockedWithMethods: Lock<UserWithMethods>;

function testMethodsPreserved() {
  // Methods should still be callable
  lockedWithMethods.deposit(100);
  const name: string = lockedWithMethods.getFullName();

  // Domain fields should be mutable
  lockedWithMethods.balance = 500;
}

// =============================================================================
// Test 4: Nested objects
// =============================================================================

interface Address {
  readonly street: string
  readonly city: string
}

interface UserWithNested {
  readonly id: string
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly version: number
  readonly name: string
  readonly address: Address
}

declare const lockedNested: Lock<UserWithNested>;

function testNestedObjects() {
  // The address field itself should be assignable (reassign whole object)
  lockedNested.address = { street: 'new', city: 'new' };

  // But nested properties keep their original modifiers
  // (Lock only removes readonly at the top level)
  // @ts-expect-error - nested readonly is preserved
  lockedNested.address.street = 'new street';
}

// =============================================================================
// Test 5: Array fields
// =============================================================================

interface UserWithArrays {
  readonly id: string
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly version: number
  readonly tags: readonly string[]
  readonly scores: number[]
}

declare const lockedArrays: Lock<UserWithArrays>;

function testArrayFields() {
  // Array field itself should be assignable
  lockedArrays.tags = ['new', 'tags'];
  lockedArrays.scores = [1, 2, 3];

  // Mutable array should allow push
  lockedArrays.scores.push(4);

  // Readonly array should still be readonly (we only removed readonly from field, not array content)
  // @ts-expect-error - readonly array cannot be pushed to
  lockedArrays.tags.push('new');
}

// =============================================================================
// Test 6: Union types
// =============================================================================

interface UserWithUnion {
  readonly id: string
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly version: number
  readonly status: 'active' | 'inactive' | 'banned'
  readonly data: string | null
}

declare const lockedUnion: Lock<UserWithUnion>;

function testUnionTypes() {
  lockedUnion.status = 'active';
  lockedUnion.status = 'banned';
  lockedUnion.data = 'some data';
  lockedUnion.data = null;
}

// =============================================================================
// Test 7: Persistent<T> wrapper
// =============================================================================

// Simulating what defineModel produces
interface UserData {
  name: string
  email: string
}

type PersistentUser = SystemFields & UserData & { readonly [PERSISTENT]: true };

declare const lockedPersistent: Lock<PersistentUser>;

function testPersistentWrapper() {
  // Domain fields should be mutable
  lockedPersistent.name = 'new name';
  lockedPersistent.email = 'new@email.com';

  // id and version are domain fields in this interface, mutable under Lock
  lockedPersistent.id = 'new-id';
  lockedPersistent.version = 2;

  // PERSISTENT symbol should remain readonly
  // @ts-expect-error - PERSISTENT symbol is readonly
  lockedPersistent[PERSISTENT] = false;
}

// =============================================================================
// Test 8: Lock metadata and disposal
// =============================================================================

function testLockMetadata() {
  // Lock should have __lock metadata
  const meta: LockMetadata = lockedBasicUser.__lock;

  // __lock should be readonly
  // @ts-expect-error - __lock is readonly
  lockedBasicUser.__lock = {} as LockMetadata;

  // Lock should be disposable
  lockedBasicUser[Symbol.dispose]();
}

// =============================================================================
// Test 9: Non-system fields with same names shouldn't be affected
// =============================================================================

interface WeirdEntity {
  readonly id: string // system field
  readonly createdAt: Date // system field
  readonly updatedAt: Date // system field
  readonly version: number // system field
  readonly createdBy: string // NOT a system field, should be mutable
  readonly updatedBy: string // NOT a system field, should be mutable
  readonly versionTag: string // NOT a system field (different from 'version')
}

declare const lockedWeird: Lock<WeirdEntity>;

function testNonSystemFieldsWithSimilarNames() {
  // These look similar to system fields but are domain fields
  lockedWeird.createdBy = 'user-123';
  lockedWeird.updatedBy = 'user-456';
  lockedWeird.versionTag = 'v2.0';

  // id and version are regular fields in this interface, mutable under Lock
  lockedWeird.id = 'x';
  lockedWeird.version = 2;
}

// =============================================================================
// Test 10: Empty/minimal objects
// =============================================================================

interface MinimalEntity {
  readonly id: string
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly version: number
}

declare const lockedMinimal: Lock<MinimalEntity>;

function testMinimalEntity() {
  // All fields are mutable under Lock
  const _id: string = lockedMinimal.id;
  lockedMinimal.id = 'x';
}

// =============================================================================
// Test 11: Index signatures
// =============================================================================

interface EntityWithIndex {
  readonly id: string
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly version: number
  readonly [key: string]: unknown
}

declare const lockedIndex: Lock<EntityWithIndex>;

function testIndexSignature() {
  // Index signature should allow setting arbitrary keys
  lockedIndex['customField'] = 'value';
  lockedIndex['anotherField'] = 123;

  // id is mutable under Lock
  lockedIndex.id = 'x';
}

// =============================================================================
// Test 12: Generic Lock function signature
// =============================================================================

// This simulates how lockService.acquire works
declare function acquire<T>(obj: T): Lock<T>;

function testGenericLock() {
  const user: BasicUser = {
    id: '1',
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1,
    name: 'Test',
    email: 'test@example.com',
  };

  const locked = acquire(user);

  // Domain fields mutable
  locked.name = 'changed';
  locked.email = 'changed@example.com';

  // id is mutable under Lock
  locked.id = 'new';
}

// =============================================================================
// Test 13: Readonly arrays vs mutable arrays
// =============================================================================

interface EntityWithReadonlyArray {
  readonly id: string
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly version: number
  readonly tags: readonly string[]
  readonly mutableTags: string[]
}

declare const lockedWithArrays: Lock<EntityWithReadonlyArray>;

function testReadonlyArrays() {
  // Can reassign the array field itself
  lockedWithArrays.tags = ['new', 'tags'];
  lockedWithArrays.mutableTags = ['new', 'tags'];

  // Mutable array allows push
  lockedWithArrays.mutableTags.push('another');

  // Readonly array content stays readonly
  // @ts-expect-error - readonly array cannot be pushed
  lockedWithArrays.tags.push('nope');
}

// =============================================================================
// Test 14: Function properties
// =============================================================================

interface EntityWithFunctions {
  readonly id: string
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly version: number
  readonly callback: () => void
  readonly transformer: (x: number) => string
}

declare const lockedWithFunctions: Lock<EntityWithFunctions>;

function testFunctionProperties() {
  // Can call functions
  lockedWithFunctions.callback();
  const result: string = lockedWithFunctions.transformer(42);

  // Can reassign function properties
  lockedWithFunctions.callback = () => console.log('new callback');
  lockedWithFunctions.transformer = (x) => `value: ${x}`;
}

// =============================================================================
// Test 15: Discriminated unions
// =============================================================================

interface BaseEntity {
  readonly id: string
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly version: number
}

interface SuccessEntity extends BaseEntity {
  readonly status: 'success'
  readonly data: string
}

interface ErrorEntity extends BaseEntity {
  readonly status: 'error'
  readonly error: string
}

type StatusEntity = SuccessEntity | ErrorEntity;

declare const lockedUnionEntity: Lock<StatusEntity>;

function testDiscriminatedUnion() {
  // Can read discriminant
  if (lockedUnionEntity.status === 'success') {
    // Can mutate success-specific field
    lockedUnionEntity.data = 'new data';
  } else {
    // Can mutate error-specific field
    lockedUnionEntity.error = 'new error';
  }

  // id is mutable under Lock
  lockedUnionEntity.id = 'x';
}

// =============================================================================
// Test 16: Intersection types
// =============================================================================

interface Timestamped {
  readonly timestamp: Date
}

interface Named {
  readonly name: string
}

type IntersectionEntity = BaseEntity & Timestamped & Named;

declare const lockedIntersection: Lock<IntersectionEntity>;

function testIntersectionTypes() {
  // All non-system fields should be mutable
  lockedIntersection.timestamp = new Date();
  lockedIntersection.name = 'new name';

  // id is mutable under Lock
  lockedIntersection.id = 'x';
}

// =============================================================================
// Test 17: Mapped types preserved
// =============================================================================

interface EntityWithPartial {
  readonly id: string
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly version: number
  readonly settings: Partial<{ theme: string; lang: string }>
}

declare const lockedPartial: Lock<EntityWithPartial>;

function testPartialFields() {
  // Can mutate the partial field
  lockedPartial.settings = { theme: 'dark' };
  lockedPartial.settings = { theme: 'light', lang: 'en' };
  lockedPartial.settings = {};
}

// =============================================================================
// Test 18: Tuple types
// =============================================================================

interface EntityWithTuple {
  readonly id: string
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly version: number
  readonly coordinates: readonly [number, number]
  readonly mutableCoords: [number, number]
}

declare const lockedTuple: Lock<EntityWithTuple>;

function testTupleTypes() {
  // Can reassign tuple field
  lockedTuple.coordinates = [1, 2];
  lockedTuple.mutableCoords = [3, 4];

  // Mutable tuple allows element assignment
  lockedTuple.mutableCoords[0] = 10;

  // Readonly tuple element assignment fails
  // @ts-expect-error - readonly tuple elements
  lockedTuple.coordinates[0] = 10;
}

// =============================================================================
// Test 19: Never and unknown types
// =============================================================================

interface EntityWithSpecialTypes {
  readonly id: string
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly version: number
  readonly anything: unknown
  readonly nothing?: never
}

declare const lockedSpecial: Lock<EntityWithSpecialTypes>;

function testSpecialTypes() {
  // Unknown can be assigned anything
  lockedSpecial.anything = 42;
  lockedSpecial.anything = 'string';
  lockedSpecial.anything = { nested: true };
}

// =============================================================================
// Test 20: Class instances
// =============================================================================

class UserClass {
  readonly id: string = '';
  readonly createdAt: Date = new Date();
  readonly updatedAt: Date = new Date();
  readonly version: number = 0;
  readonly email: string = '';

  constructor(email: string) {
    this.email = email;
  }

  getEmailDomain(): string {
    return this.email.split('@')[1];
  }
}

declare const lockedClass: Lock<UserClass>;

function testClassInstance() {
  // Domain field mutable
  lockedClass.email = 'new@example.com';

  // Method still works
  const domain: string = lockedClass.getEmailDomain();

  // id is mutable under Lock
  lockedClass.id = 'x';
}

// =============================================================================
// All tests pass if this file compiles!
// =============================================================================

export {};
