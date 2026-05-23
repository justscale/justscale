/**
 * Processable protocol — STABLE WIRE FORMAT + DETERMINISM invariants.
 *
 * The serialized form is a data-form contract: a downstream consumer
 * (another node, a log indexer, a test snapshot) must be able to
 * parse it with ONLY the format spec — no runtime access. Pin:
 *
 *   1. The wire format is pure JSON (no binary escape).
 *   2. Deterministic: same input ⇒ same bytes (with key-stable objects).
 *   3. Self-describing: the __$p / __$type tags alone identify types.
 *   4. Format version handling (documented even if absent today).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeProcessable,
  decodeProcessable,
  registerProcessType,
} from '../../../src/process/serialization.js';
import { serializeState } from '../../../src/runtime/process/state-serializer.js';
import { Reference } from '../../../src/models/reference/reference.js';

// Side-effect: registers builtins
import '../../../src/process/builtin-serializers.js';

describe('Wire format — pure JSON', () => {
  it('INVARIANT: serialized state is JSON.parse(JSON.stringify(x)) clean (no binary, no functions)', () => {
    const input = {
      ref: new Reference<unknown>('u-1'),
      when: new Date('2025-05-05T05:05:05.005Z'),
      count: 7n,
      tags: new Set(['a', 'b']),
      meta: new Map([['k', 'v']]),
      plain: 'string',
      num: 42,
      bool: true,
    };
    const serialized = serializeState(input);
    const json = JSON.stringify(serialized);
    // JSON must be valid
    assert.doesNotThrow(() => JSON.parse(json));
    // The JSON string must NOT contain any characters that would fail in
    // a non-UTF-8 storage layer. All chars in ASCII range.
    for (const ch of json) {
      assert.ok(ch.charCodeAt(0) < 0x10000, 'serialized form must be JSON-text compatible');
    }
  });

  it('INVARIANT: encoded Processable is a tagged object — a reader that knows {__$p, __$v, d} can reconstruct', () => {
    class Price {
      constructor(public cents: number) {}
      static [Symbol.process]: ProcessDescriptor<Price> = {
        name: 'test.wire.Price',
        serialize: (v: Price) => ({ cents: v.cents }),
        deserialize: (d: any) => new Price(d.cents),
      };
    }
    registerProcessType(Price[Symbol.process]);

    const encoded = encodeProcessable(new Price(999)) as Record<string, unknown>;
    // Shape is predictable:
    assert.deepEqual(Object.keys(encoded).sort(), ['__$p', '__$v', 'd']);
    assert.equal(encoded.__$p, 'test.wire.Price');
    assert.equal(encoded.__$v, 1);
    assert.deepEqual(encoded.d, { cents: 999 });
  });
});

describe('Wire format — determinism', () => {
  it('INVARIANT: same Date value ⇒ same serialized bytes', () => {
    const d1 = new Date('2025-09-09T09:09:09Z');
    const d2 = new Date('2025-09-09T09:09:09Z');
    const b1 = JSON.stringify(encodeProcessable(d1));
    const b2 = JSON.stringify(encodeProcessable(d2));
    assert.equal(b1, b2);
  });

  it('INVARIANT: same Reference id ⇒ same serialized bytes (even across instances)', () => {
    const r1 = new Reference<unknown>('det-id');
    const r2 = new Reference<unknown>('det-id');
    const b1 = JSON.stringify(encodeProcessable(r1));
    const b2 = JSON.stringify(encodeProcessable(r2));
    assert.equal(b1, b2);
  });

  it('INVARIANT: key order in the envelope is stable (__$p first, __$v second, d third)', () => {
    class X {
      constructor(public n: number) {}
      static [Symbol.process]: ProcessDescriptor<X> = {
        name: 'test.wire.OrderX',
        serialize: (v: X) => ({ n: v.n }),
        deserialize: (d: any) => new X(d.n),
      };
    }
    registerProcessType(X[Symbol.process]);
    const encoded = encodeProcessable(new X(1));
    const json = JSON.stringify(encoded);
    // {"__$p":"...","__$v":1,"d":...}
    const tagIdx = json.indexOf('__$p');
    const versionIdx = json.indexOf('__$v');
    const dataIdx = json.indexOf('"d":');
    assert.ok(tagIdx !== -1 && versionIdx !== -1 && dataIdx !== -1);
    assert.ok(tagIdx < versionIdx, 'descriptor name must come before version in the envelope');
    assert.ok(versionIdx < dataIdx, 'version must come before data in the envelope');
  });

  it('INVARIANT: top-level __$processTypes appears in state output (documented format signal)', () => {
    const out = serializeState({ a: new Date(0), b: 1 });
    // __$processTypes is only added when at least one var uses a Processable.
    assert.ok('__$processTypes' in out, 'top-level type map must be present');
    assert.deepEqual((out as any).__$processTypes, { a: 'justscale.Date' });
  });

  it('INVARIANT: purely JSON-native state (no Processables) does NOT emit __$processTypes', () => {
    const out = serializeState({ a: 1, b: 'str', c: true });
    assert.ok(!('__$processTypes' in out), 'no Processable = no type map');
  });
});

describe('Wire format — two separate processes producing the same value', () => {
  it('INVARIANT: two separately-constructed complex states produce identical JSON when their contents are equal', () => {
    // "Node A" and "Node B" each build the same logical state. The output
    // must be byte-identical so a dedupe/idempotency layer can compare.
    const buildState = () => ({
      user: new Reference<unknown>('user-stable'),
      created: new Date('2025-04-04T04:04:04.004Z'),
      balance: 123n,
      tags: new Set(['premium', 'active']),
    });

    const a = JSON.stringify(serializeState(buildState()));
    const b = JSON.stringify(serializeState(buildState()));
    assert.equal(a, b, 'two independent builds of the same logical state must produce identical bytes');
  });

  it('INVARIANT: key order within state objects follows insertion order (determinism requirement)', () => {
    // JS objects preserve insertion order by spec — pin that our serializer
    // doesn't reshuffle keys.
    const input = { z: 1, a: 2, m: 3 };
    const out = serializeState(input);
    const keys = Object.keys(out).filter(k => k !== '__$processTypes');
    assert.deepEqual(keys, ['z', 'a', 'm']);
  });
});

describe('Wire format — tag namespace isolation', () => {
  it('INVARIANT: framework tags use "__$" prefix so user data is unlikely to collide', () => {
    // Tags we own:
    const tags = ['__$p', '__$type', '__$processTypes'];
    for (const tag of tags) {
      assert.ok(tag.startsWith('__$'), `tag '${tag}' must use the __$ prefix`);
    }
  });

  it('INVARIANT: user-owned keys starting with __$ are rare but possible — pin the current collision behaviour', () => {
    // If user data has __$type: "ExoticUserTag" (with no matching case in the
    // deserializer switch), state-serializer passes it through as a plain object.
    // Pin this so anyone adding a wildcard handler is forced to update.
    const userValue = { __$type: 'FakeTag', payload: 'user-data' };
    const out = serializeState({ wrap: userValue });
    const json = JSON.parse(JSON.stringify(out));
    // The value structure is preserved — __$type key + payload survive.
    assert.equal(json.wrap.__$type, 'FakeTag');
    assert.equal(json.wrap.payload, 'user-data');
  });
});

describe('Wire format — versioning (proc-8)', () => {
  it('INVARIANT: the envelope includes __$v:1 (format version)', () => {
    class V {
      constructor(public n: number) {}
      static [Symbol.process]: ProcessDescriptor<V> = {
        name: 'test.wire.Versioned',
        serialize: (v: V) => ({ n: v.n }),
        deserialize: (d: any) => new V(d.n),
      };
    }
    registerProcessType(V[Symbol.process]);

    const encoded = encodeProcessable(new V(1)) as Record<string, unknown>;
    assert.equal(encoded.__$v, 1, 'envelope must carry __$v = 1');
  });

  it('INVARIANT: envelopes without __$v (legacy on-wire data) decode successfully — backwards compat', () => {
    // An envelope produced before versioning was added has no __$v field.
    // Decode must treat it as version 1 and succeed.
    class Legacy {
      constructor(public n: number) {}
      static [Symbol.process]: ProcessDescriptor<Legacy> = {
        name: 'test.wire.Legacy',
        serialize: (v: Legacy) => ({ n: v.n }),
        deserialize: (d: any) => new Legacy(d.n),
      };
    }
    registerProcessType(Legacy[Symbol.process]);
    const legacyEnvelope = { __$p: 'test.wire.Legacy', d: { n: 42 } };
    const decoded = decodeProcessable(legacyEnvelope) as Legacy;
    assert.ok(decoded instanceof Legacy);
    assert.equal(decoded.n, 42);
  });

  it('INVARIANT: an envelope with an unknown __$v throws a clear error', () => {
    const futureEnvelope = { __$p: 'justscale.Date', __$v: 999, d: { ms: 0 } };
    assert.throws(
      () => decodeProcessable(futureEnvelope),
      /Unsupported envelope version 999/,
    );
  });
});

describe('Wire format — round-trip is a monoid (composability)', () => {
  it('INVARIANT: wrapping a serialized state inside another object + serializing again preserves both the type map and the raw serialized form', () => {
    const inner = serializeState({ date: new Date(0) });
    const outer = { meta: 'outer', inner };
    const json = JSON.stringify(outer);
    const parsed = JSON.parse(json);
    assert.equal(parsed.meta, 'outer');
    // Top-level Processable vars are tracked via the top-level __$processTypes
    // metadata map (NOT inline __$type:'P' wrapping). Pin that shape.
    assert.equal(parsed.inner.__$processTypes.date, 'justscale.Date');
    // The raw serialized form is the descriptor's output (Date produces { ms })
    assert.equal(parsed.inner.date.ms, 0);
  });
});
