export interface UploadedFile {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  size: number;
}

export interface ParsedUpload {
  files: Map<string, UploadedFile>;
  fields: Record<string, string>;
}

function indexOfBuffer(haystack: Buffer, needle: Buffer, from = 0): number {
  for (let i = from; i <= haystack.length - needle.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { match = false; break; }
    }
    if (match) return i;
  }
  return -1;
}

function parsePartHeaders(headerStr: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of headerStr.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    headers[line.slice(0, colon).toLowerCase().trim()] = line.slice(colon + 1).trim();
  }
  return headers;
}

function parseMultipart(buffer: Buffer, boundary: string): ParsedUpload {
  const sep = Buffer.from(`\r\n--${boundary}`);
  const preamble = Buffer.from(`--${boundary}`);
  const DBLCRLF = Buffer.from('\r\n\r\n');

  const files = new Map<string, UploadedFile>();
  const fields: Record<string, string> = {};

  let offset = indexOfBuffer(buffer, preamble);
  if (offset === -1) return { files, fields };
  offset += preamble.length;

  while (offset < buffer.length) {
    if (buffer[offset] === 45 && buffer[offset + 1] === 45) break; // '--'
    if (buffer[offset] === 13 && buffer[offset + 1] === 10) offset += 2; // CRLF

    const headersEnd = indexOfBuffer(buffer, DBLCRLF, offset);
    if (headersEnd === -1) break;

    const headers = parsePartHeaders(buffer.slice(offset, headersEnd).toString());
    offset = headersEnd + 4;

    const nextBoundary = indexOfBuffer(buffer, sep, offset);
    const contentEnd = nextBoundary === -1 ? buffer.length : nextBoundary;
    const content = buffer.slice(offset, contentEnd);
    offset = contentEnd + sep.length;

    const disposition = headers['content-disposition'] ?? '';
    const nameMatch = /name="([^"]+)"/.exec(disposition);
    const filenameMatch = /filename="([^"]*)"/.exec(disposition);
    if (!nameMatch) continue;

    const name = nameMatch[1];
    if (filenameMatch) {
      files.set(name, {
        buffer: content,
        filename: filenameMatch[1],
        mimeType: headers['content-type'] ?? 'application/octet-stream',
        size: content.length,
      });
    } else {
      fields[name] = content.toString();
    }
  }

  return { files, fields };
}

/**
 * Parses multipart/form-data into `files` and `fields`. Both are empty if the request is not multipart.
 *
 * @example
 * ```typescript
 * Post('/attachments')
 *   .use(upload)
 *   .handle(({ files, res }) => {
 *     const file = files.get('file');
 *     if (!file) return res.status(400).json({ error: 'No file' });
 *     res.status(201).json({ filename: file.filename, size: file.size });
 *   })
 * ```
 */
export function upload(ctx: { rawBody: unknown; headers: Record<string, string> }): ParsedUpload {
  const contentType = ctx.headers['content-type'] ?? '';
  const boundaryMatch = /boundary=([^\s;]+)/.exec(contentType);
  if (!Buffer.isBuffer(ctx.rawBody) || !boundaryMatch) {
    return { files: new Map(), fields: {} };
  }
  return parseMultipart(ctx.rawBody, boundaryMatch[1]);
}
