import { z } from 'zod';
import { defineConfigPartial } from '@justscale/core';

export const HttpConfig = defineConfigPartial(
  'http',
  z.object({
    // Default 6142 = ord('J') * ord('S').
    port: z.number().int().nonnegative().default(6142),
    host: z.string().default('0.0.0.0'),
    /**
     * Maximum request body size in bytes. Requests exceeding this are
     * rejected with 413 Payload Too Large. Defaults to 1 MB.
     */
    maxBodyBytes: z.number().int().positive().default(1024 * 1024),
    /**
     * CORS allowed origins. Omit (default) for no CORS headers.
     * Use '*' to allow all origins (incompatible with credentials).
     * Use an array to reflect matching origins only.
     */
    allowedOrigins: z.union([z.array(z.string()), z.literal('*')]).optional(),
    /**
     * IP addresses of proxies whose `X-Forwarded-For` / `X-Real-IP` headers
     * should be trusted when resolving the real client IP. Empty (default)
     * means NEVER trust forwarding headers — `getClientIp(req)` returns the
     * raw TCP peer (`req.socket.remoteAddress`).
     *
     * Set this to the IPs of your reverse proxy / load balancer (e.g.
     * `['127.0.0.1', '10.0.0.1']`). Without this, anyone can spoof their
     * source IP by setting `X-Forwarded-For` themselves, leading to lies
     * in audit logs (session.ipAddress, etc.).
     */
    trustedProxies: z.array(z.string()).default([]),
  }),
);

declare module '@justscale/core' {
  interface RegisteredConfigPartials {
    http: typeof HttpConfig;
  }
}
