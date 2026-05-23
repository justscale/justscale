/**
 * TSServer E2E Tests
 *
 * Tests the TypeScript Server integration for IDE support.
 * Simulates how JetBrains/VS Code communicate with tsserver.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================================
// TSServer Client
// ============================================================================

interface TSServerResponse {
  seq: number
  type: 'response' | 'event'
  command?: string
  request_seq?: number
  success?: boolean
  body?: unknown
  event?: string
  message?: string
}

class TSServerClient {
  private proc: ChildProcess;
  private seq = 0;
  private pending = new Map<number, {
    resolve: (value: TSServerResponse) => void
    reject: (error: Error) => void
  }>();
  private buffer = '';
  private ready: Promise<void>;
  private events: TSServerResponse[] = [];

  constructor(tsserverPath: string) {
    this.proc = spawn('node', [tsserverPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Enable logging for debugging
        JUSTSCALE_LOG: '1',
        JUSTSCALE_LOG_LEVEL: 'debug',
      },
    });

    // Collect stderr for debugging
    this.proc.stderr?.on('data', (data) => {
      process.stderr.write(`[tsserver stderr] ${data}`);
    });

    // Parse stdout responses - tsserver uses newline-delimited JSON by default
    this.proc.stdout?.on('data', (data: Buffer) => {
      this.buffer += data.toString();
      this.processBuffer();
    });

    // Wait for first event/response as ready signal
    this.ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('TSServer startup timeout'));
      }, 60000);

      const checkReady = () => {
        if (this.events.length > 0) {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(checkReady, 50);
        }
      };
      // Give tsserver time to start
      setTimeout(checkReady, 500);
    });
  }

  private processBuffer(): void {
    // TSServer uses Content-Length protocol: "Content-Length: N\r\n\r\n{json}\r\n"
    while (true) {
      // Look for Content-Length header
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const header = this.buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/);
      if (!match) {
        // Not a valid header, skip past it
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + contentLength) break; // incomplete body

      const body = this.buffer.slice(bodyStart, bodyStart + contentLength);
      this.buffer = this.buffer.slice(bodyStart + contentLength);

      const trimmed = body.trim();
      if (!trimmed) continue;

      try {
        const response = JSON.parse(trimmed) as TSServerResponse;
        this.handleResponse(response);
      } catch {
        console.log('[tsserver raw]', trimmed);
      }
    }
  }

  private handleResponse(response: TSServerResponse): void {
    console.log('[tsserver response]', JSON.stringify(response));
    if (response.type === 'event') {
      this.events.push(response);
    } else if (response.type === 'response' && response.request_seq !== undefined) {
      const pending = this.pending.get(response.request_seq);
      if (pending) {
        this.pending.delete(response.request_seq);
        pending.resolve(response);
      }
    }
  }

  async waitReady(): Promise<void> {
    return this.ready;
  }

  async send(command: string, args?: unknown): Promise<TSServerResponse> {
    const seq = ++this.seq;
    const request = {
      seq,
      type: 'request',
      command,
      arguments: args,
    };

    return new Promise((resolve, reject) => {
      this.pending.set(seq, { resolve, reject });

      // Send newline-delimited JSON
      const json = JSON.stringify(request);
      console.log('[tsserver request]', json);
      this.proc.stdin?.write(json + '\n');

      // Timeout
      setTimeout(() => {
        if (this.pending.has(seq)) {
          this.pending.delete(seq);
          reject(new Error(`Request ${command} timed out`));
        }
      }, 5000);
    });
  }

  async open(file: string, content?: string): Promise<TSServerResponse> {
    return this.send('open', {
      file,
      fileContent: content,
      scriptKindName: 'TS',
    });
  }

  async quickInfo(file: string, line: number, offset: number): Promise<TSServerResponse> {
    return this.send('quickinfo', { file, line, offset });
  }

  async completions(file: string, line: number, offset: number): Promise<TSServerResponse> {
    return this.send('completions', { file, line, offset });
  }

  async semanticDiagnostics(file: string): Promise<TSServerResponse> {
    return this.send('semanticDiagnosticsSync', { file });
  }

  async definition(file: string, line: number, offset: number): Promise<TSServerResponse> {
    return this.send('definition', { file, line, offset });
  }

  getEvents(): TSServerResponse[] {
    return this.events;
  }

  close(): void {
    this.proc.stdin?.end();
    this.proc.kill();
  }
}

// ============================================================================
// Test Helpers
// ============================================================================

function createTempDir(): string {
  const tempDir = join(
    tmpdir(),
    `tsserver-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(tempDir, { recursive: true });
  return tempDir;
}

function cleanupTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('TSServer E2E', { timeout: 120000 }, () => {
  let tempDir: string;
  let client: TSServerClient;
  const tsserverPath = join(__dirname, '../lib/tsserver.js');

  before(async () => {
    tempDir = createTempDir();

    // Create tsconfig.json
    writeFileSync(
      join(tempDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
        },
        include: ['*.ts'],
      })
    );

    // Create a proto file
    writeFileSync(
      join(tempDir, 'model.proto'),
      `syntax = "proto3";
message Model {
  string id = 1;
  string name = 2;
}
`
    );

    // Create a TypeScript file that imports the proto
    writeFileSync(
      join(tempDir, 'test.ts'),
      `import { Model } from './model.proto'

const m: Model = {
  id: '123',
  name: 'test',
}

export { m }
`
    );

    // Start tsserver
    client = new TSServerClient(tsserverPath);
    await client.waitReady();
  });

  after(() => {
    client?.close();
    cleanupTempDir(tempDir);
  });

  it('should start tsserver successfully', async () => {
    // If we got here, waitReady() succeeded
    assert.ok(client, 'TSServer client should be created');
  });

  it('should suppress TS2850 for using exports in process files', async () => {
    const processFile = join(tempDir, 'test.process.ts');

    writeFileSync(
      processFile,
      `export default async function handler() {
  using exports = {
    count: 0,
    name: 'test' as string,
    getCount() { return this.count },
  }
  return exports.count
}
`
    );

    await client.open(processFile);
    await new Promise(resolve => setTimeout(resolve, 2000));

    const response = await client.semanticDiagnostics(processFile);

    console.log('Process file diagnostics:', JSON.stringify(response, null, 2));

    assert.ok(response.success, 'semanticDiagnosticsSync should succeed');
    const diagnostics = (response.body ?? []) as Array<{ text: string; code: number }>;
    const ts2850 = diagnostics.filter(d => d.code === 2850);
    assert.strictEqual(
      ts2850.length, 0,
      `TS2850 should be suppressed for using exports in .process.ts files, but got: ${JSON.stringify(ts2850)}`
    );
  });

});
