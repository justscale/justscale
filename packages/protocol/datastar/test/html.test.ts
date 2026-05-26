import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { html, rawHtml } from '../src/html.js';

describe('html tagged template', () => {
  it('returns static template with no interpolations untouched', () => {
    const out = html`<div>static</div>`;
    assert.equal(out, '<div>static</div>');
  });

  it('escapes &, <, >, ", and \' in interpolated strings', () => {
    const payload = '&<>"\'';
    const out = html`<p>${payload}</p>`;
    assert.equal(out, '<p>&amp;&lt;&gt;&quot;&#39;</p>');
  });

  it('escapes a script-injection payload', () => {
    const name = "<script>alert('xss')</script>";
    const out = html`<div>Hello, ${name}!</div>`;
    assert.equal(
      out,
      '<div>Hello, &lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;!</div>',
    );
  });

  it('treats nullish interpolations as empty strings', () => {
    const out = html`<b>${undefined}|${null}</b>`;
    assert.equal(out, '<b>|</b>');
  });

  it('coerces non-string interpolations via String() then escapes them', () => {
    // Numbers/booleans contain no HTML-sensitive characters, so escaping is a
    // no-op for them — the output is unchanged.
    const out = html`<span>${42}-${true}-${false}</span>`;
    assert.equal(out, '<span>42-true-false</span>');
  });

  it('escapes array interpolations (regression: arrays used to slip through)', () => {
    // `typeof value === 'string'` was the old gate, so an array of markup was
    // String()-coerced and emitted unescaped — an XSS hole. It must be escaped.
    const out = html`<ul>${['<img onerror=alert(1)>']}</ul>`;
    assert.equal(out, '<ul>&lt;img onerror=alert(1)&gt;</ul>');
  });

  it('escapes objects whose toString returns markup', () => {
    const evil = { toString() { return "<script>alert('xss')</script>"; } };
    const out = html`<div>${evil}</div>`;
    assert.equal(
      out,
      '<div>&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;</div>',
    );
  });

  it('does NOT escape characters inside the static parts of the template', () => {
    const name = 'world';
    const out = html`<a title="a & b">${name}</a>`;
    // The `&` in the static part stays literal; only interpolations are escaped.
    assert.equal(out, '<a title="a & b">world</a>');
  });

  it('escapes each interpolation independently', () => {
    const a = '<a>';
    const b = '<b>';
    const out = html`${a}|${b}`;
    assert.equal(out, '&lt;a&gt;|&lt;b&gt;');
  });
});

describe('rawHtml tagged template', () => {
  it('inlines interpolated strings without escaping', () => {
    const trusted = '<strong>Bold</strong>';
    const out = rawHtml`<div>${trusted}</div>`;
    assert.equal(out, '<div><strong>Bold</strong></div>');
  });

  it('treats nullish interpolations as empty strings', () => {
    const out = rawHtml`[${undefined}][${null}]`;
    assert.equal(out, '[][]');
  });

  it('does not coerce non-string values with String() but also does not throw', () => {
    // rawHtml simply uses `values[i] ?? ''`, so numbers concatenate via the
    // implicit + coercion. Lock in the current behaviour.
    const out = rawHtml`n=${42}`;
    assert.equal(out, 'n=42');
  });
});
