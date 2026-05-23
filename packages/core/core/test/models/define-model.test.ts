/**
 * Tests for defineModel and field builders
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';

import {
  z,
  defineModel,

  field,
  isModelClass,
  getModelFields,
  getModelName,
  Reference,
  References,
  isReference,
  isReferences,
  isPersistent,
  isLocked,
  type Persistent,
  type Lock,
  FIELD_DEF,
  MODEL_DEF,
  MODEL_NAME,
  MODEL_FIELDS,
  PERSISTENT,
  LOCK,
} from '../../src/models/index.js';

// =============================================================================
// defineModel Tests
// =============================================================================

describe('defineModel', () => {
  test('should create a model class with name', () => {
    class User extends defineModel({
      email: field.string(),
      name: field.string(),
    }) {}

    assert.strictEqual(User.name, 'User');
    assert.strictEqual(getModelName(User), 'User');
    assert.ok(isModelClass(User));
  });

  test('should allow instantiation with new', () => {
    class User extends defineModel({
      email: field.string(),
      name: field.string(),
    }) {}

    const user = new User({ email: 'test@example.com', name: 'Test User' });

    assert.strictEqual(user.email, 'test@example.com');
    assert.strictEqual(user.name, 'Test User');
  });

  test('should build field definitions', () => {
    class User extends defineModel({
      email: field.string().max(255).unique(),
      age: field.int().optional(),
      active: field.boolean().default(true),
    }) {}

    const fields = getModelFields(User);

    assert.ok(FIELD_DEF in fields.email);
    assert.strictEqual(fields.email.type, 'string');
    assert.strictEqual(fields.email.maxLength, 255);
    assert.strictEqual(fields.email.unique, true);

    assert.strictEqual(fields.age.type, 'int');
    assert.strictEqual(fields.age.optional, true);

    assert.strictEqual(fields.active.type, 'boolean');
    assert.strictEqual(fields.active.defaultValue, true);
  });

  test('should have static ref method for tagged template', () => {
    class User extends defineModel({
      name: field.string(),
    }) {}

    const ref = User.ref`user-123`;

    assert.ok(isReference(ref));
    assert.strictEqual(ref.identifier, 'user-123');
  });

  test('should support dynamic IDs in ref template', () => {
    class User extends defineModel({
      name: field.string(),
    }) {}

    const userId = 'dynamic-456';
    const ref = User.ref`${userId}`;

    assert.strictEqual(ref.identifier, 'dynamic-456');
  });

  test('should support ref as callable function', () => {
    class User extends defineModel({
      name: field.string(),
    }) {}

    // Called as function with string argument
    const ref = User.ref('user-789');

    assert.ok(isReference(ref));
    assert.strictEqual(ref.identifier, 'user-789');
  });

  test('should support ref as Zod schema for validation', () => {
    class Author extends defineModel({
      name: field.string(),
    }) {}

    // Use Author.ref directly in a Zod schema
    const schema = z.object({
      title: z.string(),
      author: z.ref(Author),
    });

    // Parse should transform string → Reference
    const result = schema.parse({
      title: 'My Post',
      author: 'author-123',
    });

    assert.strictEqual(result.title, 'My Post');
    assert.ok(isReference(result.author));
    assert.strictEqual(result.author.identifier, 'author-123');
  });

  test('should support ref Zod schema in arrays', () => {
    class Tag extends defineModel({
      name: field.string(),
    }) {}

    const schema = z.object({
      tags: z.array(z.ref(Tag)),
    });

    const result = schema.parse({
      tags: ['tag-1', 'tag-2', 'tag-3'],
    });

    assert.strictEqual(result.tags.length, 3);
    assert.ok(result.tags.every(t => isReference(t)));
    assert.deepStrictEqual(result.tags.map(t => t.identifier), ['tag-1', 'tag-2', 'tag-3']);
  });

  test('should reject non-string input in Zod schema', () => {
    class User extends defineModel({
      name: field.string(),
    }) {}

    const schema = z.object({
      user: z.ref(User),
    });

    // Should fail with number
    const result1 = schema.safeParse({ user: 123 });
    assert.strictEqual(result1.success, false);

    // Should fail with object
    const result2 = schema.safeParse({ user: { id: '123' } });
    assert.strictEqual(result2.success, false);

    // Should fail with null
    const result3 = schema.safeParse({ user: null });
    assert.strictEqual(result3.success, false);
  });

  test('should support Zod .optional() chaining', () => {
    class Author extends defineModel({
      name: field.string(),
    }) {}

    const schema = z.object({
      title: z.string(),
      author: z.ref(Author).optional(),
    });

    // With author
    const result1 = schema.parse({ title: 'Post 1', author: 'author-1' });
    assert.ok(isReference(result1.author));
    assert.strictEqual(result1.author?.identifier, 'author-1');

    // Without author
    const result2 = schema.parse({ title: 'Post 2' });
    assert.strictEqual(result2.author, undefined);
  });

  test('should support Zod .nullable() chaining', () => {
    class Author extends defineModel({
      name: field.string(),
    }) {}

    const schema = z.object({
      title: z.string(),
      author: z.ref(Author).nullable(),
    });

    // With author
    const result1 = schema.parse({ title: 'Post 1', author: 'author-1' });
    assert.ok(isReference(result1.author));

    // With null author
    const result2 = schema.parse({ title: 'Post 2', author: null });
    assert.strictEqual(result2.author, null);
  });

  test('should return same Reference object for same ID (memoization)', () => {
    class User extends defineModel({
      name: field.string(),
    }) {}

    // Same ID via different methods should return same object
    const ref1 = User.ref`user-123`;
    const ref2 = User.ref`user-123`;
    const ref3 = User.ref('user-123');

    assert.strictEqual(ref1, ref2, 'Tagged template calls should return same object');
    assert.strictEqual(ref2, ref3, 'Callable and tagged template should return same object');

    // Different IDs should return different objects
    const ref4 = User.ref`user-456`;
    assert.notStrictEqual(ref1, ref4, 'Different IDs should return different objects');
  });

  test('should return same Reference from Zod parsing as direct call', () => {
    class Author extends defineModel({
      name: field.string(),
    }) {}

    const schema = z.object({ author: z.ref(Author) });

    // Create ref directly
    const directRef = Author.ref('author-abc');

    // Parse via Zod
    const parsed = schema.parse({ author: 'author-abc' });

    // Should be the same object
    assert.strictEqual(directRef, parsed.author, 'Zod parsed ref should be same as direct ref');
  });

  test('should have static refs method for multiple IDs', () => {
    class Tag extends defineModel({
      name: field.string(),
    }) {}

    const refs = Tag.refs('tag-1', 'tag-2', 'tag-3');

    assert.ok(isReferences(refs));
    assert.deepStrictEqual([...refs.identifiers], ['tag-1', 'tag-2', 'tag-3']);
    assert.strictEqual(refs.length, 3);
  });

  test('should have MODEL_DEF symbol marker', () => {
    class User extends defineModel({
      name: field.string(),
    }) {}

    assert.ok(MODEL_DEF in User);
    assert.strictEqual((User as unknown as Record<symbol, unknown>)[MODEL_DEF], true);
  });
});

// =============================================================================
// Field Builder Tests
// =============================================================================

describe('field builders', () => {
  describe('string', () => {
    test('should create string field', () => {
      const f = field.string().build();
      assert.strictEqual(f.type, 'string');
      assert.strictEqual(f.optional, false);
    });

    test('should support max length', () => {
      const f = field.string().max(255).build();
      assert.strictEqual(f.maxLength, 255);
    });

    test('should support fixed length', () => {
      const f = field.string().fixed(10).build();
      assert.strictEqual(f.fixedLength, 10);
    });
  });

  describe('numbers', () => {
    test('should create int field', () => {
      const f = field.int().build();
      assert.strictEqual(f.type, 'int');
    });

    test('should create decimal field with precision/scale', () => {
      const f = field.decimal(10, 2).build();
      assert.strictEqual(f.type, 'decimal');
      assert.strictEqual(f.precision, 10);
      assert.strictEqual(f.scale, 2);
    });

    test('should create bigint field', () => {
      const f = field.bigint().build();
      assert.strictEqual(f.type, 'bigint');
    });
  });

  describe('modifiers', () => {
    test('should support optional', () => {
      const f = field.string().optional().build();
      assert.strictEqual(f.optional, true);
    });

    test('should support default value', () => {
      const f = field.boolean().default(true).build();
      assert.strictEqual(f.defaultValue, true);
    });

    test('should support default factory', () => {
      const factory = () => new Date();
      const f = field.timestamp().default(factory).build();
      assert.strictEqual(f.defaultValue, factory);
    });

    test('should support unique', () => {
      const f = field.string().unique().build();
      assert.strictEqual(f.unique, true);
    });

    test('should support index', () => {
      const f = field.string().index().build();
      assert.strictEqual(f.indexed, true);
    });

    test('should support primaryKey', () => {
      const f = field.uuid().primaryKey().build();
      assert.strictEqual(f.primaryKey, true);
    });

    test('should chain modifiers', () => {
      const f = field.string().max(100).optional().unique().index().build();
      assert.strictEqual(f.maxLength, 100);
      assert.strictEqual(f.optional, true);
      assert.strictEqual(f.unique, true);
      assert.strictEqual(f.indexed, true);
    });
  });

  describe('date/time', () => {
    test('should create timestamp field', () => {
      const f = field.timestamp().build();
      assert.strictEqual(f.type, 'timestamp');
    });

    test('should create date field', () => {
      const f = field.date().build();
      assert.strictEqual(f.type, 'date');
    });

    test('should create time field', () => {
      const f = field.time().build();
      assert.strictEqual(f.type, 'time');
    });

    test('should create createdAt field', () => {
      const f = field.createdAt().build();
      assert.strictEqual(f.type, 'createdAt');
    });

    test('should create updatedAt field', () => {
      const f = field.updatedAt().build();
      assert.strictEqual(f.type, 'updatedAt');
    });

    test('should create deletedAt field (optional by default)', () => {
      const f = field.deletedAt().build();
      assert.strictEqual(f.type, 'deletedAt');
      assert.strictEqual(f.optional, true);
    });
  });

  describe('complex types', () => {
    test('should create enum field', () => {
      const f = field.enum('Status', ['active', 'inactive', 'pending'] as const).build();
      assert.strictEqual(f.type, 'enum');
      assert.strictEqual(f.enumName, 'Status');
      assert.deepStrictEqual([...f.enumValues!], ['active', 'inactive', 'pending']);
    });

    test('should create array field', () => {
      const f = field.array(field.string()).build();
      assert.strictEqual(f.type, 'array');
      assert.ok(f.arrayOf);
      assert.strictEqual(f.arrayOf!.type, 'string');
    });

    test('should create json field', () => {
      const f = field.json<{ foo: string }>().build();
      assert.strictEqual(f.type, 'json');
    });

    test('should create jsonb field', () => {
      const f = field.jsonb().build();
      assert.strictEqual(f.type, 'jsonb');
    });

    test('should create bytes field', () => {
      const f = field.bytes().build();
      assert.strictEqual(f.type, 'bytes');
    });
  });

  describe('references', () => {
    test('should create ref field', () => {
      class Author extends defineModel({ name: field.string() }) {}
      const f = field.ref(Author).build();
      assert.strictEqual(f.type, 'ref');
      assert.ok(f.refTarget);
      assert.strictEqual(f.refTarget!(), Author);
    });

    test('should create refs field', () => {
      class Tag extends defineModel({ name: field.string() }) {}
      const f = field.refs(Tag).build();
      assert.strictEqual(f.type, 'refs');
      assert.ok(f.refTarget);
      assert.strictEqual(f.refTarget!(), Tag);
    });

    test('should support lazy ref for self-reference', () => {
      // Self-referencing model (like a tree structure)
       
      class Category extends defineModel({
        name: field.string(),
        parent: field.ref((): any => Category).optional(),
      }) {}

      const fields = getModelFields(Category);
      assert.strictEqual(fields.parent.type, 'ref');
      assert.strictEqual(fields.parent.refTarget!(), Category);
    });
  });
});

// =============================================================================
// Reference Tests
// =============================================================================

describe('Reference', () => {
  test('should create pre-resolved reference', () => {
    const entity = { name: 'Test' } as any;
    const ref = Reference.resolved('resolved-1', entity);

    assert.strictEqual(ref.identifier, 'resolved-1');
    assert.strictEqual(ref.isLoaded, true);
    assert.strictEqual(ref.value.name, 'Test');
  });

  test('should be PromiseLike with pre-resolved value', async () => {
    const entity = { name: 'Test' } as any;
    const ref = Reference.resolved('resolved-1', entity);

    const result = await ref;
    assert.deepStrictEqual(result, entity);
  });
});

describe('References', () => {
  test('should store multiple identifiers', () => {
    const refs = new References<{ name: string }>(['a', 'b', 'c']);
    assert.deepStrictEqual([...refs.identifiers], ['a', 'b', 'c']);
    assert.strictEqual(refs.length, 3);
    assert.strictEqual(refs.isLoaded, false);
  });

  test('should throw when accessing values before resolve', () => {
    const refs = new References<{ name: string }>(['a', 'b']);
    assert.throws(() => refs.values, /not loaded/i);
  });

  test('should create pre-resolved references', () => {
    const entities = [
      { name: 'A' },
      { name: 'B' },
    ] as any;
    const refs = References.resolved(['a', 'b'], entities);

    assert.strictEqual(refs.isLoaded, true);
    assert.strictEqual(refs.values.length, 2);
  });
});

// =============================================================================
// Type Tests (compile-time only)
// =============================================================================

describe('Type inference', () => {
  test('should infer model type correctly', () => {
    class User extends defineModel({
      email: field.string(),
      age: field.int().optional(),
      active: field.boolean().default(true),
    }) {}

    // Create instance to verify type inference
    const user = new User({
      email: 'test@example.com',
      age: undefined, // optional
      active: true,
    });

    // Type assertions (compile-time)
    const _email: string = user.email;
    const _age: number | undefined = user.age;
    const _active: boolean = user.active;

    assert.ok(true); // If it compiles, it works
  });

  test('Transient should not have id', () => {
    class User extends defineModel({
      name: field.string(),
    }) {}

    const user = new User({ name: 'Test' });

    // Transient<User> has id?: undefined
    assert.strictEqual((user as { id?: string }).id, undefined);
  });

  test('Persistent type should include domain fields and PERSISTENT brand', () => {
    class User extends defineModel({
      name: field.string(),
    }) {}

    // Persistent<User> extracts the data type from the ModelClass
    type PersistedUser = Persistent<User>;

    // Create a mock persisted user to verify the type shape
    // Use unknown cast because Persistent includes instance symbols that
    // are tricky to mock in plain objects
    const persistedUser = {
      name: 'Test',
      [PERSISTENT]: true as const,
      [Symbol.dispose]: () => {},
    } as unknown as PersistedUser;

    assert.strictEqual(persistedUser.name, 'Test');
  });
});

// =============================================================================
// Runtime Symbol Tests
// =============================================================================

describe('Runtime symbols and type guards', () => {
  test('new instances should not be persistent', () => {
    class User extends defineModel({
      name: field.string(),
    }) {}

    const user = new User({ name: 'Test' });

    assert.ok(!isPersistent(user));
    assert.ok(!isLocked(user));
  });

  test('isPersistent should detect persistent instances', () => {
    // Create a mock persistent object (would normally come from storage)
    const persistentUser = {
      id: '123',
      createdAt: new Date(),
      updatedAt: new Date(),
      version: 1,
      name: 'Test',
      [PERSISTENT]: true,
    };

    assert.ok(isPersistent(persistentUser));
    assert.ok(!isLocked(persistentUser));
  });

  test('isLocked should detect locked instances', () => {
    // Create a mock locked object (would normally come from lock operation)
    // Uses __lock property as per features/lock/types.ts Lock<T> definition
    const lockedUser = {
      id: '123',
      name: 'Test',
      __lock: {
        lockedAt: Date.now(),
        expiresAt: Date.now() + 60000,
        lockedBy: 'instance-1',
      },
      [Symbol.dispose]: () => {},
    };

    assert.ok(isLocked(lockedUser));
    assert.ok(!isPersistent(lockedUser));
  });

  test('type guards should return false for plain objects', () => {
    const plainObject = { name: 'Test' };

    assert.ok(!isPersistent(plainObject));
    assert.ok(!isLocked(plainObject));
  });

  test('type guards should return false for null/undefined', () => {
    assert.ok(!isPersistent(null));
    assert.ok(!isPersistent(undefined));
    assert.ok(!isLocked(null));
    assert.ok(!isLocked(undefined));
  });
});

// =============================================================================
// Reference Field Getter/Setter Tests
// =============================================================================

describe('Reference field getter/setter', () => {
  test('ref field should accept Reference from tagged template', () => {
    class Author extends defineModel({ name: field.string() }) {}
    class Post extends defineModel({
      title: field.string(),
      author: field.ref(Author),
    }) {}

    const authorRef = Author.ref`author-123`;
    const post = new Post({ title: 'Hello', author: authorRef });

    assert.ok(isReference(post.author));
    assert.strictEqual(post.author.identifier, 'author-123');
  });

  test('ref field should accept Reference from callable function', () => {
    class Author extends defineModel({ name: field.string() }) {}
    class Post extends defineModel({
      title: field.string(),
      author: field.ref(Author),
    }) {}

    // Using callable syntax: Author.ref('id')
    const post = new Post({ title: 'Hello', author: Author.ref('author-456') });

    assert.ok(isReference(post.author));
    assert.strictEqual(post.author.identifier, 'author-456');
  });

  test('ref field assignment should work with callable function', () => {
    class Author extends defineModel({ name: field.string() }) {}
    class Post extends defineModel({
      title: field.string(),
      author: field.ref(Author),
    }) {}

    const post = new Post({ title: 'Hello', author: Author.ref`temp` });

    // Re-assign using callable syntax
    (post as any).author = Author.ref('author-789');

    assert.ok(isReference(post.author));
    assert.strictEqual(post.author.identifier, 'author-789');
  });

  test('ref field should reject string ID with helpful error', () => {
    class Author extends defineModel({ name: field.string() }) {}
    class Post extends defineModel({
      title: field.string(),
      author: field.ref(Author),
    }) {}

    // Passing string ID directly should throw with helpful message
    assert.throws(
      () => new Post({ title: 'Hello', author: 'author-456' as any }),
      /Cannot assign string.*Use Model\.ref/,
    );
  });

  test('ref field should accept a Reference', () => {
    class Author extends defineModel({ name: field.string() }) {}
    class Post extends defineModel({
      title: field.string(),
      author: field.ref(Author),
    }) {}

    // Pass a Reference object
    const post = new Post({ title: 'Hello', author: Author.ref('author-789') as any });

    assert.ok(isReference(post.author));
    assert.strictEqual(post.author.identifier, 'author-789');
  });

  test('ref field setter should work after construction', () => {
    class Author extends defineModel({ name: field.string() }) {}
    class Post extends defineModel({
      title: field.string(),
      author: field.ref(Author),
    }) {}

    const post = new Post({ title: 'Hello', author: Author.ref`author-1` });

    // Change the author using Model.ref
    (post as any).author = Author.ref`author-2`;
    assert.strictEqual(post.author.identifier, 'author-2');

    // Change to a different Reference
    (post as any).author = Author.ref`author-3`;
    assert.strictEqual(post.author.identifier, 'author-3');

    // String assignment should throw
    assert.throws(() => {
      (post as any).author = 'author-4';
    }, /Cannot assign string/);
  });

  test('refs field should accept References', () => {
    class Tag extends defineModel({ name: field.string() }) {}
    class Post extends defineModel({
      title: field.string(),
      tags: field.refs(Tag),
    }) {}

    const tagRefs = Tag.refs('tag-1', 'tag-2');
    const post = new Post({ title: 'Hello', tags: tagRefs });

    assert.ok(isReferences(post.tags));
    assert.deepStrictEqual([...post.tags.identifiers], ['tag-1', 'tag-2']);
  });

  test('refs field should reject array of string IDs with helpful error', () => {
    class Tag extends defineModel({ name: field.string() }) {}
    class Post extends defineModel({
      title: field.string(),
      tags: field.refs(Tag),
    }) {}

    // Passing array of string IDs directly should throw with helpful message
    assert.throws(
      () => new Post({ title: 'Hello', tags: ['tag-a', 'tag-b', 'tag-c'] as any }),
      /Cannot assign string array.*Use Model\.refs/,
    );
  });

  test('refs field should accept References object', () => {
    class Tag extends defineModel({ name: field.string() }) {}
    class Post extends defineModel({
      title: field.string(),
      tags: field.refs(Tag),
    }) {}

    const post = new Post({ title: 'Hello', tags: Tag.refs('tag-x', 'tag-y') as any });

    assert.ok(isReferences(post.tags));
    assert.deepStrictEqual([...post.tags.identifiers], ['tag-x', 'tag-y']);
  });

  test('refs field should handle empty array', () => {
    class Tag extends defineModel({ name: field.string() }) {}
    class Post extends defineModel({
      title: field.string(),
      tags: field.refs(Tag),
    }) {}

    const post = new Post({ title: 'Hello', tags: [] as any });

    assert.ok(isReferences(post.tags));
    assert.strictEqual(post.tags.length, 0);
  });

  test('refs field setter should work after construction', () => {
    class Tag extends defineModel({ name: field.string() }) {}
    class Post extends defineModel({
      title: field.string(),
      tags: field.refs(Tag),
    }) {}

    const post = new Post({ title: 'Hello', tags: Tag.refs('tag-1') });

    // Change the tags using Model.refs
    (post as any).tags = Tag.refs('tag-2', 'tag-3');
    assert.deepStrictEqual([...post.tags.identifiers], ['tag-2', 'tag-3']);

    // Change to another References object
    (post as any).tags = Tag.refs('tag-4', 'tag-5');
    assert.deepStrictEqual([...post.tags.identifiers], ['tag-4', 'tag-5']);

    // String array assignment should throw
    assert.throws(() => {
      (post as any).tags = ['tag-6', 'tag-7'];
    }, /Cannot assign string array/);
  });

  test('regular fields should still work normally', () => {
    class Author extends defineModel({ name: field.string() }) {}
    class Post extends defineModel({
      title: field.string(),
      views: field.int().default(0),
      author: field.ref(Author),
    }) {}

    const post = new Post({
      title: 'Hello World',
      views: 100,
      author: Author.ref`author-1`,
    });

    // Regular fields work as expected
    assert.strictEqual(post.title, 'Hello World');
    assert.strictEqual(post.views, 100);

    // Can modify regular fields
    (post as any).title = 'Updated Title';
    assert.strictEqual(post.title, 'Updated Title');
  });
});

// =============================================================================
// Model Methods Tests
// =============================================================================

describe('Model methods', () => {
  test('model without methods should work normally', () => {
    class User extends defineModel({
      name: field.string(),
    }) {}

    const user = new User({ name: 'Test' });
    assert.strictEqual(user.name, 'Test');
  });

  test('methods can be added via class extension', () => {
    class User extends defineModel({
      name: field.string(),
      role: field.enum('Role', ['admin', 'user'] as const),
    }) {
      isAdmin() {
        return this.role === 'admin';
      }
    }

    const admin = new User({ name: 'Admin', role: 'admin' });
    const user = new User({ name: 'User', role: 'user' });

    assert.strictEqual(admin.isAdmin(), true);
    assert.strictEqual(user.isAdmin(), false);
  });
});

// =============================================================================
// Model DI Injection Tests
// =============================================================================

describe('Model inject (config form)', () => {
  test('defineModel accepts config form with fields', () => {
    class User extends defineModel({
      fields: {
        email: field.string(),
        name: field.string(),
      },
    }) {}

    assert.ok(isModelClass(User));
    assert.ok(User.fields);
    const user = new User({ email: 'test@example.com', name: 'Test' });
    assert.strictEqual(user.email, 'test@example.com');
  });

  test('defineModel config form stores MODEL_INJECT on the class', async () => {
    const { MODEL_INJECT } = await import('../../src/models/symbols.js');
    const { defineService } = await import('../../src/core/service.js');

    class PaymentService extends defineService({
      inject: {},
      factory: () => ({ charge: (amount: number) => `charged ${amount}` }),
    }) {}

    class Order extends defineModel({
      fields: {
        amount: field.decimal(10, 2),
        status: field.string(),
      },
      inject: {
        payments: PaymentService,
      },
    }) {}

    assert.ok(MODEL_INJECT in Order);
    const injectConfig = (Order as any)[MODEL_INJECT];
    assert.strictEqual(injectConfig.payments, PaymentService);
  });

  test('defineModel config form class methods work', () => {
    class Order extends defineModel({
      fields: {
        amount: field.decimal(10, 2),
      },
    }) {
      validate() {
        return Number(this.amount) > 0;
      }
    }

    const order = new Order({ amount: '99.99' });
    assert.strictEqual(order.validate(), true);

    const bad = new Order({ amount: '0' });
    assert.strictEqual(bad.validate(), false);
  });

  test('createInMemoryModel wires prototype for class methods on entities', async () => {
    const { createInMemoryModel } = await import('../../src/models/in-memory/in-memory-model.js');

    class Product extends defineModel({
      fields: {
        name: field.string(),
        price: field.decimal(10, 2),
      },
    }) {
      isExpensive() {
        return Number(this.price) > 100;
      }
    }

    const MemProduct = createInMemoryModel(Product);
    const repo = MemProduct.repository();

    const saved = await repo.insert({ name: 'Widget', price: '50.00' } as any);
    // Persistent entity should have class methods via prototype
    assert.strictEqual(typeof (saved as any).isExpensive, 'function');
    assert.strictEqual((saved as any).isExpensive(), false);

    const expensive = await repo.insert({ name: 'Gadget', price: '200.00' } as any);
    assert.strictEqual((expensive as any).isExpensive(), true);
  });

  test('wireModelPrototypes resolves inject deps onto model service', async () => {
    const { MODEL_SERVICE, MODEL_INJECT } = await import('../../src/models/symbols.js');
    const { Container, defineService } = await import('../../src/core/service.js');
    const { registerModelForInjection } = await import('../../src/models/define-model.js');
    const { createInMemoryModel } = await import('../../src/models/in-memory/in-memory-model.js');

    class PricingService extends defineService({
      inject: {},
      factory: () => ({ getDiscount: () => 0.1 }),
    }) {}

    class Item extends defineModel({
      fields: {
        name: field.string(),
        price: field.decimal(10, 2),
      },
      inject: {
        pricing: PricingService,
      },
    }) {
      discountedPrice() {
        return Number(this.price) * (1 - (this as any).pricing.getDiscount());
      }
    }

    // Register the model (normally done by createInMemoryModel/createPgModel)
    registerModelForInjection(Item as any);

    // Simulate boot: resolve services, then wire model prototypes
    const container = new Container();
    container.register(PricingService);
    await container.resolveAll();
    await container.wireModelPrototypes();

    // MODEL_SERVICE should be set on the model class
    const modelService = (Item as any)[MODEL_SERVICE];
    assert.ok(modelService, 'MODEL_SERVICE should be set after wireModelPrototypes');
    assert.strictEqual(typeof modelService.pricing.getDiscount, 'function');

    // Create entity via repo — should have inject deps on prototype
    const MemItem = createInMemoryModel(Item);
    const repo = MemItem.repository();
    const saved = await repo.insert({ name: 'Widget', price: '100.00' } as any);

    assert.strictEqual(typeof (saved as any).discountedPrice, 'function');
    assert.strictEqual((saved as any).discountedPrice(), 90);
    assert.strictEqual(typeof (saved as any).pricing.getDiscount, 'function');
  });

  test('Model.create() produces instances with prototype chain', async () => {
    const { MODEL_SERVICE } = await import('../../src/models/symbols.js');
    const { Container, defineService } = await import('../../src/core/service.js');
    const { registerModelForInjection } = await import('../../src/models/define-model.js');

    class DiscountEngine extends defineService({
      inject: {},
      factory: () => ({ rate: () => 0.15 }),
    }) {}

    class Widget extends defineModel({
      fields: {
        name: field.string(),
        price: field.decimal(10, 2),
      },
      inject: {
        discounts: DiscountEngine,
      },
    }) {
      discountedPrice() {
        return Number(this.price) * (1 - (this as any).discounts.rate());
      }
    }

    registerModelForInjection(Widget as any);

    const container = new Container();
    container.register(DiscountEngine);
    await container.resolveAll();
    await container.wireModelPrototypes();

    const widget = (Widget as any).create({ name: 'Gizmo', price: '200.00' });
    assert.strictEqual(widget.name, 'Gizmo');
    assert.strictEqual(widget.price, '200.00');
    assert.strictEqual(typeof widget.discountedPrice, 'function');
    assert.strictEqual(widget.discountedPrice(), 170);
    assert.strictEqual(typeof widget.discounts.rate, 'function');
  });

  test('update() preserves prototype chain on returned entity', async () => {
    const { createInMemoryModel } = await import('../../src/models/in-memory/in-memory-model.js');
    const { MODEL_SERVICE } = await import('../../src/models/symbols.js');
    const { Container, defineService } = await import('../../src/core/service.js');
    const { registerModelForInjection } = await import('../../src/models/define-model.js');

    class TaxService extends defineService({
      inject: {},
      factory: () => ({ rate: () => 0.21 }),
    }) {}

    class Product extends defineModel({
      fields: {
        name: field.string(),
        price: field.decimal(10, 2),
      },
      inject: {
        tax: TaxService,
      },
    }) {
      priceWithTax() {
        return Number(this.price) * (1 + (this as any).tax.rate());
      }
    }

    registerModelForInjection(Product as any);
    const container = new Container();
    container.register(TaxService);
    await container.resolveAll();
    await container.wireModelPrototypes();

    const MemProduct = createInMemoryModel(Product);
    const repo = MemProduct.repository();

    const saved = await repo.insert({ name: 'Widget', price: '100.00' } as any);
    assert.strictEqual((saved as any).priceWithTax(), 121);

    const locked = await repo.lock(saved as any);
    const updated = await repo.update(locked! as any, { price: '200.00' } as any);
    // After update, the new entity should STILL have prototype chain
    assert.strictEqual(typeof (updated as any).priceWithTax, 'function');
    assert.strictEqual((updated as any).priceWithTax(), 242);
    assert.strictEqual(typeof (updated as any).tax.rate, 'function');
  });

  test('abstract model support works with defineModel config form', () => {
    abstract class Animal extends defineModel({
      fields: {
        name: field.string(),
        weight: field.decimal(10, 2),
      },
    }) {
      abstract sound(): string;

      describe() {
        return `${this.name} says ${this.sound()}`;
      }
    }

    class Dog extends Animal {
      sound() { return 'woof'; }
    }

    const dog = new Dog({ name: 'Rex', weight: '30.00' });
    assert.strictEqual(dog.describe(), 'Rex says woof');
    assert.strictEqual(dog.sound(), 'woof');
  });

  test('Persistent entities from repo have class methods available', async () => {
    const { createInMemoryModel } = await import('../../src/models/in-memory/in-memory-model.js');

    class Counter extends defineModel({
      fields: {
        name: field.string(),
        count: field.int().default(0),
      },
    }) {
      increment() {
        return (this as any).count + 1;
      }

      isActive() {
        return (this as any).count > 0;
      }
    }

    const MemCounter = createInMemoryModel(Counter);
    const repo = MemCounter.repository();

    const saved = await repo.insert({ name: 'visits', count: 5 } as any);
    assert.strictEqual(typeof (saved as any).increment, 'function');
    assert.strictEqual((saved as any).increment(), 6);
    assert.strictEqual((saved as any).isActive(), true);

    const zero = await repo.insert({ name: 'errors', count: 0 } as any);
    assert.strictEqual((zero as any).isActive(), false);
  });

  test('new Model(data) gives class methods but not inject deps', async () => {
    const { defineService } = await import('../../src/core/service.js');

    class SomeService extends defineService({
      inject: {},
      factory: () => ({ doStuff: () => 'done' }),
    }) {}

    class Thing extends defineModel({
      fields: { name: field.string() },
      inject: { svc: SomeService },
    }) {
      greet() { return `Hi ${this.name}`; }
    }

    // new Thing() gives class methods (via prototype chain)
    const t = new Thing({ name: 'Foo' });
    assert.strictEqual(t.greet(), 'Hi Foo');
    // inject deps are NOT available via new (only via create() or adapter)
    assert.strictEqual((t as any).svc, undefined);
  });

  test('entities without modelClass fallback to plain objects', async () => {
    const { InMemoryRepository } = await import('../../src/models/in-memory/in-memory-repository.js');

    const repo = new InMemoryRepository();
    const saved = await repo.insert({ name: 'test', value: 42 } as any);
    assert.strictEqual((saved as any).name, 'test');
    assert.strictEqual((saved as any).value, 42);
    // No prototype chain — plain object fallback
    assert.strictEqual(Object.getPrototypeOf(saved), Object.prototype);
  });
});

// =============================================================================
// name config
// =============================================================================

describe('defineModel name config', () => {
  test('explicit name overrides class name', () => {
    class User extends defineModel({
      name: 'JustScale_User',
      fields: { email: field.string() },
    }) {}

    assert.strictEqual(User.name, 'User');
    assert.strictEqual(getModelName(User), 'JustScale_User');
  });

  test('without name config, uses class name', () => {
    class Order extends defineModel({
      fields: { amount: field.int() },
    }) {}

    assert.strictEqual(getModelName(Order), 'Order');
  });

  test('fields-only form uses class name', () => {
    class Tag extends defineModel({
      label: field.string(),
    }) {}

    assert.strictEqual(getModelName(Tag), 'Tag');
  });
});

// =============================================================================
// Model.override()
// =============================================================================

describe('Model.override()', () => {
  class User extends defineModel({
    name: 'JustScale_User',
    fields: {
      email: field.string(),
      passwordHash: field.string(),
    },
  }) {}

  test('child has merged fields', () => {
    class AppUser extends User.override({
      fields: { avatarUrl: field.string() },
    }) {}

    const fields = getModelFields(AppUser);
    assert.ok('email' in fields);
    assert.ok('passwordHash' in fields);
    assert.ok('avatarUrl' in fields);
  });

  test('child inherits ref accessor from parent', () => {
    class AppUser extends User.override({
      fields: { avatarUrl: field.string() },
    }) {}

    assert.strictEqual(AppUser.ref, User.ref);
  });

  test('child gets its own MODEL_NAME from class name', () => {
    class AppUser extends User.override({
      fields: { avatarUrl: field.string() },
    }) {}

    assert.strictEqual(getModelName(AppUser), 'AppUser');
    assert.strictEqual(getModelName(User), 'JustScale_User');
  });

  test('child can specify explicit name', () => {
    class AppUser extends User.override({
      name: 'MyApp_User',
      fields: { avatarUrl: field.string() },
    }) {}

    assert.strictEqual(getModelName(AppUser), 'MyApp_User');
  });

  test('shared ref cache — same ID returns same Reference', () => {
    class AppUser extends User.override({
      fields: { avatarUrl: field.string() },
    }) {}

    const ref1 = User.ref('123');
    const ref2 = AppUser.ref('123');
    assert.strictEqual(ref1, ref2);
  });

  test('child field expressions include all fields', () => {
    class AppUser extends User.override({
      fields: { avatarUrl: field.string() },
    }) {}

    assert.ok('email' in AppUser.fields);
    assert.ok('passwordHash' in AppUser.fields);
    assert.ok('avatarUrl' in AppUser.fields);
  });

  test('isModelClass returns true for override models', () => {
    class AppUser extends User.override({
      fields: { avatarUrl: field.string() },
    }) {}

    assert.ok(isModelClass(AppUser));
  });
});

// =============================================================================
// Ref accessor accepts References
// =============================================================================

describe('ref accessor accepts References', () => {
  class Product extends defineModel({
    fields: { name: field.string() },
  }) {}

  test('ref from Reference returns same cached ref', () => {
    const original = Product.ref('abc');
    const fromRef = Product.ref(original as any);

    assert.strictEqual(fromRef, original);
    assert.strictEqual(fromRef.identifier, 'abc');
  });

  test('ref from Reference carries hydration', () => {
    const original = new Reference<unknown>('xyz');
    // Simulate hydration
    const fakeEntity = { name: 'Test' } as any;
    fakeEntity[Symbol.for('justscale:persistent')] = true;
    (original as any)._value = fakeEntity;

    const fromRef = Product.ref(original as any);
    assert.strictEqual(fromRef.identifier, 'xyz');
    assert.ok(fromRef.isLoaded);
  });
});

// =============================================================================
// Wave 1 additional coverage
// =============================================================================

describe('Model.override() — advanced', () => {
  class Base extends defineModel({
    name: 'JustScale_Base',
    fields: {
      email: field.string(),
      role: field.ref((): any => Base),
    },
  }) {}

  test('override with ref field adds getter/setter on child', () => {
    class Extended extends Base.override({
      fields: {
        manager: field.ref((): any => Base),
      },
    }) {}

    const fields = getModelFields(Extended);
    assert.ok('email' in fields);
    assert.ok('role' in fields);
    assert.ok('manager' in fields);
    assert.strictEqual(fields.manager.type, 'ref');
  });

  test('override chaining works (grandchild)', () => {
    class Child extends Base.override({
      fields: { bio: field.string() },
    }) {}

    class GrandChild extends Child.override({
      fields: { avatar: field.string() },
    }) {}

    const fields = getModelFields(GrandChild);
    assert.ok('email' in fields);
    assert.ok('bio' in fields);
    assert.ok('avatar' in fields);
    assert.strictEqual(getModelName(GrandChild), 'GrandChild');
  });

  test('grandchild shares ref accessor with root', () => {
    class Child extends Base.override({
      fields: { bio: field.string() },
    }) {}

    class GrandChild extends Child.override({
      fields: { avatar: field.string() },
    }) {}

    assert.strictEqual(GrandChild.ref, Child.ref);
    assert.strictEqual(Child.ref, Base.ref);

    const ref = Base.ref('same-id');
    assert.strictEqual(Child.ref('same-id'), ref);
    assert.strictEqual(GrandChild.ref('same-id'), ref);
  });

  test('name config with override preserves parent name', () => {
    class NamedModel extends defineModel({
      name: 'JustScale_Named',
      fields: { value: field.string() },
    }) {}

    class Extended extends NamedModel.override({
      fields: { extra: field.string() },
    }) {}

    assert.strictEqual(getModelName(NamedModel), 'JustScale_Named');
    assert.strictEqual(getModelName(Extended), 'Extended');
    assert.strictEqual(NamedModel.name, 'NamedModel');
  });
});

// =============================================================================
// Wave 2: model name registry + applyTypesConfig
// =============================================================================

describe('model name registry', () => {
  test('registerModelByName and getModelByName', async () => {
    const { registerModelByName, getModelByName } = await import('../../src/models/model-name-registry.js');

    class TestWidget extends defineModel({
      fields: { label: field.string() },
    }) {}

    registerModelByName('TestWidget', TestWidget as any);
    const retrieved = getModelByName('TestWidget');
    assert.ok(retrieved);
    assert.strictEqual(retrieved, TestWidget as any);
  });

  test('getModelByName returns undefined for unknown name', async () => {
    const { getModelByName } = await import('../../src/models/model-name-registry.js');
    assert.strictEqual(getModelByName('NonExistent_' + Date.now()), undefined);
  });
});

describe('applyTypesConfig', () => {
  test('transforms matching params to References', async () => {
    const { applyTypesConfig } = await import('../../src/models/apply-types-config.js');

    class Order extends defineModel({
      fields: { amount: field.int() },
    }) {}

    const result = applyTypesConfig(
      { orderRef: 'order-1', other: 'plain' },
      { Order } as any,
    );

    assert.ok(isReference(result.orderRef));
    assert.strictEqual((result.orderRef as Reference<unknown>).identifier, 'order-1');
    assert.strictEqual(result.other, 'plain');
  });

  test('matches lowercase key', async () => {
    const { applyTypesConfig } = await import('../../src/models/apply-types-config.js');

    class Table extends defineModel({
      fields: { name: field.string() },
    }) {}

    const result = applyTypesConfig(
      { table: 'table-1' },
      { Table } as any,
    );

    assert.ok(isReference(result.table));
    assert.strictEqual((result.table as Reference<unknown>).identifier, 'table-1');
  });

  test('matches lowercase + Ref suffix', async () => {
    const { applyTypesConfig } = await import('../../src/models/apply-types-config.js');

    class Table extends defineModel({
      fields: { name: field.string() },
    }) {}

    const result = applyTypesConfig(
      { tableRef: 'table-2' },
      { Table } as any,
    );

    assert.ok(isReference(result.tableRef));
  });

  test('returns params unchanged without types config', async () => {
    const { applyTypesConfig } = await import('../../src/models/apply-types-config.js');

    const params = { id: '123', name: 'test' };
    const result = applyTypesConfig(params);
    assert.strictEqual(result, params);
  });
});
