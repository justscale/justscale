/**
 * HTML Utilities
 *
 * Tagged template functions for safe HTML generation.
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/**
 * Tagged template for HTML with automatic escaping.
 * Use for user-provided content to prevent XSS.
 *
 * Every interpolation is coerced to a string and escaped — including arrays
 * and objects. (An earlier version only escaped `typeof value === 'string'`,
 * which let `${someArray}` or an object with a malicious `toString()` slip
 * through unescaped.) To embed already-trusted markup, use `rawHtml`.
 *
 * @example
 * ```typescript
 * const name = "<script>alert('xss')</script>";
 * html`<div>Hello, ${name}!</div>`
 * // Result: "<div>Hello, &lt;script&gt;alert('xss')&lt;/script&gt;!</div>"
 * ```
 */
export function html(
  strings: TemplateStringsArray,
  ...values: unknown[]
): string {
  let result = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    result += escapeHtml(value == null ? '' : String(value));
    result += strings[i + 1] ?? '';
  }
  return result;
}

/**
 * Tagged template for raw HTML (no escaping).
 * Use only for trusted content or pre-escaped values.
 *
 * @example
 * ```typescript
 * const trustedHtml = "<strong>Bold</strong>";
 * rawHtml`<div>${trustedHtml}</div>`
 * // Result: "<div><strong>Bold</strong></div>"
 * ```
 */
export function rawHtml(
  strings: TemplateStringsArray,
  ...values: unknown[]
): string {
  return strings.reduce(
    (result, str, i) => result + str + (values[i] ?? ''),
    '',
  );
}
