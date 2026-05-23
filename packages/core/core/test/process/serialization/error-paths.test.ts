/**
 * Processable protocol — ERROR PATH + OBSERVABILITY invariants.
 *
 * Pin the behaviour when things go wrong: a non-serializable value, a
 * corrupted payload, a thrown descriptor. The property we care about is
 * "failures must be LOUD" — a silent partial write / NaN / null is worse
 * than a crash.
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeProcessable,
  decodeProcessable,
  registerProcessType,
} from '../../../src/process/serialization.js';
import { serializeState, deserializeState } from '../../../src/runtime/process/state-serializer.js';

// Side-effect: registers builtins
import '../../../src/process/builtin-serializers.js';

describe('Non-serializable values — functions', () => {
  it('INVARIANT: a function value at top-level becomes null AND emits a warning', () => {
    const warned: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warned.push(String(msg));
    try {
      const out = serializeState({ fn: () => 42, ok: 'hello' });
      assert.equal(out.fn, null);
      assert.equal(out.ok, 'hello');
      assert.ok(
        warned.some((w) => /Functions cannot be serialized/i.test(w)),
        'a warning must be emitted — silent null is worse than loud failure',
      );
    } finally {
      console.warn = origWarn;
    }
  });

  it('INVARIANT: a function nested inside an object also becomes null AND warns', () => {
    const warned: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warned.push(String(msg));
    try {
      const out = serializeState({ wrap: { fn: () => 1, ok: 'x' } });
      const wrap = out.wrap as { fn: unknown; ok: string };
      assert.equal(wrap.fn, null);
      assert.equal(wrap.ok, 'x');
      assert.ok(warned.length > 0);
    } finally {
      console.warn = origWarn;
    }
  });

  it('INVARIANT: a function inside an array becomes null', () => {
    const warned: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warned.push(String(msg));
    try {
      const out = serializeState({ list: [1, () => 2, 3] });
      assert.deepEqual(out.list, [1, null, 3]);
    } finally {
      console.warn = origWarn;
    }
  });
});

describe('Non-serializable values — Symbols', () => {
  it('INVARIANT: Symbol VALUES are silently dropped by JSON.stringify (pin current gap)', () => {
    // Current impl doesn't explicitly reject symbols. JSON.stringify drops them.
    // Pin this gap so anyone tightening validation has a test to update.
    const sym = Symbol('foo');
    const serialized = serializeState({ s: sym });
    // serializeState returns the symbol as-is (it falls through)
    // and JSON.stringify then drops it.
    const json = JSON.parse(JSON.stringify(serialized));
    assert.equal(json.s, undefined);
  });

  it('INVARIANT: Symbol-keyed properties on plain objects are not enumerable and do NOT appear in the serialized form', () => {
    const sym = Symbol('hidden');
    const obj: Record<string | symbol, unknown> = { visible: 'yes' };
    obj[sym] = 'should-not-appear';
    const serialized = serializeState({ o: obj });
    const json = JSON.parse(JSON.stringify(serialized));
    assert.equal(json.o.visible, 'yes');
    assert.equal(Object.keys(json.o).length, 1, 'symbol key must not appear');
  });
});

describe('Corrupted payloads on deserialize', () => {
  it('INVARIANT: an envelope with an UNKNOWN name throws — silent pass-through makes registration bugs invisible (proc-3)', () => {
    // proc-3: decodeProcessable({__$p: 'ghost.type'}) must throw, not return
    // the envelope unchanged. A consumer cannot distinguish "forgot to register"
    // from "real data that happens to have __$p" when the fallback is silent.
    const ghost = { __$p: 'ghost.type', d: { some: 'data' } };
    assert.throws(
      () => decodeProcessable(ghost),
      /Unknown descriptor 'ghost\.type'/,
    );
  });

  it('INVARIANT: an envelope with an UNKNOWN name throws even when nested inside an object (proc-3)', () => {
    const nested = { outer: { __$p: 'another.ghost', d: {} } };
    assert.throws(
      () => decodeProcessable(nested),
      /Unknown descriptor 'another\.ghost'/,
    );
  });

  it('INVARIANT: an envelope with a KNOWN name but MALFORMED data propagates the descriptor\'s error — no silent success', () => {
    const strict: ProcessDescriptor = {
      name: 'test.errors.StrictShape',
      serialize: (v: any) => ({ x: v.x }),
      deserialize: (d: any) => {
        if (typeof d.x !== 'number') {
          throw new TypeError(`Expected number, got ${typeof d.x}`);
        }
        return { x: d.x };
      },
    };
    registerProcessType(strict);

    const bad = { __$p: 'test.errors.StrictShape', d: { x: 'not-a-number' } };
    assert.throws(() => decodeProcessable(bad), TypeError);
  });

  it('INVARIANT: state-serializer with unknown Processable name falls back AND warns (not crashes)', () => {
    const warned: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warned.push(String(msg));
    try {
      const stored = {
        __$processTypes: { x: 'test.errors.GhostType' },
        x: { some: 'value' },
      };
      const restored = deserializeState(stored);
      // Falls back to raw JSON — doesn't throw
      assert.deepEqual(restored.x, { some: 'value' });
      assert.ok(
        warned.some((w) => /No registered ProcessDescriptor/i.test(w)),
        'must emit a warning for missing descriptor',
      );
    } finally {
      console.warn = origWarn;
    }
  });

  it('INVARIANT: a nested "P"-tagged envelope with an unknown name falls back with a warning', () => {
    const warned: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warned.push(String(msg));
    try {
      // Construct a state that pretends there's a nested Processable
      const stored = {
        wrap: {
          __$type: 'P',
          n: 'test.errors.AnotherGhost',
          v: { raw: 'data' },
        },
      };
      const restored = deserializeState(stored);
      // Falls through to the raw value
      assert.deepEqual((restored.wrap as any), { raw: 'data' });
      assert.ok(warned.some((w) => /No registered ProcessDescriptor/i.test(w)));
    } finally {
      console.warn = origWarn;
    }
  });

  it('INVARIANT: deserializeState on null/undefined values preserves them (no crash)', () => {
    const out = deserializeState({ a: null, b: undefined as unknown });
    assert.equal(out.a, null);
    // undefined at top-level keys: input keys are iterated via Object.keys,
    // so an explicit undefined is iterated but becomes null in JSON output
    // if re-stringified. Here, since we pass a plain object, 'b' is present.
    assert.ok('b' in out);
  });

  it('INVARIANT: unknown __$type tag (not P, not Map, not Set, etc.) passes through as a plain object', () => {
    const stored = { tagged: { __$type: 'UnknownCustomTag', payload: 'user-data' } };
    const out = deserializeState(stored) as { tagged: Record<string, unknown> };
    // The unknown tag falls through the switch → plain object path
    assert.equal(out.tagged.__$type, 'UnknownCustomTag');
    assert.equal(out.tagged.payload, 'user-data');
  });
});

describe('Descriptor throws during serialize', () => {
  it('INVARIANT: a throwing serialize propagates the error — no partial state commit', () => {
    class Broken {
      constructor(public v: number) {}
      static [Symbol.process]: ProcessDescriptor<Broken> = {
        name: 'test.errors.Broken',
        serialize: () => {
          throw new Error('serialize-explode');
        },
        deserialize: (d: any) => new Broken(d.v),
      };
    }
    registerProcessType(Broken[Symbol.process]);

    assert.throws(
      () => encodeProcessable(new Broken(1)),
      /serialize-explode/,
    );
  });

  it('INVARIANT: a throwing serialize from state-serializer propagates — no silent swallow', () => {
    class StateBroken {
      constructor(public v: number) {}
      static [Symbol.process]: ProcessDescriptor<StateBroken> = {
        name: 'test.errors.StateBroken',
        serialize: () => {
          throw new Error('state-serialize-boom');
        },
        deserialize: (d: any) => new StateBroken(d.v),
      };
    }
    registerProcessType(StateBroken[Symbol.process]);

    assert.throws(
      () => serializeState({ x: new StateBroken(1) }),
      /state-serialize-boom/,
    );
  });
});

describe('Partial-write avoidance', () => {
  it('INVARIANT: if ONE var throws during serialize, the whole call throws — we do NOT return a half-written object', () => {
    class Safe {
      constructor(public v: number) {}
      static [Symbol.process]: ProcessDescriptor<Safe> = {
        name: 'test.errors.Safe',
        serialize: (s: Safe) => ({ v: s.v }),
        deserialize: (d: any) => new Safe(d.v),
      };
    }
    class Unsafe {
      constructor(public v: number) {}
      static [Symbol.process]: ProcessDescriptor<Unsafe> = {
        name: 'test.errors.Unsafe',
        serialize: () => {
          throw new Error('partial-write-test');
        },
        deserialize: (d: any) => new Unsafe(d.v),
      };
    }
    registerProcessType(Safe[Symbol.process]);
    registerProcessType(Unsafe[Symbol.process]);

    // Mixed — the serialize must fail-fast; we MUST NOT see the safe var's
    // encoded form returned alongside a skipped unsafe var.
    assert.throws(
      () => serializeState({ ok: new Safe(1), bad: new Unsafe(2) }),
      /partial-write-test/,
    );
  });
});

describe('Error localization — developer observability', () => {
  it('INVARIANT: state-serializer includes the var name in the error message so devs know which key caused the failure (proc-11)', () => {
    class ExplodeNamed {
      constructor(public v: number) {}
      static [Symbol.process]: ProcessDescriptor<ExplodeNamed> = {
        name: 'test.errors.ExplodeNamed',
        serialize: () => {
          throw new Error('generic-boom');
        },
        deserialize: (d: any) => new ExplodeNamed(d.v),
      };
    }
    registerProcessType(ExplodeNamed[Symbol.process]);

    let caught: Error | null = null;
    try {
      serializeState({ myImportantVar: new ExplodeNamed(1) });
    } catch (e) {
      caught = e as Error;
    }
    assert.ok(caught, 'must throw');
    // proc-11: the error message must identify which process-state key triggered it.
    assert.ok(
      /myImportantVar/.test(caught!.message),
      `error message should include the var name 'myImportantVar'. Got: ${caught!.message}`
    );
    // And the original error message must still be present.
    assert.ok(
      /generic-boom/.test(caught!.message),
      `error message should include the original error. Got: ${caught!.message}`
    );
  });
});
