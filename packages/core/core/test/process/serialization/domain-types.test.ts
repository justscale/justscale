/**
 * Processable protocol — DOMAIN TYPE invariants (edge cases).
 *
 * Pin how domain identities (Reference, References, Persistent, Locked)
 * round-trip through the protocol. These are the types that signal
 * payloads carry in practice and that channels/cluster push across node
 * boundaries.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeProcessable,
  decodeProcessable,
} from '../../../src/process/serialization.js';
import { serializeState, deserializeState } from '../../../src/runtime/process/state-serializer.js';
import { Reference, References } from '../../../src/models/reference/reference.js';
import { registerModelByName } from '../../../src/models/model-name-registry.js';
import { PERSISTENT, ADAPTER_KEY, LOCK } from '../../../src/models/symbols.js';

// Side-effect: registers builtins (Reference, References descriptors)
import '../../../src/process/builtin-serializers.js';

const rt = (v: unknown) => decodeProcessable(JSON.parse(JSON.stringify(encodeProcessable(v))));
const rtState = (vars: Record<string, unknown>) =>
  deserializeState(JSON.parse(JSON.stringify(serializeState(vars))));

describe('Reference<T>', () => {
  it('INVARIANT: bare Reference (no model name) round-trips identifier', () => {
    const ref = new Reference<unknown>('user-123');
    const round = rt(ref) as Reference<unknown>;
    assert.ok(round instanceof Reference);
    assert.equal(round.identifier, 'user-123');
  });

  it('INVARIANT: Reference with model name preserves the identifier across the wire', () => {
    // Register a fake model so deserialize can find it
    registerModelByName('EdgeUser', {
      ref: (id: string) => new Reference(id, 'EdgeUser'),
    });
    const ref = new Reference<unknown>('user-42', 'EdgeUser');
    const round = rt(ref) as Reference<unknown>;
    assert.ok(round instanceof Reference);
    assert.equal(round.identifier, 'user-42');
  });

  it('INVARIANT: Reference identifier is stable — identical input ⇒ identical serialized form', () => {
    const a = new Reference<unknown>('same-id');
    const b = new Reference<unknown>('same-id');
    const ea = JSON.stringify(encodeProcessable(a));
    const eb = JSON.stringify(encodeProcessable(b));
    assert.equal(ea, eb, 'same identifier must serialize to the same JSON');
  });

  it('INVARIANT: two different Reference identifiers produce DIFFERENT serialized forms', () => {
    const a = new Reference<unknown>('id-a');
    const b = new Reference<unknown>('id-b');
    const ea = JSON.stringify(encodeProcessable(a));
    const eb = JSON.stringify(encodeProcessable(b));
    assert.notEqual(ea, eb);
  });

  it('INVARIANT: Reference inside state-serializer is tracked in __$processTypes metadata', () => {
    const ref = new Reference<unknown>('ref-state');
    const serialized = serializeState({ r: ref });
    assert.ok(serialized.__$processTypes);
    assert.equal(
      (serialized.__$processTypes as Record<string, string>).r,
      'justscale.Reference',
    );
  });

  it('INVARIANT: Reference NESTED inside an object (not top-level) still deserializes to a Reference', () => {
    const ref = new Reference<unknown>('nested-123');
    const round = rtState({ wrap: { inner: ref } }) as { wrap: { inner: Reference<unknown> } };
    assert.ok(round.wrap.inner instanceof Reference);
    assert.equal(round.wrap.inner.identifier, 'nested-123');
  });

  it('INVARIANT: Reference inside an ARRAY element still deserializes to a Reference', () => {
    const refs = [new Reference<unknown>('a'), new Reference<unknown>('b')];
    const round = rtState({ list: refs }) as { list: Reference<unknown>[] };
    assert.ok(round.list[0] instanceof Reference);
    assert.ok(round.list[1] instanceof Reference);
    assert.equal(round.list[0].identifier, 'a');
    assert.equal(round.list[1].identifier, 'b');
  });
});

describe('References<T>', () => {
  it('INVARIANT: References preserves ALL identifiers in order', () => {
    const refs = new References<unknown>(['a', 'b', 'c', 'd']);
    const round = rt(refs) as References<unknown>;
    assert.ok(round instanceof References);
    assert.deepEqual([...round.identifiers], ['a', 'b', 'c', 'd']);
  });

  it('INVARIANT: empty References round-trips as an empty collection', () => {
    const refs = new References<unknown>([]);
    const round = rt(refs) as References<unknown>;
    assert.ok(round instanceof References);
    assert.equal(round.length, 0);
  });

  it('INVARIANT: References length is stable across round-trip', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `id-${i}`);
    const refs = new References<unknown>(ids);
    const round = rt(refs) as References<unknown>;
    assert.equal(round.length, 50);
  });
});

describe('Persistent<T> — collapses to a Reference on the wire', () => {
  it('INVARIANT: a Persistent entity serializes as PersistentRef (tag + id), NOT as the raw entity', () => {
    const entity = Object.create(null);
    Object.defineProperty(entity, PERSISTENT, { value: true });
    Object.defineProperty(entity, ADAPTER_KEY, { value: 'order-99' });
    entity.name = 'Widget';
    entity.password_hash = 'should-never-leak';

    const serialized = serializeState({ product: entity });
    const json = JSON.parse(JSON.stringify(serialized));

    assert.equal(json.product.__$type, 'PersistentRef');
    assert.equal(json.product.id, 'order-99');
    // Critical: entity fields must NOT leak into the serialized form —
    // process state should never carry stale entity data.
    assert.equal(json.product.name, undefined);
    assert.equal(json.product.password_hash, undefined);
  });

  it('INVARIANT: Persistent WITHOUT an ADAPTER_KEY falls back to a plain object (no PersistentRef tag)', () => {
    const entity = Object.create(null);
    Object.defineProperty(entity, PERSISTENT, { value: true });
    // No ADAPTER_KEY — what happens? Current impl falls through to the
    // generic Processable / recursive object handling.
    entity.foo = 'bar';
    const serialized = serializeState({ e: entity });
    const json = JSON.parse(JSON.stringify(serialized));
    // Not a PersistentRef — must not claim the tag
    assert.notEqual(json.e?.__$type, 'PersistentRef');
  });

  it('INVARIANT: Persistent deserializes to a Reference with the same identifier', () => {
    const entity = Object.create(null);
    Object.defineProperty(entity, PERSISTENT, { value: true });
    Object.defineProperty(entity, ADAPTER_KEY, { value: 'xyz-777' });

    const round = rtState({ product: entity }) as { product: Reference<unknown> };
    assert.ok(round.product instanceof Reference);
    assert.equal(round.product.identifier, 'xyz-777');
  });

  it('INVARIANT: round-tripping a Persistent twice yields the SAME identifier (stability)', () => {
    const entity = Object.create(null);
    Object.defineProperty(entity, PERSISTENT, { value: true });
    Object.defineProperty(entity, ADAPTER_KEY, { value: 'stable-id' });

    const once = rtState({ e: entity }) as { e: Reference<unknown> };
    const twice = rtState({ e: entity }) as { e: Reference<unknown> };
    assert.equal(once.e.identifier, twice.e.identifier);
  });
});

describe('Locked<T> — what happens when someone tries to serialize a lock?', () => {
  it('INVARIANT: a locked object (has [LOCK] symbol + Symbol.dispose) is NOT detected as Persistent — pin current behaviour', () => {
    // Locked entities don't carry [PERSISTENT] by default — the [LOCK]
    // symbol is layered on by the lock feature. What DOES happen is that
    // the state-serializer walks the object like a plain object.
    //
    // If someone emits a Locked<T> into a signal payload, it gets flattened
    // to its enumerable fields. That's a silent loss of the lock guarantee.
    // Pin this so anyone adding Locked serialization is forced to change it.
    const locked = {
      name: 'test',
      [LOCK]: { id: 'lock-abc', lockedAt: new Date() },
      [Symbol.dispose]: () => {},
    };
    const round = rt(locked) as any;
    // The lock symbol is NOT enumerable in JSON, so it disappears.
    assert.equal(round.name, 'test');
    assert.equal(round[LOCK], undefined, 'lock metadata does not survive JSON');
  });

  it('INVARIANT: a Persistent entity that is ALSO locked is still serialized as PersistentRef (the PERSISTENT branch wins)', () => {
    const entity = Object.create(null);
    Object.defineProperty(entity, PERSISTENT, { value: true });
    Object.defineProperty(entity, ADAPTER_KEY, { value: 'locked-entity' });
    Object.defineProperty(entity, LOCK, { value: { id: 'lock-xyz' } });

    const serialized = serializeState({ e: entity });
    const json = JSON.parse(JSON.stringify(serialized));
    assert.equal(json.e.__$type, 'PersistentRef');
    assert.equal(json.e.id, 'locked-entity');
  });
});

describe('Nested domain + primitives', () => {
  it('INVARIANT: an object carrying { ref, date, bigint, string } preserves ALL types after state round-trip', () => {
    const vars = {
      payload: {
        author: new Reference<unknown>('user-mix'),
        createdAt: new Date('2025-03-15T10:00:00Z'),
        balance: 987654321987654321n,
        title: 'mixed-payload',
      },
    };
    const round = rtState(vars) as {
      payload: {
        author: Reference<unknown>;
        createdAt: Date;
        balance: bigint;
        title: string;
      };
    };
    assert.ok(round.payload.author instanceof Reference);
    assert.equal(round.payload.author.identifier, 'user-mix');
    assert.ok(round.payload.createdAt instanceof Date);
    assert.equal(round.payload.createdAt.toISOString(), '2025-03-15T10:00:00.000Z');
    assert.equal(round.payload.balance, 987654321987654321n);
    assert.equal(round.payload.title, 'mixed-payload');
  });

  it('INVARIANT: array of References preserves every identifier + order', () => {
    const list = [
      new Reference<unknown>('x1'),
      new Reference<unknown>('x2'),
      new Reference<unknown>('x3'),
    ];
    const round = rtState({ list }) as { list: Reference<unknown>[] };
    assert.deepEqual(round.list.map((r) => r.identifier), ['x1', 'x2', 'x3']);
  });
});
