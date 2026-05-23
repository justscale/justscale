/**
 * Client IP resolution.
 *
 * `req.headers['x-forwarded-for']` is a client-controlled header — anyone
 * can spoof it unless the request actually came through a trusted proxy.
 * Code that records IPs (audit logs, session metadata, rate limit keys)
 * MUST resolve the real client IP through `getClientIp` so a trusted-
 * proxy allowlist actually gates the trust.
 */

/**
 * Minimum request shape for IP resolution. We don't take the full
 * `IncomingMessage` because the auth controller's typed `req` is
 * narrower than the Node type, and tests construct fakes that don't
 * implement the full Socket interface.
 */
export interface ClientIpRequest {
  headers: Record<string, string | string[] | undefined>;
  socket: { remoteAddress?: string };
}

/**
 * Resolve the real client IP for an HTTP request.
 *
 * - If `trustedProxies` is empty: always returns `req.socket.remoteAddress`
 *   (the actual TCP peer). Forwarding headers are ignored entirely.
 * - If the immediate TCP peer is NOT in `trustedProxies`: same — ignore
 *   forwarding headers, return the peer.
 * - If the immediate peer IS trusted: walk the `X-Forwarded-For` chain
 *   right-to-left and return the first IP that isn't itself trusted (the
 *   real client). `X-Forwarded-For` is appended-to by each hop, so the
 *   rightmost entry is the closest trusted proxy and the leftmost is the
 *   original client; we walk from the right and stop as soon as we leave
 *   the trusted-proxy chain.
 *
 * Falls back to `X-Real-IP` if `X-Forwarded-For` is absent (single-hop
 * proxies that set X-Real-IP only).
 *
 * @example
 * ```typescript
 * const ip = getClientIp(req, http.trustedProxies);
 * await sessions.create(user, { ipAddress: ip });
 * ```
 */
export function getClientIp(
  req: ClientIpRequest,
  trustedProxies: readonly string[] = [],
): string {
  const remote = req.socket.remoteAddress ?? '';

  // No proxies trusted → never honor forwarding headers.
  if (trustedProxies.length === 0) return remote;

  // The immediate TCP peer must itself be a trusted proxy for any
  // forwarding header to be meaningful.
  if (!trustedProxies.includes(remote)) return remote;

  const xff = req.headers['x-forwarded-for'];
  if (xff !== undefined) {
    const raw = Array.isArray(xff) ? xff[0] : xff;
    const chain = String(raw)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    // Walk right-to-left, stopping at the first non-trusted entry.
    // That's the original client; everything to its right is one of
    // our own proxies appending its peer.
    for (let i = chain.length - 1; i >= 0; i--) {
      if (!trustedProxies.includes(chain[i])) return chain[i];
    }
    // Whole chain was trusted (unusual) — fall through to remote.
  }

  // Single-hop proxies that only set X-Real-IP.
  const xri = req.headers['x-real-ip'];
  if (xri !== undefined) {
    return String(Array.isArray(xri) ? xri[0] : xri);
  }

  return remote;
}
