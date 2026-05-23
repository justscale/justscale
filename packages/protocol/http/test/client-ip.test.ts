/**
 * getClientIp() — trusted-proxy aware client IP resolution.
 *
 * The whole point: if you don't allowlist the proxies you trust, anyone
 * can spoof their X-Forwarded-For. These tests pin the gate.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { getClientIp } from '../src/client-ip.js';

interface FakeReq {
  headers: Record<string, string | string[] | undefined>;
  socket: { remoteAddress?: string };
}

function fakeReq(socket: string, headers: Record<string, string | string[] | undefined> = {}): FakeReq {
  return { headers, socket: { remoteAddress: socket } };
}

describe('getClientIp', () => {
  describe('default (no trusted proxies)', () => {
    it('returns socket.remoteAddress when no XFF header', () => {
      assert.strictEqual(getClientIp(fakeReq('203.0.113.1')), '203.0.113.1');
    });

    it('IGNORES X-Forwarded-For even if present (would be spoofable)', () => {
      const req = fakeReq('203.0.113.1', { 'x-forwarded-for': '1.2.3.4' });
      assert.strictEqual(getClientIp(req), '203.0.113.1');
    });

    it('IGNORES X-Real-IP even if present', () => {
      const req = fakeReq('203.0.113.1', { 'x-real-ip': '1.2.3.4' });
      assert.strictEqual(getClientIp(req), '203.0.113.1');
    });

    it('returns empty string if socket address is missing', () => {
      assert.strictEqual(getClientIp({ headers: {}, socket: {} }), '');
    });
  });

  describe('with trusted proxies', () => {
    it('IGNORES XFF when the immediate peer is not a trusted proxy', () => {
      // 203.0.113.1 is the public IP making the connection. NOT in our
      // trusted list. So we must not trust their XFF — they could lie.
      const req = fakeReq('203.0.113.1', { 'x-forwarded-for': '1.2.3.4' });
      assert.strictEqual(getClientIp(req, ['127.0.0.1']), '203.0.113.1');
    });

    it('honors XFF when the immediate peer is trusted', () => {
      // Connection came from our proxy (127.0.0.1). The XFF chain ends
      // at the original client (1.2.3.4).
      const req = fakeReq('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' });
      assert.strictEqual(getClientIp(req, ['127.0.0.1']), '1.2.3.4');
    });

    it('walks XFF right-to-left, stopping at the first non-trusted IP', () => {
      // Chain: client -> hop1 -> hop2 -> us. We trust hop1 + hop2.
      // The real client is the leftmost non-trusted entry: 1.2.3.4.
      const req = fakeReq('10.0.0.2', {
        'x-forwarded-for': '1.2.3.4, 10.0.0.1, 10.0.0.2',
      });
      assert.strictEqual(getClientIp(req, ['10.0.0.1', '10.0.0.2']), '1.2.3.4');
    });

    it('stops at the rightmost non-trusted entry even if more hops follow', () => {
      // Chain: 1.2.3.4 -> rogue.5.5.5 -> 10.0.0.1 -> us.
      // 5.5.5.5 isn't trusted, so we treat IT as the client (could be a
      // proxy lying upstream of our trust boundary).
      const req = fakeReq('10.0.0.1', {
        'x-forwarded-for': '1.2.3.4, 5.5.5.5, 10.0.0.1',
      });
      assert.strictEqual(getClientIp(req, ['10.0.0.1']), '5.5.5.5');
    });

    it('falls back to X-Real-IP when XFF absent and peer is trusted', () => {
      const req = fakeReq('127.0.0.1', { 'x-real-ip': '1.2.3.4' });
      assert.strictEqual(getClientIp(req, ['127.0.0.1']), '1.2.3.4');
    });

    it('falls back to socket address when whole XFF chain is trusted', () => {
      // All entries are our own proxies. There's no untrusted "real
      // client" to surface — the actual peer is the closest proxy.
      const req = fakeReq('10.0.0.1', {
        'x-forwarded-for': '10.0.0.2, 10.0.0.1',
      });
      assert.strictEqual(getClientIp(req, ['10.0.0.1', '10.0.0.2']), '10.0.0.1');
    });

    it('handles array-valued XFF header (Node may parse multiple as array)', () => {
      const req = fakeReq('127.0.0.1', { 'x-forwarded-for': ['1.2.3.4'] });
      assert.strictEqual(getClientIp(req, ['127.0.0.1']), '1.2.3.4');
    });

    it('trims whitespace in XFF entries', () => {
      const req = fakeReq('127.0.0.1', { 'x-forwarded-for': ' 1.2.3.4 ' });
      assert.strictEqual(getClientIp(req, ['127.0.0.1']), '1.2.3.4');
    });
  });
});
