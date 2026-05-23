/**
 * Stream / process identity utilities.
 *
 *  - pascalToCamelCase: acronym-aware Pascal → camel
 *  - modelNameToIdentityKey: "Order" → "orderRef"
 *  - parseStreamSignal / buildStreamSignal
 *  - resolveEntityId: lookup strategy (conventional → plain → fallback)
 *  - resolveStreamWildcard: replaces `*` segment with resolved entity id
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  modelNameToIdentityKey,
  pascalToCamelCase,
  parseStreamSignal,
  buildStreamSignal,
  isWildcardStreamSignal,
  resolveEntityId,
  resolveStreamWildcard,
} from '../stream-utils.js';

describe('pascalToCamelCase', () => {
  it('empty string returns empty', () => {
    assert.equal(pascalToCamelCase(''), '');
  });

  it('single char lowercases', () => {
    assert.equal(pascalToCamelCase('A'), 'a');
    assert.equal(pascalToCamelCase('Z'), 'z');
  });

  it('simple Pascal lowercases the first char', () => {
    assert.equal(pascalToCamelCase('Order'), 'order');
  });

  it('compound Pascal keeps later caps', () => {
    assert.equal(pascalToCamelCase('OrderItem'), 'orderItem');
  });

  it('all-uppercase stays all-lowercase', () => {
    assert.equal(pascalToCamelCase('ABC'), 'abc');
  });

  it('acronym-prefixed compound lowercases acronym, keeps next word capped', () => {
    assert.equal(pascalToCamelCase('ABCOrder'), 'abcOrder');
  });

  it('embedded acronym lowercases only leading acronym', () => {
    assert.equal(pascalToCamelCase('HTTPServer'), 'httpServer');
  });

  it('leading non-uppercase string is returned unchanged', () => {
    // "camelCase" already starts lowercase — no transformation applied.
    assert.equal(pascalToCamelCase('camelCase'), 'camelCase');
  });

  it('leading digit followed by uppercase keeps digit segment', () => {
    // Impl does not specifically handle digits — leading non-A-Z falls through.
    // "V2Order" starts with uppercase V so it's processed like HTTPServer family.
    assert.equal(pascalToCamelCase('V2Order'), 'v2Order');
  });
});

describe('modelNameToIdentityKey', () => {
  it('appends Ref suffix to camelCase', () => {
    assert.equal(modelNameToIdentityKey('Order'), 'orderRef');
    assert.equal(modelNameToIdentityKey('OrderItem'), 'orderItemRef');
  });

  it('all-caps model gets lowercased + Ref', () => {
    assert.equal(modelNameToIdentityKey('ABC'), 'abcRef');
  });

  it('empty model name returns "ref" sentinel', () => {
    assert.equal(modelNameToIdentityKey(''), 'ref');
  });

  it('acronym-prefixed model handles properly', () => {
    assert.equal(modelNameToIdentityKey('HTTPServer'), 'httpServerRef');
  });
});

describe('parseStreamSignal', () => {
  it('parses a valid stream signal into components', () => {
    const p = parseStreamSignal('stream:Order:123:statusUpdates');
    assert.deepEqual(p, {
      prefix: 'stream',
      modelName: 'Order',
      entityId: '123',
      fieldName: 'statusUpdates',
    });
  });

  it('parses a wildcard stream signal', () => {
    const p = parseStreamSignal('stream:Order:*:events');
    assert.equal(p?.entityId, '*');
  });

  it('returns null for non-stream signals', () => {
    assert.equal(parseStreamSignal('order.done'), null);
    assert.equal(parseStreamSignal('stream:only:two'), null);
    assert.equal(parseStreamSignal('notstream:a:b:c'), null);
    assert.equal(parseStreamSignal(''), null);
  });

  it('returns null when there are too many colon segments', () => {
    assert.equal(parseStreamSignal('stream:a:b:c:d'), null);
  });
});

describe('buildStreamSignal', () => {
  it('joins parts with colons and stream prefix', () => {
    assert.equal(
      buildStreamSignal('Order', '123', 'status'),
      'stream:Order:123:status',
    );
  });

  it('supports wildcard entity id', () => {
    assert.equal(
      buildStreamSignal('Order', '*', 'events'),
      'stream:Order:*:events',
    );
  });
});

describe('isWildcardStreamSignal', () => {
  it('true for stream signal with wildcard segment', () => {
    assert.equal(isWildcardStreamSignal('stream:Order:*:events'), true);
  });

  it('false for stream signal without wildcard', () => {
    assert.equal(isWildcardStreamSignal('stream:Order:123:events'), false);
  });

  it('false for non-stream strings', () => {
    assert.equal(isWildcardStreamSignal('order.done'), false);
    assert.equal(isWildcardStreamSignal(''), false);
  });
});

describe('resolveEntityId', () => {
  it('finds by conventional `${name}Ref` key first', () => {
    const r = resolveEntityId('Order', { orderRef: 'abc' });
    assert.equal(r.success, true);
    assert.equal(r.entityId, 'abc');
    assert.equal(r.usedKey, 'orderRef');
    assert.equal(r.usedFallback, false);
  });

  it('falls through to plain lowercased key', () => {
    const r = resolveEntityId('Order', { order: 'xyz' });
    assert.equal(r.success, true);
    assert.equal(r.entityId, 'xyz');
    assert.equal(r.usedKey, 'order');
    assert.equal(r.usedFallback, false);
  });

  it('fallback to any *Ref key if present', () => {
    const r = resolveEntityId('Order', { somethingRef: 'v' });
    assert.equal(r.success, true);
    assert.equal(r.entityId, 'v');
    assert.equal(r.usedFallback, true);
  });

  it('fallback to *Id key when enabled', () => {
    const r = resolveEntityId('Order', { someOtherId: 'v' });
    assert.equal(r.success, true);
    assert.equal(r.entityId, 'v');
    assert.equal(r.usedFallback, true);
  });

  it('fallback to bare "id" or "ref" key', () => {
    assert.equal(resolveEntityId('Order', { id: '1' }).entityId, '1');
    assert.equal(resolveEntityId('Order', { ref: '2' }).entityId, '2');
  });

  it('fails when no identity keys match and useFallback is false', () => {
    const r = resolveEntityId('Order', { foo: '1' }, { useFallback: false });
    assert.equal(r.success, false);
    assert.match(r.error ?? '', /Could not resolve entity ID for model "Order"/);
  });

  it('customIdentityKey overrides default derivation', () => {
    const r = resolveEntityId('Order', { myKey: 'abc' }, { customIdentityKey: 'myKey' });
    assert.equal(r.entityId, 'abc');
    assert.equal(r.usedKey, 'myKey');
  });

  it('customIdentityKey falls back to default if missing', () => {
    const r = resolveEntityId('Order', { orderRef: 'abc' }, { customIdentityKey: 'missing' });
    assert.equal(r.entityId, 'abc');
    assert.equal(r.usedKey, 'orderRef');
  });
});

describe('resolveStreamWildcard', () => {
  it('non-wildcard signal is returned unchanged', () => {
    const r = resolveStreamWildcard('stream:Order:123:events', {});
    assert.equal(r.resolved, 'stream:Order:123:events');
    assert.equal(r.result.success, true);
  });

  it('non-stream signal is returned unchanged', () => {
    const r = resolveStreamWildcard('order.done', {});
    assert.equal(r.resolved, 'order.done');
  });

  it('wildcard with valid identity resolves to concrete signal', () => {
    const r = resolveStreamWildcard('stream:Order:*:events', { orderRef: 'o-1' });
    assert.equal(r.resolved, 'stream:Order:o-1:events');
    assert.equal(r.result.success, true);
  });

  it('wildcard with identity under plain key resolves', () => {
    const r = resolveStreamWildcard('stream:Room:*:events', { room: 'r-1' });
    assert.equal(r.resolved, 'stream:Room:r-1:events');
  });

  it('wildcard with unresolvable identity leaves signal unresolved', () => {
    const r = resolveStreamWildcard('stream:Order:*:events', {});
    assert.equal(r.resolved, 'stream:Order:*:events');
    assert.equal(r.result.success, false);
  });
});
