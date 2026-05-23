/**
 * Invariant tests: file upload / multipart middleware.
 *
 * Pins:
 *  - `upload` is a plain middleware function - `.use(upload)` (no `upload()`)
 *  - Multipart body becomes `{ files: Map, fields: Record }`
 *  - Non-multipart content (plain JSON) - both files and fields are empty
 *  - File fields (with `filename=`) land in `files` Map
 *  - Plain fields (no `filename=`) land in `fields` object
 *  - Multiple files under distinct names - all present
 *  - Same field name used twice (files) - only ONE wins (Map overwrite -
 *    pin current; multipart allows multi-value but this impl does not)
 *  - MIME type parsed from Content-Type header per part
 *  - Mixed: plain field + file in same upload - both accessible to handler
 *
 * Streaming: the current parser is buffered-in-memory (readBody pulls the
 * full Buffer before multipart parsing). Large-file streaming is NOT
 * supported - pin that as a TODO for the framework, not as a test we can
 * currently write.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { executeRoute } from '@justscale/core';
import { Post } from '../src/builder/create-http-builder.js';
import { upload, type ParsedUpload } from '../src/builder/plugins/upload.js';

function makeMultipart(parts: Array<
  | { name: string; value: string }
  | { name: string; filename: string; content: string; type?: string }
>): { body: Buffer; contentType: string } {
  const boundary = '----testboundary' + Math.random().toString(36).slice(2);
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if ('value' in part) {
      chunks.push(Buffer.from(
        `Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`,
      ));
    } else {
      chunks.push(Buffer.from(
        `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`
        + `Content-Type: ${part.type ?? 'application/octet-stream'}\r\n\r\n${part.content}\r\n`,
      ));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function mockRes() {
  const res: any = {
    status(code: number) { return { json() {}, end() {} }; },
    json() {},
    error() {},
  };
  return res;
}

describe('HTTP upload / multipart', () => {
  it('.use(upload) on a route adds files + fields to context', async () => {
    const { body, contentType } = makeMultipart([
      { name: 'file', filename: 'a.txt', content: 'hello' },
    ]);

    let captured: ParsedUpload | undefined;
    const route = Post('/up')
      .use(upload)
      .handle((ctx: any) => {
        captured = { files: ctx.files, fields: ctx.fields };
      });

    await executeRoute(route, {
      rawBody: body,
      headers: { 'content-type': contentType },
      res: mockRes(),
    });

    assert.ok(captured);
    assert.strictEqual(captured!.files.size, 1);
    const f = captured!.files.get('file')!;
    assert.strictEqual(f.filename, 'a.txt');
    assert.strictEqual(f.buffer.toString(), 'hello');
    assert.strictEqual(f.size, 5);
  });

  it('non-multipart body -> files empty, fields empty (middleware does not fail)', async () => {
    let captured: ParsedUpload | undefined;
    const route = Post('/up')
      .use(upload)
      .handle((ctx: any) => {
        captured = { files: ctx.files, fields: ctx.fields };
      });

    await executeRoute(route, {
      rawBody: { json: 'body' } as any,
      headers: { 'content-type': 'application/json' },
      res: mockRes(),
    });

    assert.ok(captured);
    assert.strictEqual(captured!.files.size, 0);
    assert.deepStrictEqual(captured!.fields, {});
  });

  it('mixed: plain field + file part - both reach handler', async () => {
    const { body, contentType } = makeMultipart([
      { name: 'caption', value: 'my photo' },
      { name: 'photo', filename: 'p.jpg', content: 'JPEGDATA', type: 'image/jpeg' },
    ]);

    let captured: ParsedUpload | undefined;
    const route = Post('/up')
      .use(upload)
      .handle((ctx: any) => { captured = { files: ctx.files, fields: ctx.fields }; });

    await executeRoute(route, {
      rawBody: body,
      headers: { 'content-type': contentType },
      res: mockRes(),
    });

    assert.strictEqual(captured!.fields.caption, 'my photo');
    assert.strictEqual(captured!.files.get('photo')?.mimeType, 'image/jpeg');
    assert.strictEqual(captured!.files.get('photo')?.filename, 'p.jpg');
  });

  it('multiple distinct files - all present', async () => {
    const { body, contentType } = makeMultipart([
      { name: 'a', filename: 'a.txt', content: 'AAA' },
      { name: 'b', filename: 'b.txt', content: 'BBB' },
      { name: 'c', filename: 'c.txt', content: 'CCC' },
    ]);

    let captured: ParsedUpload | undefined;
    const route = Post('/up')
      .use(upload)
      .handle((ctx: any) => { captured = { files: ctx.files, fields: ctx.fields }; });

    await executeRoute(route, {
      rawBody: body,
      headers: { 'content-type': contentType },
      res: mockRes(),
    });

    assert.strictEqual(captured!.files.size, 3);
    assert.strictEqual(captured!.files.get('a')?.buffer.toString(), 'AAA');
    assert.strictEqual(captured!.files.get('b')?.buffer.toString(), 'BBB');
    assert.strictEqual(captured!.files.get('c')?.buffer.toString(), 'CCC');
  });

  it('COLLISION PIN: same field name used twice - second file overwrites first (Map.set)', async () => {
    // Multipart spec technically allows multi-value; this impl uses a Map
    // keyed by name, so only the last one survives. Pin so regressions are
    // visible.
    const { body, contentType } = makeMultipart([
      { name: 'file', filename: 'first.txt', content: 'FIRST' },
      { name: 'file', filename: 'second.txt', content: 'SECOND' },
    ]);

    let captured: ParsedUpload | undefined;
    const route = Post('/up')
      .use(upload)
      .handle((ctx: any) => { captured = { files: ctx.files, fields: ctx.fields }; });

    await executeRoute(route, {
      rawBody: body,
      headers: { 'content-type': contentType },
      res: mockRes(),
    });

    assert.strictEqual(captured!.files.size, 1);
    assert.strictEqual(captured!.files.get('file')?.filename, 'second.txt');
  });

  it('content-type missing boundary -> empty result (bail-out path)', async () => {
    let captured: ParsedUpload | undefined;
    const route = Post('/up')
      .use(upload)
      .handle((ctx: any) => { captured = { files: ctx.files, fields: ctx.fields }; });

    // multipart content type but missing boundary param
    await executeRoute(route, {
      rawBody: Buffer.from('junk'),
      headers: { 'content-type': 'multipart/form-data' },
      res: mockRes(),
    });
    assert.strictEqual(captured!.files.size, 0);
    assert.deepStrictEqual(captured!.fields, {});
  });

  it('MIME type defaults to application/octet-stream when part has no Content-Type', async () => {
    // Hand-craft a part without Content-Type to verify the default.
    const boundary = '----bnd';
    const body = Buffer.from(
      `--${boundary}\r\n`
      + 'Content-Disposition: form-data; name="file"; filename="x.bin"\r\n\r\n'
      + `BYTES\r\n--${boundary}--\r\n`,
    );

    let captured: ParsedUpload | undefined;
    const route = Post('/up')
      .use(upload)
      .handle((ctx: any) => { captured = { files: ctx.files, fields: ctx.fields }; });

    await executeRoute(route, {
      rawBody: body,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      res: mockRes(),
    });

    assert.strictEqual(captured!.files.get('file')?.mimeType, 'application/octet-stream');
  });

  it('upload is exported as a plain function, not a middleware builder', () => {
    assert.strictEqual(typeof upload, 'function');
    // Passing one argument (ctx) invokes it directly - not `upload()` then pass ctx.
    const result = upload({
      rawBody: 'not-buffer' as any,
      headers: { 'content-type': 'text/plain' },
    });
    assert.strictEqual(result.files.size, 0);
  });

  // todo: streaming large files without buffering the whole Buffer in memory.
  //   Current impl reads full body into a Buffer via readBody() before
  //   parseMultipart runs. A 500MB upload uses 500MB of RAM. When this is
  //   fixed (streaming parser), add a test that uploads a large file and
  //   asserts peak heap stays bounded.
});
