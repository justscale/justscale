/**
 * Await-expression shapes inside race-branch bodies.
 *
 * Adjacent coverage for the "missing BLOCK body for `const x = await
 * nonPrimitiveCall()`" fix (see service-await-block.test.ts). That fix
 * handled the `const x = await call()` shape. This file locks down every
 * other await shape a user can write inside a race branch body and
 * verifies the awaited call is actually emitted into the generated code.
 *
 * Patterns covered:
 *  - `await primitiveSignal()` (await signal(...) / await delay(...)) -
 *    no BLOCK expected, the primitive gets its own opcode.
 *  - bare `await service.method(…)` (result discarded) - must still emit.
 *  - `const x = await service.method(…)` - BLOCK + STORE (already covered
 *    in service-await-block.test.ts; included here as defence-in-depth).
 *  - nested awaits: `await outer(await inner())`.
 *  - `await` inside the then-body of an if.
 *  - `await` chained across `&&` / `??` expressions.
 *  - destructuring binds: `const { a, b } = await svc.x()` and
 *    `const [x, y] = await svc.x()`.
 *  - assignment to pre-existing var: `x = await svc.m()`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import ts from 'typescript';
import { analyzeHandler } from '../src/compiler/analyzer.js';
import {
  generateSwitchProcess,
  type SwitchCodeGenInput,
} from '../src/compiler/switch-codegen.js';
import { computeVersionHash } from '../src/compiler/step-hash.js';
import { createHandler, createTypeChecker } from './test-utils.js';

function generate(code: string): string {
  const handler = createHandler(code);
  const typeChecker = createTypeChecker();
  const analysis = analyzeHandler(handler, typeChecker);

  const input: SwitchCodeGenInput = {
    id: 'test',
    path: '/test',
    version: computeVersionHash(analysis),
    injectNode: undefined,
    handler,
    analysis,
  };

  const factory = ts.factory;
  const callExpr = generateSwitchProcess(factory, input);
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const sourceFile = ts.createSourceFile('output.ts', '', ts.ScriptTarget.Latest, false);
  return printer.printNode(ts.EmitHint.Expression, callExpr, sourceFile);
}

describe('race-branch await patterns: primitive vs service', () => {
  it('`await signal(deps.signals.x)` inside a race branch emits a signal suspend (no BLOCK)', () => {
    // Primitives get their own opcodes: the analyzer emits SIGNAL_SUSPEND
    // or similar, and codegen produces `__r[0]=1; __r[1]={signal:…};
    // break main_loop;`. There must NOT be a `__blockResult = await signal(…)`
    // because signal() is a primitive, not a service call.
    const code = `async () => {
      while (true) {
        const r = race();
        switch (true) {
          case signal(r, deps.signals.a): {
            await signal(deps.signals.b);
            break;
          }
        }
      }
    }`;
    const generated = generate(code);

    // The second signal must be emitted as a race-branch suspend (payload
    // shape `{ signal: deps.signals.b.signalName }`) or as a separate
    // step that sets __r[0]=1. Either way, it should NOT be wrapped in
    // `__blockResult = await signal(…)`.
    assert.ok(
      !/__blockResult\s*=\s*await\s+signal\(/.test(generated),
      `primitive \`await signal(...)\` must not be wrapped in __blockResult:\n${generated}`,
    );

    // And the second signal reference (deps.signals.b) must appear in
    // the emitted code - otherwise the suspend is silently dropped.
    assert.match(
      generated,
      /deps\.signals\.b/,
      `primitive \`await signal(deps.signals.b)\` must appear in emitted code:\n${generated}`,
    );
  });

  it('`await delay.seconds(...)` inside a race branch emits a timer suspend (no BLOCK)', () => {
    // delay() used outside a race() is a one-shot suspend. No BLOCK.
    const code = `async () => {
      while (true) {
        const r = race();
        switch (true) {
          case signal(r, deps.signals.tick): {
            await delay.seconds(5);
            break;
          }
        }
      }
    }`;
    const generated = generate(code);

    assert.ok(
      !/__blockResult\s*=\s*await\s+delay/.test(generated),
      `primitive \`await delay(...)\` must not be wrapped in __blockResult:\n${generated}`,
    );
    // And the delay payload must appear (timer descriptor).
    assert.match(
      generated,
      /timer:/,
      `\`await delay.seconds(5)\` must emit a timer: descriptor:\n${generated}`,
    );
  });

  it('bare `await svc.method()` (result discarded) still emits the call', () => {
    // Expression-statement form - the compiler must not drop the side
    // effect. Generalisation of the third case in service-await-block.test.ts.
    const code = `async () => {
      while (true) {
        const r = race();
        switch (true) {
          case signal(r, deps.signals.tick): {
            await svc.touch();
            break;
          }
        }
      }
    }`;
    const generated = generate(code);

    assert.match(
      generated,
      /await\s+(services\.)?svc\.touch/,
      `bare \`await svc.touch()\` must be emitted (the call is side-effecting):\n${generated}`,
    );
  });

  it('`const x = await svc.m()` still emits `__blockResult = await svc.m(); state.vars.x = __blockResult`', () => {
    // This is the exact shape from the original BLOCK fix. Kept here as
    // a defence-in-depth sanity check so any regression lights up in
    // multiple places.
    const code = `async () => {
      while (true) {
        const r = race();
        switch (true) {
          case signal(r, deps.signals.tick): {
            const x = await svc.load(r.id);
            await svc.use(x);
            break;
          }
        }
      }
    }`;
    const generated = generate(code);

    assert.match(
      generated,
      /__blockResult\s*=\s*await\s+(services\.)?svc\.load/,
      `expected \`__blockResult = await svc.load(...)\`:\n${generated}`,
    );
    assert.match(
      generated,
      /state\.vars\.x\s*=\s*__blockResult/,
      `expected \`state.vars.x = __blockResult\`:\n${generated}`,
    );
  });

  it('nested awaits `await outer(await inner())` emit both calls', () => {
    const code = `async () => {
      while (true) {
        const r = race();
        switch (true) {
          case signal(r, deps.signals.tick): {
            const res = await svc.outer(await svc.inner(r.id));
            await svc.use(res);
            break;
          }
        }
      }
    }`;
    const generated = generate(code);

    // Both inner and outer service calls must appear. The inner one can
    // be inlined into the outer's argument (JS await semantics allow
    // `await outer(await inner)` as a single expression).
    assert.match(
      generated,
      /await\s+(services\.)?svc\.inner/,
      `inner await call must be emitted:\n${generated}`,
    );
    assert.match(
      generated,
      /await\s+(services\.)?svc\.outer/,
      `outer await call must be emitted:\n${generated}`,
    );
    // And the result must be stored.
    assert.match(
      generated,
      /state\.vars\.res\s*=\s*__blockResult/,
      `nested await result must be stored in state.vars.res:\n${generated}`,
    );
  });

  it('`await` inside then-body of an if inside a race branch emits the call', () => {
    const code = `async () => {
      while (true) {
        const r = race();
        switch (true) {
          case signal(r, deps.signals.tick): {
            if (r.authed) {
              const u = await svc.load(r.userId);
              await svc.record(u);
            }
            break;
          }
        }
      }
    }`;
    const generated = generate(code);

    // The guarded await must be present - not dropped just because it's
    // inside an if-body.
    assert.match(
      generated,
      /await\s+(services\.)?svc\.load/,
      `\`await svc.load(...)\` inside if-body must be emitted:\n${generated}`,
    );
    assert.match(
      generated,
      /await\s+(services\.)?svc\.record/,
      `\`await svc.record(...)\` inside if-body must be emitted:\n${generated}`,
    );
  });

  it('`x = await svc.m()` (assignment to pre-existing var) emits the call and stores the result', () => {
    // The `latest` variable is declared before the race and reassigned
    // inside the branch. The assignment must emit both the await and the
    // store to state.vars.latest.
    const code = `async () => {
      let latest = undefined;
      while (true) {
        const r = race();
        switch (true) {
          case signal(r, deps.signals.ping): {
            latest = await svc.value(r.id);
            break;
          }
        }
      }
    }`;
    const generated = generate(code);

    assert.match(
      generated,
      /state\.vars\.latest\s*=\s*await\s+(services\.)?svc\.value/,
      `\`latest = await svc.value(...)\` must emit the state.vars.latest = await … form:\n${generated}`,
    );
  });

  it('`await` inside `&&` chain runs the call only when the short-circuit condition is truthy', () => {
    // The short-circuit semantics must be preserved: the await must be
    // emitted inside the `&&` arm. A bug would drop the await and store
    // whatever `r.a` is into `x`.
    const code = `async () => {
      while (true) {
        const r = race();
        switch (true) {
          case signal(r, deps.signals.tick): {
            const x = r.a && (await svc.fetch(r.a));
            await svc.use(x);
            break;
          }
        }
      }
    }`;
    const generated = generate(code);

    // The && arm must still contain the await.
    assert.match(
      generated,
      /__raceResult\.a\s*&&\s*\(?await\s+(services\.)?svc\.fetch/,
      `\`r.a && (await svc.fetch(r.a))\` must preserve the && short-circuit:\n${generated}`,
    );
  });
});

describe('race-branch await patterns: destructuring binds', () => {
  // `const { a, b } = await svc.x()` and `const [a, b] = await svc.x()`
  // inside a race branch body. The entire `await svc.x()` call was previously
  // dropped from emitted code. Fixed in the BLOCK-body destructuring path.
  it('`const { a, b } = await svc.x(...)` should emit the service call', () => {
    const code = `async () => {
      while (true) {
        const r = race();
        switch (true) {
          case signal(r, deps.signals.req): {
            const { a, b } = await svc.pair(r.id);
            await svc.use(a, b);
            break;
          }
        }
      }
    }`;
    const generated = generate(code);

    assert.match(
      generated,
      /await\s+(services\.)?svc\.pair/,
      `\`const { a, b } = await svc.pair(...)\` must emit the service call:\n${generated}`,
    );
  });

  it('`const [a, b] = await svc.x(...)` should emit the service call', () => {
    const code = `async () => {
      while (true) {
        const r = race();
        switch (true) {
          case signal(r, deps.signals.req): {
            const [x, y] = await svc.tuple(r.id);
            await svc.use(x, y);
            break;
          }
        }
      }
    }`;
    const generated = generate(code);

    assert.match(
      generated,
      /await\s+(services\.)?svc\.tuple/,
      `\`const [x, y] = await svc.tuple(...)\` must emit the service call:\n${generated}`,
    );
  });
});
