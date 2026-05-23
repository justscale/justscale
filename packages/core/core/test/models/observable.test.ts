import assert from 'node:assert';
import { describe, it } from 'node:test';
import { createModelInstance } from '../../src/models/model.js';
import {
  createObservable,
  getModelInternals,
  getObservableInternals,
} from '../../src/models/index.js';
import { z } from 'zod';
import { assertExactPaths } from './helpers.js';

describe('createObservable', () => {
  describe('basic functionality', () => {
    it('should create an observable from plain object', () => {
      const obs = createObservable({ name: 'Alice', score: 100 });

      assert.strictEqual(obs.name, 'Alice');
      assert.strictEqual(obs.score, 100);
    });

    it('should track dirty state with exact path', () => {
      const obs = createObservable({ value: 1 });
      const internals = getObservableInternals(obs);

      assertExactPaths(internals.getDirtyPaths(), []);

      obs.value = 2;

      assertExactPaths(internals.getDirtyPaths(), ['value']);
    });

    it('should track nested changes with parent paths', () => {
      const obs = createObservable({ user: { name: 'Alice' } });
      const internals = getObservableInternals(obs);

      obs.user.name = 'Bob';

      assertExactPaths(internals.getDirtyPaths(), ['user.name', 'user']);
    });
  });

  describe('using observables in models', () => {
    it('should allow passing observable to model', () => {
      const profile = createObservable({ name: 'Alice', score: 100 });

      const schema = z.object({
        user: z.object({
          profile: z.any(),
        }),
      });

      const model = createModelInstance(schema, { user: { profile } });
      const modelInternals = getModelInternals(model);

      // Modify through model
      (model.user.profile as { name: string }).name = 'Bob';

      // Model should be dirty
      assert.strictEqual(modelInternals.isDirty(), true);

      // Observable should also be dirty
      const obsInternals = getObservableInternals(profile);
      assert.strictEqual(obsInternals.isDirty(), true);

      // Value should be updated everywhere
      assert.strictEqual(profile.name, 'Bob');
      assert.strictEqual((model.user.profile as { name: string }).name, 'Bob');
    });

    it('should allow passing model property to another model', () => {
      const schemaA = z.object({
        user: z.object({
          profile: z.any(),
        }),
      });

      const schemaB = z.object({
        ref: z.any(),
      });

      const modelA = createModelInstance(schemaA, { user: { profile: { name: 'Alice' } } });

      // Pass modelA's nested property to modelB
      const modelB = createModelInstance(schemaB, { ref: modelA.user.profile });

      const internalsA = getModelInternals(modelA);
      const internalsB = getModelInternals(modelB);

      // Modify through modelB
      (modelB.ref as { name: string }).name = 'Charlie';

      // Both models should be dirty
      assert.strictEqual(internalsA.isDirty(), true);
      assert.strictEqual(internalsB.isDirty(), true);

      // Both should see the change
      assert.strictEqual((modelA.user.profile as { name: string }).name, 'Charlie');
      assert.strictEqual((modelB.ref as { name: string }).name, 'Charlie');
    });

    it('should allow same observable in multiple models with different paths', () => {
      const shared = createObservable({ value: 42 });

      const schema1 = z.object({ foo: z.any() });
      const schema2 = z.object({ bar: z.any() });

      const model1 = createModelInstance(schema1, { foo: shared });
      const model2 = createModelInstance(schema2, { bar: shared });

      const internals1 = getModelInternals(model1);
      const internals2 = getModelInternals(model2);

      // Modify through model1
      (model1.foo as { value: number }).value = 99;

      // Both should be dirty with their respective paths
      assert.strictEqual(internals1.isDirty(), true);
      assert.strictEqual(internals2.isDirty(), true);

      const paths1 = internals1.getDirtyPaths();
      const paths2 = internals2.getDirtyPaths();

      assert.ok(
        paths1.some((p) => p.startsWith('foo')),
        `Expected "foo" path, got: ${paths1}`,
      );
      assert.ok(
        paths2.some((p) => p.startsWith('bar')),
        `Expected "bar" path, got: ${paths2}`,
      );
    });
  });
});
