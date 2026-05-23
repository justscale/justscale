import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  isServiceDef,
  isControllerDef,
  isRepositoryBinding,
  isServiceBinding,
  isInstanceBinding,
  isFeatureToken,
  isBuilderCallback,
  isComponentArray,
  REPO_BINDING,
  SERVICE_BINDING,
  INSTANCE_BINDING,
  FEATURE_TOKEN,
  FEATURE_META,
} from './types.js';
import { defineService } from '../core/service.js';
import { createController } from '../core/controller.js';

describe('Type Guards', () => {
  describe('isServiceDef', () => {
    it('should return true for defineService object-form result', () => {
      const service = defineService({
        inject: {},
        factory: () => ({ value: 42 }),
      });

      assert.strictEqual(isServiceDef(service), true);
    });

    it('should return true for defineService result (Service with deps/factory)', () => {
      // defineService returns a function with deps/factory as static properties
      // isServiceDef recognizes both object-form and class-extends-function forms
      // because both have deps and factory and need to be tracked for validation
      class TestService extends defineService({
        inject: {},
        factory: () => ({ value: 42 }),
      }) {}

      assert.strictEqual(isServiceDef(TestService), true);
    });

    it('should return false for plain object', () => {
      assert.strictEqual(isServiceDef({}), false);
    });

    it('should return false for null', () => {
      assert.strictEqual(isServiceDef(null), false);
    });

    it('should return false for undefined', () => {
      assert.strictEqual(isServiceDef(undefined), false);
    });

    it('should return false for function', () => {
      assert.strictEqual(isServiceDef(() => {}), false);
    });

    it('should return false for class without service definition', () => {
      class PlainClass {}
      assert.strictEqual(isServiceDef(PlainClass), false);
    });

    it('should return false for object with only deps', () => {
      assert.strictEqual(isServiceDef({ deps: {} }), false);
    });

    it('should return false for object with only factory', () => {
      assert.strictEqual(isServiceDef({ factory: () => {} }), false);
    });
  });

  describe('isControllerDef', () => {
    it('should return true for createController result', () => {
      const controller = createController({
        inject: {},
        routes: () => ({}),
      });

      assert.strictEqual(isControllerDef(controller), true);
    });

    it('should return false for plain object', () => {
      assert.strictEqual(isControllerDef({}), false);
    });

    it('should return false for null', () => {
      assert.strictEqual(isControllerDef(null), false);
    });

    it('should return false for service def', () => {
      const service = defineService({
        inject: {},
        factory: () => ({}),
      });
      assert.strictEqual(isControllerDef(service), false);
    });

    it('should return false for object with only settings', () => {
      assert.strictEqual(isControllerDef({ settings: {} }), false);
    });

    it('should return false for object with settings and factory but no prefix', () => {
      assert.strictEqual(
        isControllerDef({ settings: {}, factory: () => {} }),
        false
      );
    });
  });

  describe('isRepositoryBinding', () => {
    it('should return true for valid repository binding', () => {
      const binding = {
        [REPO_BINDING]: true,
        token: {},
        implementation: {},
      };

      assert.strictEqual(isRepositoryBinding(binding), true);
    });

    it('should return false for object without symbol', () => {
      assert.strictEqual(isRepositoryBinding({}), false);
    });

    it('should return false for object with symbol set to false', () => {
      const binding = { [REPO_BINDING]: false };
      assert.strictEqual(isRepositoryBinding(binding), false);
    });

    it('should return false for null', () => {
      assert.strictEqual(isRepositoryBinding(null), false);
    });

    it('should return false for undefined', () => {
      assert.strictEqual(isRepositoryBinding(undefined), false);
    });

    it('should return false for array', () => {
      assert.strictEqual(isRepositoryBinding([]), false);
    });
  });

  describe('isServiceBinding', () => {
    it('should return true for valid service binding', () => {
      const binding = {
        [SERVICE_BINDING]: true,
        token: {},
        implementation: {},
      };

      assert.strictEqual(isServiceBinding(binding), true);
    });

    it('should return false for object without symbol', () => {
      assert.strictEqual(isServiceBinding({}), false);
    });

    it('should return false for object with symbol set to false', () => {
      const binding = { [SERVICE_BINDING]: false };
      assert.strictEqual(isServiceBinding(binding), false);
    });

    it('should return false for null', () => {
      assert.strictEqual(isServiceBinding(null), false);
    });

    it('should return false for repository binding', () => {
      const repoBinding = { [REPO_BINDING]: true };
      assert.strictEqual(isServiceBinding(repoBinding), false);
    });
  });

  describe('isInstanceBinding', () => {
    it('should return true for valid instance binding', () => {
      const binding = {
        [INSTANCE_BINDING]: true,
        token: {},
        instance: {},
      };

      assert.strictEqual(isInstanceBinding(binding), true);
    });

    it('should return false for object without symbol', () => {
      assert.strictEqual(isInstanceBinding({}), false);
    });

    it('should return false for object with symbol set to false', () => {
      const binding = { [INSTANCE_BINDING]: false };
      assert.strictEqual(isInstanceBinding(binding), false);
    });

    it('should return false for null', () => {
      assert.strictEqual(isInstanceBinding(null), false);
    });

    it('should return false for service binding', () => {
      const serviceBinding = { [SERVICE_BINDING]: true };
      assert.strictEqual(isInstanceBinding(serviceBinding), false);
    });
  });

  describe('isFeatureToken', () => {
    it('should return true for valid feature token', () => {
      const feature = Object.assign(
        (builder: any) => builder,
        {
          [FEATURE_TOKEN]: true,
          [FEATURE_META]: { requires: [] },
        }
      );

      assert.strictEqual(isFeatureToken(feature), true);
    });

    it('should return false for regular function', () => {
      assert.strictEqual(isFeatureToken(() => {}), false);
    });

    it('should return false for object', () => {
      assert.strictEqual(isFeatureToken({}), false);
    });

    it('should return false for null', () => {
      assert.strictEqual(isFeatureToken(null), false);
    });

    it('should return false for function with symbol set to false', () => {
      const fn = Object.assign(() => {}, { [FEATURE_TOKEN]: false });
      assert.strictEqual(isFeatureToken(fn), false);
    });

    it('should return false for service def', () => {
      const service = defineService({
        inject: {},
        factory: () => ({}),
      });
      assert.strictEqual(isFeatureToken(service), false);
    });
  });

  describe('isBuilderCallback', () => {
    it('should return true for regular function', () => {
      const callback = (builder: any) => builder;
      assert.strictEqual(isBuilderCallback(callback), true);
    });

    it('should return true for arrow function', () => {
      assert.strictEqual(isBuilderCallback((b: any) => b), true);
    });

    it('should return false for feature token (function with FEATURE_TOKEN)', () => {
      const feature = Object.assign(
        (builder: any) => builder,
        {
          [FEATURE_TOKEN]: true,
          [FEATURE_META]: { requires: [] },
        }
      );
      assert.strictEqual(isBuilderCallback(feature), false);
    });

    it('should return false for object', () => {
      assert.strictEqual(isBuilderCallback({}), false);
    });

    it('should return false for null', () => {
      assert.strictEqual(isBuilderCallback(null), false);
    });

    it('should return false for string', () => {
      assert.strictEqual(isBuilderCallback('function'), false);
    });
  });

  describe('isComponentArray', () => {
    it('should return true for empty array', () => {
      assert.strictEqual(isComponentArray([]), true);
    });

    it('should return true for array with components', () => {
      const service = defineService({
        inject: {},
        factory: () => ({}),
      });
      assert.strictEqual(isComponentArray([service]), true);
    });

    it('should return false for object', () => {
      assert.strictEqual(isComponentArray({}), false);
    });

    it('should return false for null', () => {
      assert.strictEqual(isComponentArray(null), false);
    });

    it('should return false for string', () => {
      assert.strictEqual(isComponentArray('[]'), false);
    });

    it('should return false for service def (not array)', () => {
      const service = defineService({
        inject: {},
        factory: () => ({}),
      });
      assert.strictEqual(isComponentArray(service), false);
    });
  });

  describe('edge cases', () => {
    it('should handle prototype pollution attempts', () => {
      const malicious = Object.create(null);
      malicious[REPO_BINDING] = true;

      // Should still work correctly with Object.create(null) objects
      assert.strictEqual(isRepositoryBinding(malicious), true);
    });

    it('should handle frozen objects', () => {
      const frozen = Object.freeze({
        [SERVICE_BINDING]: true,
        token: {},
        implementation: {},
      });

      assert.strictEqual(isServiceBinding(frozen), true);
    });

    it('should handle proxy objects', () => {
      const target = { [INSTANCE_BINDING]: true, token: {}, instance: {} };
      const proxy = new Proxy(target, {});

      assert.strictEqual(isInstanceBinding(proxy), true);
    });

    it('should distinguish between similar binding types', () => {
      const repoBinding = { [REPO_BINDING]: true };
      const serviceBinding = { [SERVICE_BINDING]: true };
      const instanceBinding = { [INSTANCE_BINDING]: true };

      // Each type guard should only match its own type
      assert.strictEqual(isRepositoryBinding(repoBinding), true);
      assert.strictEqual(isServiceBinding(repoBinding), false);
      assert.strictEqual(isInstanceBinding(repoBinding), false);

      assert.strictEqual(isRepositoryBinding(serviceBinding), false);
      assert.strictEqual(isServiceBinding(serviceBinding), true);
      assert.strictEqual(isInstanceBinding(serviceBinding), false);

      assert.strictEqual(isRepositoryBinding(instanceBinding), false);
      assert.strictEqual(isServiceBinding(instanceBinding), false);
      assert.strictEqual(isInstanceBinding(instanceBinding), true);
    });
  });
});
