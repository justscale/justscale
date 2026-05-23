/**
 * HMR Change Detector Tests
 *
 * Tests for detecting changes between versions of service files.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { detectChanges, mightContainServices } from '../src/compiler/hmr-change-detector.js';

const baseDir = '/project';
const fileName = '/project/src/services/cache.ts';

describe('HMR Change Detector', () => {
  describe('mightContainServices', () => {
    it('should return true for files with defineService', () => {
      const source = `
import { defineService } from '@justscale/core'
class MyService extends defineService({}) {}
`;
      assert.ok(mightContainServices(source));
    });

    it('should return false for files without defineService', () => {
      const source = `
export const config = { port: 6142 }
`;
      assert.ok(!mightContainServices(source));
    });
  });

  describe('No changes', () => {
    it('should detect no changes for identical files', () => {
      const source = `
import { defineService } from '@justscale/core'

class CacheService extends defineService({
  inject: {},
  factory: () => ({
    get: (k: string) => k,
  })
}) {}
`;
      const result = detectChanges(source, source, fileName, baseDir);

      assert.strictEqual(result.hasChanges, false);
      assert.strictEqual(result.services.length, 0);
      assert.strictEqual(result.added.length, 0);
      assert.strictEqual(result.removed.length, 0);
    });

    it('should ignore whitespace changes', () => {
      const oldSource = `
import { defineService } from '@justscale/core'
class CacheService extends defineService({
  inject: {},
  factory: () => ({
    get: (k: string) => k,
  })
}) {}
`;
      const newSource = `
import { defineService } from '@justscale/core'

class CacheService extends defineService({
  inject: {},
  factory: () => ({
    get: (k: string) => k,
  })
}) {}
`;
      const result = detectChanges(oldSource, newSource, fileName, baseDir);
      assert.strictEqual(result.hasChanges, false);
    });
  });

  describe('Structural changes', () => {
    it('should detect inject dependency changes as structural', () => {
      const oldSource = `
import { defineService, Lifecycle } from '@justscale/core'

class CacheService extends defineService({
  inject: { lifecycle: Lifecycle },
  factory: ({ lifecycle }) => ({
    get: (k: string) => k,
  })
}) {}
`;
      const newSource = `
import { defineService, Lifecycle, Logger } from '@justscale/core'

class CacheService extends defineService({
  inject: { lifecycle: Lifecycle, logger: Logger },
  factory: ({ lifecycle, logger }) => ({
    get: (k: string) => k,
  })
}) {}
`;
      const result = detectChanges(oldSource, newSource, fileName, baseDir);

      assert.strictEqual(result.hasChanges, true);
      assert.strictEqual(result.services.length, 1);
      assert.strictEqual(result.services[0].changeType, 'structural');
      assert.ok(result.services[0].reason.includes('inject'));
    });

    it('should detect method additions as structural', () => {
      const oldSource = `
import { defineService } from '@justscale/core'

class CacheService extends defineService({
  inject: {},
  factory: () => ({
    get: (k: string) => k,
  })
}) {}
`;
      const newSource = `
import { defineService } from '@justscale/core'

class CacheService extends defineService({
  inject: {},
  factory: () => ({
    get: (k: string) => k,
    set: (k: string, v: string) => {},
  })
}) {}
`;
      const result = detectChanges(oldSource, newSource, fileName, baseDir);

      assert.strictEqual(result.hasChanges, true);
      assert.strictEqual(result.services[0].changeType, 'structural');
      assert.ok(result.services[0].reason.includes('added'));
    });

    it('should detect method removals as structural', () => {
      const oldSource = `
import { defineService } from '@justscale/core'

class CacheService extends defineService({
  inject: {},
  factory: () => ({
    get: (k: string) => k,
    set: (k: string, v: string) => {},
  })
}) {}
`;
      const newSource = `
import { defineService } from '@justscale/core'

class CacheService extends defineService({
  inject: {},
  factory: () => ({
    get: (k: string) => k,
  })
}) {}
`;
      const result = detectChanges(oldSource, newSource, fileName, baseDir);

      assert.strictEqual(result.hasChanges, true);
      assert.strictEqual(result.services[0].changeType, 'structural');
      assert.ok(result.services[0].reason.includes('removed'));
    });

    it('should detect method signature changes as structural', () => {
      const oldSource = `
import { defineService } from '@justscale/core'

class CacheService extends defineService({
  inject: {},
  factory: () => ({
    get: (k: string) => k,
  })
}) {}
`;
      const newSource = `
import { defineService } from '@justscale/core'

class CacheService extends defineService({
  inject: {},
  factory: () => ({
    get: (k: string, defaultValue: string) => k,
  })
}) {}
`;
      const result = detectChanges(oldSource, newSource, fileName, baseDir);

      assert.strictEqual(result.hasChanges, true);
      assert.strictEqual(result.services[0].changeType, 'structural');
      assert.ok(result.services[0].reason.includes('signature'));
    });

    it('should detect type-only parameter changes as structural', () => {
      const oldSource = `
import { defineService } from '@justscale/core'

class CacheService extends defineService({
  inject: {},
  factory: () => ({
    process: (x: string) => x,
  })
}) {}
`;
      const newSource = `
import { defineService } from '@justscale/core'

class CacheService extends defineService({
  inject: {},
  factory: () => ({
    process: (x: number) => x,
  })
}) {}
`;
      const result = detectChanges(oldSource, newSource, fileName, baseDir);

      assert.strictEqual(result.hasChanges, true);
      assert.strictEqual(result.services[0].changeType, 'structural');
      assert.ok(result.services[0].reason.includes('signature'));
    });
  });

  describe('Method-only changes', () => {
    it('should detect method body changes with hotReload hook as method-only', () => {
      const oldSource = `
import { defineService, Lifecycle } from '@justscale/core'

class CacheService extends defineService({
  inject: { lifecycle: Lifecycle },
  factory: ({ lifecycle }) => {
    const cache = new Map()
    lifecycle.register('hotReload', () => ({ cache }))
    return {
      get: (k: string) => cache.get(k),
    }
  }
}) {}
`;
      const newSource = `
import { defineService, Lifecycle } from '@justscale/core'

class CacheService extends defineService({
  inject: { lifecycle: Lifecycle },
  factory: ({ lifecycle }) => {
    const cache = new Map()
    lifecycle.register('hotReload', () => ({ cache }))
    return {
      get: (k: string) => cache.get(k) ?? 'default',
    }
  }
}) {}
`;
      const result = detectChanges(oldSource, newSource, fileName, baseDir);

      assert.strictEqual(result.hasChanges, true);
      assert.strictEqual(result.services.length, 1);
      assert.strictEqual(result.services[0].changeType, 'method-only');
      assert.deepStrictEqual(result.services[0].changedMethods, ['get']);
    });

    it('should detect multiple method body changes', () => {
      const oldSource = `
import { defineService, Lifecycle } from '@justscale/core'

class CacheService extends defineService({
  inject: { lifecycle: Lifecycle },
  factory: ({ lifecycle }) => {
    const cache = new Map()
    lifecycle.register('hotReload', () => ({ cache }))
    return {
      get: (k: string) => cache.get(k),
      has: (k: string) => cache.has(k),
      size: () => cache.size,
    }
  }
}) {}
`;
      const newSource = `
import { defineService, Lifecycle } from '@justscale/core'

class CacheService extends defineService({
  inject: { lifecycle: Lifecycle },
  factory: ({ lifecycle }) => {
    const cache = new Map()
    lifecycle.register('hotReload', () => ({ cache }))
    return {
      get: (k: string) => cache.get(k) ?? null,
      has: (k: string) => Boolean(cache.get(k)),
      size: () => cache.size,
    }
  }
}) {}
`;
      const result = detectChanges(oldSource, newSource, fileName, baseDir);

      assert.strictEqual(result.services[0].changeType, 'method-only');
      assert.ok(result.services[0].changedMethods.includes('get'));
      assert.ok(result.services[0].changedMethods.includes('has'));
      assert.ok(!result.services[0].changedMethods.includes('size'));
    });

    it('should require hotReload hook for method-only changes', () => {
      const oldSource = `
import { defineService } from '@justscale/core'

class CacheService extends defineService({
  inject: {},
  factory: () => ({
    get: (k: string) => k.toUpperCase(),
  })
}) {}
`;
      const newSource = `
import { defineService } from '@justscale/core'

class CacheService extends defineService({
  inject: {},
  factory: () => ({
    get: (k: string) => k.toLowerCase(),
  })
}) {}
`;
      const result = detectChanges(oldSource, newSource, fileName, baseDir);

      // Without hotReload hook, method body changes are structural
      assert.strictEqual(result.services[0].changeType, 'structural');
      assert.ok(result.services[0].reason.includes('no hotReload'));
    });
  });

  describe('Service addition and removal', () => {
    it('should detect new service classes as added', () => {
      const oldSource = `
import { defineService } from '@justscale/core'

class CacheService extends defineService({
  inject: {},
  factory: () => ({})
}) {}
`;
      const newSource = `
import { defineService } from '@justscale/core'

class CacheService extends defineService({
  inject: {},
  factory: () => ({})
}) {}

class LogService extends defineService({
  inject: {},
  factory: () => ({})
}) {}
`;
      const result = detectChanges(oldSource, newSource, fileName, baseDir);

      assert.strictEqual(result.hasChanges, true);
      assert.strictEqual(result.added.length, 1);
      assert.ok(result.added[0].includes('LogService'));
    });

    it('should detect removed service classes', () => {
      const oldSource = `
import { defineService } from '@justscale/core'

class CacheService extends defineService({
  inject: {},
  factory: () => ({})
}) {}

class LogService extends defineService({
  inject: {},
  factory: () => ({})
}) {}
`;
      const newSource = `
import { defineService } from '@justscale/core'

class CacheService extends defineService({
  inject: {},
  factory: () => ({})
}) {}
`;
      const result = detectChanges(oldSource, newSource, fileName, baseDir);

      assert.strictEqual(result.hasChanges, true);
      assert.strictEqual(result.removed.length, 1);
      assert.ok(result.removed[0].includes('LogService'));
    });
  });

  describe('Service ID generation', () => {
    it('should use relative path and class name for service ID', () => {
      const oldSource = `
import { defineService, Lifecycle } from '@justscale/core'

class MyService extends defineService({
  inject: { lifecycle: Lifecycle },
  factory: ({ lifecycle }) => {
    lifecycle.register('hotReload', () => ({}))
    return { foo: () => 1 }
  }
}) {}
`;
      const newSource = `
import { defineService, Lifecycle } from '@justscale/core'

class MyService extends defineService({
  inject: { lifecycle: Lifecycle },
  factory: ({ lifecycle }) => {
    lifecycle.register('hotReload', () => ({}))
    return { foo: () => 2 }
  }
}) {}
`;
      const result = detectChanges(oldSource, newSource, fileName, baseDir);

      assert.strictEqual(result.hasChanges, true);
      assert.strictEqual(result.services.length, 1);
      assert.strictEqual(
        result.services[0].serviceId,
        'src/services/cache.ts#MyService'
      );
    });
  });
});
