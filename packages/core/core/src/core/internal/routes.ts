/**
 * Internal Route Utilities
 *
 * Helper functions for route compilation and matching.
 * Not part of the public API.
 */

/**
 * Join controller prefix and route path cleanly.
 * Returns both the full path string and an array of segments.
 *
 * Examples:
 * - /players + / = { path: '/players', segments: ['players'] }
 * - /players + /:id = { path: '/players/:id', segments: ['players', ':id'] }
 * - auth + create-user = { path: 'auth/create-user', segments: ['auth', 'create-user'] }
 * - '' + shell = { path: 'shell', segments: ['shell'] }
 */
export function joinPaths(prefix: string, path: string): { path: string; segments: string[] } {
  // Parse prefix into segments (filter empty strings from leading/trailing slashes)
  const prefixSegments = prefix.split('/').filter(s => s !== '');

  // Parse path into segments
  const pathSegments = (path === '/' || path === '')
    ? []
    : path.split('/').filter(s => s !== '');

  // Combine segments
  const segments = [...prefixSegments, ...pathSegments];

  // Build path string - HTTP routes need leading slash, CLI routes don't
  // We check both prefix and path to determine this (prefix takes priority, then path)
  const needsLeadingSlash = prefix.startsWith('/') || (prefix === '' && path.startsWith('/'));
  const fullPath = segments.length === 0
    ? '/'
    : (needsLeadingSlash ? '/' : '') + segments.join('/');

  return { path: fullPath, segments };
}

/** Compile a path pattern to regex */
export function compilePath(path: string): { pattern: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  let pattern = path.replace(/:(\w+)/g, (_, name) => {
    paramNames.push(name);
    return '([^/]+)';
  });

  // Make trailing slash optional: /players matches both /players and /players/
  pattern = pattern + '/?';

  return {
    pattern: new RegExp(`^${pattern}$`),
    paramNames,
  };
}
