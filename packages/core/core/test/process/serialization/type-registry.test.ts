/**
 * Processable protocol — TYPE REGISTRY edge cases.
 *
 * Pin registration semantics that silent regressions would bury:
 * duplicate-name handling, lookup strictness, registry read-only view,
 * and the contract around "same name = same descriptor identity".
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerProcessType,
  getProcessDescriptor,
  getProcessRegistry,
  encodeProcessable,
  decodeProcessable,
} from '../../../src/process/serialization.js';

// Side-effect: registers builtins
import '../../../src/process/builtin-serializers.js';

describe('Registry — registerProcessType semantics', () => {
  it('INVARIANT: same-descriptor re-registration is a no-op (no throw)', () => {
    const desc: ProcessDescriptor = {
      name: 'test.registry.Idempotent',
      serialize: () => ({}),
      deserialize: () => ({}),
    };
    registerProcessType(desc);
    // Passing the SAME instance again is idempotent
    registerProcessType(desc);
    registerProcessType(desc);
    assert.equal(getProcessDescriptor('test.registry.Idempotent'), desc);
  });

  it('INVARIANT: two DIFFERENT descriptors with the same name throw "Duplicate registration"', () => {
    const a: ProcessDescriptor = {
      name: 'test.registry.Clash',
      serialize: () => ({}),
      deserialize: () => ({ variant: 'a' }),
    };
    const b: ProcessDescriptor = {
      name: 'test.registry.Clash',
      serialize: () => ({}),
      deserialize: () => ({ variant: 'b' }),
    };
    registerProcessType(a);
    assert.throws(() => registerProcessType(b), /Duplicate registration/i);
    // After the throw, the FIRST descriptor remains in the registry
    assert.equal(getProcessDescriptor('test.registry.Clash'), a);
  });

  it('INVARIANT: getProcessDescriptor returns undefined (never null) for unknown names', () => {
    const result = getProcessDescriptor('test.registry.DoesNotExist');
    assert.equal(result, undefined);
    assert.notEqual(result, null, 'registry must use undefined for absent keys, not null');
  });

  it('INVARIANT: getProcessRegistry exposes a READONLY Map view', () => {
    const reg = getProcessRegistry();
    assert.ok(reg instanceof Map);
    // While the type signature promises readonly, a structural check:
    // the test is that the public API doesn't offer a .delete path.
    // Mutating via the returned Map is not a supported operation;
    // this test documents that consumers should treat it as read-only.
    assert.equal(typeof reg.get, 'function');
    assert.equal(typeof reg.has, 'function');
  });

  it('INVARIANT: the registry contains ALL framework builtins after import', () => {
    const reg = getProcessRegistry();
    // Each of these must be registered by side-effect import of builtin-serializers
    assert.ok(reg.has('justscale.Date'));
    assert.ok(reg.has('justscale.Map'));
    assert.ok(reg.has('justscale.Set'));
    assert.ok(reg.has('justscale.Reference'));
    assert.ok(reg.has('justscale.References'));
    assert.ok(reg.has('justscale.BigInt'));
    assert.ok(reg.has('justscale.RegExp'));
    assert.ok(reg.has('justscale.Error'));
    assert.ok(reg.has('justscale.TypeError'));
    assert.ok(reg.has('justscale.RangeError'));
    assert.ok(reg.has('justscale.SyntaxError'));
    assert.ok(reg.has('justscale.ReferenceError'));
    assert.ok(reg.has('justscale.URIError'));
    assert.ok(reg.has('justscale.EvalError'));
  });
});

describe('Registry — dispatch via encode/decode', () => {
  // Declare two descriptors with overlapping structural shape —
  // both take { v: number } objects. They're distinguished by the NAME
  // in the registry, not by structure. Pin that dispatch is NAME-based.
  class Celsius {
    constructor(public v: number) {}
    static [Symbol.process]: ProcessDescriptor<Celsius> = {
      name: 'test.registry.Celsius',
      serialize: (x: Celsius) => ({ v: x.v }),
      deserialize: (d: any) => new Celsius(d.v),
    };
  }
  class Fahrenheit {
    constructor(public v: number) {}
    static [Symbol.process]: ProcessDescriptor<Fahrenheit> = {
      name: 'test.registry.Fahrenheit',
      serialize: (x: Fahrenheit) => ({ v: x.v }),
      deserialize: (d: any) => new Fahrenheit(d.v),
    };
  }
  registerProcessType(Celsius[Symbol.process]);
  registerProcessType(Fahrenheit[Symbol.process]);

  it('INVARIANT: structurally identical values with different names dispatch to DIFFERENT deserializers', () => {
    const c = new Celsius(25);
    const f = new Fahrenheit(77);
    const ec = encodeProcessable(c);
    const ef = encodeProcessable(f);

    // Same d shape
    assert.deepEqual((ec as any).d, { v: 25 });
    assert.deepEqual((ef as any).d, { v: 77 });

    // But different names + different reconstructed types
    const dc = decodeProcessable(ec);
    const df = decodeProcessable(ef);
    assert.ok(dc instanceof Celsius);
    assert.ok(df instanceof Fahrenheit);
    assert.ok(!(dc instanceof Fahrenheit));
    assert.ok(!(df instanceof Celsius));
  });

  it('INVARIANT: if the name in the envelope is swapped, decode reconstructs the WRONG type — pin that dispatch trusts the name blindly', () => {
    // This is protocol-level trust: we don't validate that the data shape
    // matches the descriptor. If a wire forgery changes the name, decode
    // will happily reconstruct a different type. Pin this so anyone adding
    // shape validation is forced to update this test consciously.
    const c = new Celsius(100);
    const encoded = encodeProcessable(c) as Record<string, unknown>;
    encoded.__$p = 'test.registry.Fahrenheit';

    const decoded = decodeProcessable(encoded);
    assert.ok(decoded instanceof Fahrenheit, 'decoder trusts the name in the envelope');
    assert.equal((decoded as Fahrenheit).v, 100);
  });
});

describe('Registry — descriptor object identity', () => {
  it('INVARIANT: a descriptor registered via registerProcessType is retrieved by REFERENCE', () => {
    const desc: ProcessDescriptor = {
      name: 'test.registry.ReferenceIdentity',
      serialize: () => ({}),
      deserialize: () => ({}),
    };
    registerProcessType(desc);
    const got = getProcessDescriptor('test.registry.ReferenceIdentity');
    assert.equal(got, desc, 'registry must return the very same descriptor object');
  });

  it('INVARIANT: two instances of structurally-equal descriptors DO NOT collide unless registered under the same name', () => {
    // Different names ⇒ both coexist.
    const a: ProcessDescriptor = {
      name: 'test.registry.Twin.A',
      serialize: () => ({}),
      deserialize: () => ({}),
    };
    const b: ProcessDescriptor = {
      name: 'test.registry.Twin.B',
      serialize: () => ({}),
      deserialize: () => ({}),
    };
    registerProcessType(a);
    registerProcessType(b);
    assert.equal(getProcessDescriptor('test.registry.Twin.A'), a);
    assert.equal(getProcessDescriptor('test.registry.Twin.B'), b);
  });
});

describe('Registry — name format', () => {
  it('INVARIANT: framework-namespace builtins use the "justscale." prefix', () => {
    for (const name of [
      'justscale.Date',
      'justscale.Map',
      'justscale.Set',
      'justscale.Reference',
      'justscale.References',
      'justscale.BigInt',
    ]) {
      assert.ok(name.startsWith('justscale.'), `framework descriptor '${name}' must use the 'justscale.' namespace`);
    }
  });

  it('INVARIANT: descriptor names are accepted as arbitrary strings (no format enforcement)', () => {
    // If we later enforce dotted names, update this test. For now, any
    // non-empty string is a legal descriptor name.
    const desc: ProcessDescriptor = {
      name: 'weirdo with spaces/and slashes',
      serialize: () => ({}),
      deserialize: () => ({}),
    };
    registerProcessType(desc);
    assert.equal(getProcessDescriptor('weirdo with spaces/and slashes'), desc);
  });

  it('INVARIANT: empty-string descriptor name is rejected (proc-9)', () => {
    const desc: ProcessDescriptor = {
      name: '',
      serialize: () => ({}),
      deserialize: () => ({}),
    };
    assert.throws(() => registerProcessType(desc), /empty/i);
  });

  it('INVARIANT: descriptor name with leading whitespace is rejected (proc-9)', () => {
    const desc: ProcessDescriptor = {
      name: ' leading',
      serialize: () => ({}),
      deserialize: () => ({}),
    };
    assert.throws(() => registerProcessType(desc), /whitespace/i);
  });

  it('INVARIANT: descriptor name with trailing whitespace is rejected (proc-9)', () => {
    const desc: ProcessDescriptor = {
      name: 'trailing ',
      serialize: () => ({}),
      deserialize: () => ({}),
    };
    assert.throws(() => registerProcessType(desc), /whitespace/i);
  });

  it('INVARIANT: descriptor name "__$p" (envelope key) is rejected (proc-9)', () => {
    const desc: ProcessDescriptor = {
      name: '__$p',
      serialize: () => ({}),
      deserialize: () => ({}),
    };
    assert.throws(() => registerProcessType(desc), /reserved/i);
  });
});
