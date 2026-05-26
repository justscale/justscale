import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  encodeExecuteScript,
  encodeHeartbeat,
  encodeMergeFragments,
  encodeMergeSignals,
  encodeRemoveFragments,
  encodeRemoveSignals,
} from '../src/encoder.js';

describe('encodeMergeSignals', () => {
  it('produces a datastar-merge-signals frame with a JSON data prefix and blank-line terminator', () => {
    const out = encodeMergeSignals({ counter: 42 });
    assert.equal(
      out,
      'event: datastar-merge-signals\ndata: signals {"counter":42}\n\n',
    );
  });

  it('serializes nested objects and arrays via JSON.stringify', () => {
    const out = encodeMergeSignals({ user: { id: 1, tags: ['a', 'b'] } });
    assert.equal(
      out,
      'event: datastar-merge-signals\ndata: signals {"user":{"id":1,"tags":["a","b"]}}\n\n',
    );
  });

  it('emits an empty-object payload rather than dropping the data line', () => {
    const out = encodeMergeSignals({});
    assert.equal(out, 'event: datastar-merge-signals\ndata: signals {}\n\n');
  });
});

describe('encodeMergeFragments', () => {
  it('produces a single-line fragments frame with no options', () => {
    const out = encodeMergeFragments('<div>hi</div>');
    assert.equal(
      out,
      'event: datastar-merge-fragments\ndata: fragments <div>hi</div>\n\n',
    );
  });

  it('splits multi-line HTML across repeated data: fragments lines', () => {
    const html = '<div>\n  <p>line</p>\n</div>';
    const out = encodeMergeFragments(html);
    assert.equal(
      out,
      'event: datastar-merge-fragments\n'
      + 'data: fragments <div>\n'
      + 'data: fragments   <p>line</p>\n'
      + 'data: fragments </div>\n'
      + '\n',
    );
  });

  it('emits selector and mergeMode data lines before the fragments payload', () => {
    const out = encodeMergeFragments('<span>ok</span>', {
      selector: '#target',
      mergeMode: 'append',
    });
    assert.equal(
      out,
      'event: datastar-merge-fragments\n'
      + 'data: selector #target\n'
      + 'data: mergeMode append\n'
      + 'data: fragments <span>ok</span>\n'
      + '\n',
    );
  });

  it('emits only the provided optional data lines (selector without mergeMode)', () => {
    const out = encodeMergeFragments('<p>x</p>', { selector: '.card' });
    assert.equal(
      out,
      'event: datastar-merge-fragments\n'
      + 'data: selector .card\n'
      + 'data: fragments <p>x</p>\n'
      + '\n',
    );
  });
});

describe('encodeRemoveFragments', () => {
  it('emits datastar-remove-fragments with a selector data line', () => {
    const out = encodeRemoveFragments('#todo-42');
    assert.equal(
      out,
      'event: datastar-remove-fragments\ndata: selector #todo-42\n\n',
    );
  });
});

describe('encodeRemoveSignals', () => {
  it('joins an array of paths with a single space', () => {
    const out = encodeRemoveSignals(['foo.bar', 'baz']);
    assert.equal(
      out,
      'event: datastar-remove-signals\ndata: paths foo.bar baz\n\n',
    );
  });

  it('accepts a pre-joined string without modifying it', () => {
    const out = encodeRemoveSignals('a b c');
    assert.equal(
      out,
      'event: datastar-remove-signals\ndata: paths a b c\n\n',
    );
  });
});

describe('encodeExecuteScript', () => {
  it('produces a bare datastar-execute-script frame when no options are given', () => {
    const out = encodeExecuteScript('console.log(1)');
    assert.equal(
      out,
      'event: datastar-execute-script\ndata: script console.log(1)\n\n',
    );
  });

  it('emits autoRemove and attributes lines when opts are provided', () => {
    const out = encodeExecuteScript('doSomething()', {
      autoRemove: true,
      attributes: { type: 'module', async: 'true' },
    });
    assert.equal(
      out,
      'event: datastar-execute-script\n'
      + 'data: autoRemove true\n'
      + 'data: attributes type="module" async="true"\n'
      + 'data: script doSomething()\n'
      + '\n',
    );
  });

  it('splits multi-line scripts across repeated data: script lines', () => {
    const src = 'const a = 1;\nconsole.log(a);';
    const out = encodeExecuteScript(src);
    assert.equal(
      out,
      'event: datastar-execute-script\n'
      + 'data: script const a = 1;\n'
      + 'data: script console.log(a);\n'
      + '\n',
    );
  });

  it('omits the attributes line when attributes is an empty object', () => {
    const out = encodeExecuteScript('x()', { attributes: {} });
    assert.equal(
      out,
      'event: datastar-execute-script\ndata: script x()\n\n',
    );
  });
});

describe('encodeHeartbeat', () => {
  it('returns the standard SSE comment-heartbeat frame', () => {
    assert.equal(encodeHeartbeat(), ': heartbeat\n\n');
  });
});

describe('SSE injection hardening (single-line control fields strip CR/LF)', () => {
  it('a newline in selector cannot inject a second SSE event', () => {
    const out = encodeMergeFragments('<div>ok</div>', {
      selector: "#x\nevent: datastar-execute-script\ndata: script alert(document.cookie)",
      mergeMode: 'append',
    });
    // The selector text survives as inert data, but it must NOT start a new
    // line — a smuggled event would appear as "\nevent: ...".
    assert.ok(!out.includes('\nevent: datastar-execute-script'), 'must not inject an event line');
    assert.equal(
      out,
      'event: datastar-merge-fragments\n'
      + 'data: selector #x event: datastar-execute-script data: script alert(document.cookie)\n'
      + 'data: mergeMode append\n'
      + 'data: fragments <div>ok</div>\n'
      + '\n',
    );
  });

  it('strips CR/LF from mergeMode', () => {
    const out = encodeMergeFragments('<p>x</p>', { selector: '#t', mergeMode: 'append\nevil' as never });
    assert.ok(!out.includes('\nevil'), 'newline in mergeMode must not start a new line');
    assert.ok(out.includes('data: mergeMode append evil\n'));
  });

  it('strips CR/LF from a remove-fragments selector', () => {
    const out = encodeRemoveFragments("#a\ndata: selector #b");
    assert.equal(out, 'event: datastar-remove-fragments\ndata: selector #a data: selector #b\n\n');
  });

  it('strips CR/LF from remove-signals paths', () => {
    const out = encodeRemoveSignals(['a', "b\nevent: x"]);
    assert.ok(!out.includes('\nevent: x'));
    assert.equal(out, 'event: datastar-remove-signals\ndata: paths a b event: x\n\n');
  });

  it('strips CR/LF from execute-script attribute keys/values', () => {
    const out = encodeExecuteScript('run()', {
      attributes: { type: "module\ndata: script alert(1)" },
    });
    assert.ok(!out.includes('\ndata: script alert(1)'), 'attribute value must not break the line');
  });
});
