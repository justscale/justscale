/**
 * CLI I/O Interface
 *
 * Abstraction for CLI input/output that can be backed by:
 * - Real terminal (stdin/stdout with readline)
 * - Remote connection (WebSocket, SSH)
 * - Mock for testing
 */

import type { z } from 'zod';

/**
 * Progress bar interface for long-running operations
 */
export interface ProgressBar {
  /** Update progress (0-100) */
  update(percent: number): void
  /** Update with message */
  update(percent: number, message: string): void
  /** Complete the progress bar */
  complete(): void
  /** Fail the progress bar */
  fail(message?: string): void
}

/**
 * Spinner interface for indeterminate operations
 */
export interface Spinner {
  /** Update spinner text */
  text(message: string): void
  /** Mark as success and stop */
  success(message?: string): void
  /** Mark as failure and stop */
  fail(message?: string): void
  /** Stop without status */
  stop(): void
}

/**
 * Table column definition
 */
export interface TableColumn<T> {
  key: keyof T
  header?: string
  width?: number
  align?: 'left' | 'right' | 'center'
}

/**
 * CLI I/O interface - the primary way to interact with the user
 *
 * @typeParam TResult - The type of the structured result (set by .returns())
 */
export interface CliIO<TResult = void> {
  // ===========================================================================
  // Output - Human Readable
  // ===========================================================================

  /** Write text (no newline) */
  write(text: string): void

  /** Write line with newline */
  log(message: string): void

  /** Write warning (yellow) */
  warn(message: string): void

  /** Write error (red, to stderr) */
  error(message: string): void

  /** Write debug message (only if verbose mode) */
  debug(message: string): void

  // ===========================================================================
  // Output - Structured Result
  // ===========================================================================

  /**
   * Send structured result.
   * Typed by .returns() schema - validated at runtime.
   * This is the "return value" of the command for programmatic use.
   */
  result(data: TResult): void

  // ===========================================================================
  // Input - Interactive
  // ===========================================================================

  /** Prompt for text input */
  prompt(question: string): Promise<string>

  /** Prompt with default value */
  prompt(question: string, defaultValue: string): Promise<string>

  /** Prompt for confirmation (y/n) */
  confirm(question: string): Promise<boolean>

  /** Prompt for confirmation with default */
  confirm(question: string, defaultValue: boolean): Promise<boolean>

  /** Select from list of options */
  select<T extends string>(question: string, choices: T[]): Promise<T>

  /** Select from list with labels */
  select<T extends string>(
    question: string,
    choices: { value: T; label: string }[],
  ): Promise<T>

  /** Multi-select from list */
  multiSelect<T extends string>(question: string, choices: T[]): Promise<T[]>

  /** Prompt for password (hidden input) */
  password(question: string): Promise<string>

  // ===========================================================================
  // Fancy Output
  // ===========================================================================

  /** Create a progress bar */
  progress(label: string, total?: number): ProgressBar

  /** Create a spinner for indeterminate operations */
  spinner(label: string): Spinner

  /** Render a table */
  table<T extends Record<string, unknown>>(
    data: T[],
    columns?: (keyof T)[] | TableColumn<T>[],
  ): void

  /** Print a horizontal rule */
  hr(): void

  /** Print empty line */
  newline(): void

  // ===========================================================================
  // Control
  // ===========================================================================

  /** Check if running in interactive mode (TTY) */
  readonly isInteractive: boolean

  /** Check if verbose mode is enabled */
  readonly isVerbose: boolean
}

/**
 * Options for creating a terminal IO
 */
export interface TerminalIOOptions {
  /** Enable verbose output */
  verbose?: boolean
  /** Custom stdin (default: process.stdin) */
  stdin?: NodeJS.ReadStream
  /** Custom stdout (default: process.stdout) */
  stdout?: NodeJS.WriteStream
  /** Custom stderr (default: process.stderr) */
  stderr?: NodeJS.WriteStream
  /** Result schema for validation */
  resultSchema?: z.ZodType
  /** Callback when result() is called */
  onResult?: (data: unknown) => void
}

/**
 * Create a terminal-based CliIO implementation
 */
export function createTerminalIO<TResult = void>(
  options: TerminalIOOptions = {},
): CliIO<TResult> {
  const {
    verbose = false,
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
    resultSchema,
    onResult,
  } = options;

  const isInteractive = stdin.isTTY ?? false;

  // Simple readline for prompts
  async function readline(query: string): Promise<string> {
    return new Promise((resolve) => {
      stdout.write(query);
      let data = '';
      const onData = (chunk: Buffer) => {
        const str = chunk.toString();
        if (str.includes('\n')) {
          stdin.removeListener('data', onData);
          stdin.pause();
          data += str.split('\n')[0];
          resolve(data.trim());
        } else {
          data += str;
        }
      };
      stdin.resume();
      stdin.on('data', onData);
    });
  }

  const io: CliIO<TResult> = {
    // Output
    write(text: string): void {
      stdout.write(text);
    },

    log(message: string): void {
      stdout.write(`${message}\n`);
    },

    warn(message: string): void {
      stdout.write(`\x1b[33m${message}\x1b[0m\n`);
    },

    error(message: string): void {
      stderr.write(`\x1b[31m${message}\x1b[0m\n`);
    },

    debug(message: string): void {
      if (verbose) {
        stdout.write(`\x1b[90m${message}\x1b[0m\n`);
      }
    },

    // Structured result
    result(data: TResult): void {
      // Validate if schema provided
      if (resultSchema) {
        const result = resultSchema.safeParse(data);
        if (!result.success) {
          throw new Error(`Invalid result: ${result.error.message}`);
        }
      }
      // Call callback or write JSON to stdout
      if (onResult) {
        onResult(data);
      } else {
        stdout.write(`${JSON.stringify(data, null, 2)}\n`);
      }
    },

    // Input
    async prompt(question: string, defaultValue?: string): Promise<string> {
      const suffix = defaultValue ? ` (${defaultValue})` : '';
      const answer = await readline(`${question}${suffix}: `);
      return answer || defaultValue || '';
    },

    async confirm(question: string, defaultValue?: boolean): Promise<boolean> {
      const hint =
        defaultValue === true ? 'Y/n' : defaultValue === false ? 'y/N' : 'y/n';
      const answer = await readline(`${question} (${hint}): `);
      if (!answer && defaultValue !== undefined) return defaultValue;
      return answer.toLowerCase().startsWith('y');
    },

    async select<T extends string>(
      question: string,
      choices: T[] | { value: T; label: string }[],
    ): Promise<T> {
      stdout.write(`${question}\n`);
      const normalized = choices.map((c, i) =>
        typeof c === 'string'
          ? { value: c as T, label: c, index: i }
          : { ...c, index: i },
      );
      normalized.forEach((c, i) => {
        stdout.write(`  ${i + 1}) ${c.label}\n`);
      });
      const answer = await readline('Choice: ');
      const index = Number.parseInt(answer, 10) - 1;
      if (index >= 0 && index < normalized.length) {
        return normalized[index].value;
      }
      // Try to match by value
      const match = normalized.find(
        (c) =>
          c.value === answer || c.label.toLowerCase() === answer.toLowerCase(),
      );
      return match?.value ?? normalized[0].value;
    },

    async multiSelect<T extends string>(
      question: string,
      choices: T[],
    ): Promise<T[]> {
      stdout.write(`${question} (comma-separated numbers)\n`);
      choices.forEach((c, i) => {
        stdout.write(`  ${i + 1}) ${c}\n`);
      });
      const answer = await readline('Choices: ');
      const indices = answer
        .split(',')
        .map((s) => Number.parseInt(s.trim(), 10) - 1);
      return indices
        .filter((i) => i >= 0 && i < choices.length)
        .map((i) => choices[i]);
    },

    async password(question: string): Promise<string> {
      // Hide input on a real TTY: switch stdin to raw mode and echo
      // nothing for each keystroke. Falls back to readline() for
      // non-TTY input (piped CI, tests). There's no echo control
      // possible on a pipe; callers passing secrets through pipes is
      // their problem to avoid.
      if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
        return readline(`${question}: `);
      }
      return new Promise((resolve, reject) => {
        stdout.write(`${question}: `);
        let pwd = '';
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');

        const cleanup = () => {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          stdout.write('\n');
        };
        const onData = (chunk: Buffer | string) => {
          const ch = chunk.toString('utf8');
          for (const c of ch) {
            switch (c) {
              case '\n':
              case '\r':
              case '\u0004': // Ctrl-D
                cleanup();
                resolve(pwd);
                return;
              case '\u0003': {
                // Ctrl-C: reject so the caller can clean up rather
                // than process.exit() inside a library.
                cleanup();
                reject(new Error('Cancelled'));
                return;
              }
              case '\u007f': // backspace
              case '\b':
                pwd = pwd.slice(0, -1);
                break;
              default:
                // Skip control chars silently; never echo.
                if (c >= ' ') pwd += c;
            }
          }
        };
        stdin.on('data', onData);
      });
    },

    // Fancy output
    progress(label: string, total = 100): ProgressBar {
      let current = 0;
      const width = 30;

      function render(message?: string): void {
        const percent = Math.round((current / total) * 100);
        const filled = Math.round((current / total) * width);
        const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
        const msg = message ? ` ${message}` : '';
        stdout.write(`\r${label} [${bar}] ${percent}%${msg}`);
      }

      render();

      return {
        update(percent: number, message?: string): void {
          current = (percent / 100) * total;
          render(message);
        },
        complete(): void {
          current = total;
          render();
          stdout.write('\n');
        },
        fail(message?: string): void {
          stdout.write(`\r${label} \x1b[31m✗\x1b[0m ${message || 'Failed'}\n`);
        },
      };
    },

    spinner(label: string): Spinner {
      const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
      let frameIndex = 0;
      let currentText = label;
      let interval: ReturnType<typeof setInterval> | null = null;

      if (isInteractive) {
        interval = setInterval(() => {
          stdout.write(`\r${frames[frameIndex]} ${currentText}`);
          frameIndex = (frameIndex + 1) % frames.length;
        }, 80);
      } else {
        stdout.write(`${label}...\n`);
      }

      return {
        text(message: string): void {
          currentText = message;
        },
        success(message?: string): void {
          if (interval) clearInterval(interval);
          stdout.write(`\r\x1b[32m✓\x1b[0m ${message || currentText}\n`);
        },
        fail(message?: string): void {
          if (interval) clearInterval(interval);
          stdout.write(`\r\x1b[31m✗\x1b[0m ${message || currentText}\n`);
        },
        stop(): void {
          if (interval) clearInterval(interval);
          stdout.write(`\r${' '.repeat(currentText.length + 3)}\r`);
        },
      };
    },

    table<T extends Record<string, unknown>>(
      data: T[],
      columns?: (keyof T)[] | TableColumn<T>[],
    ): void {
      if (data.length === 0) return;

      // Determine columns
      const cols: TableColumn<T>[] = columns
        ? columns.map(
          (c): TableColumn<T> =>
            typeof c === 'string' ||
              typeof c === 'number' ||
              typeof c === 'symbol'
              ? { key: c as keyof T, header: String(c) }
              : (c as TableColumn<T>),
        )
        : (Object.keys(data[0]) as (keyof T)[]).map(
          (k): TableColumn<T> => ({
            key: k,
            header: String(k),
          }),
        );

      // Calculate widths
      const widths = cols.map((col) => {
        const headerLen = (col.header || String(col.key)).length;
        const maxDataLen = Math.max(
          ...data.map((row) => String(row[col.key] ?? '').length),
        );
        return col.width || Math.max(headerLen, maxDataLen);
      });

      // Print header
      const header = cols
        .map((col, i) => (col.header || String(col.key)).padEnd(widths[i]))
        .join(' | ');
      stdout.write(`${header}\n`);
      stdout.write(`${widths.map((w) => '-'.repeat(w)).join('-+-')}\n`);

      // Print rows
      // biome-ignore lint/complexity/noForEach: forEach is fine for simple iteration
      data.forEach((row) => {
        const line = cols
          .map((col, i) => String(row[col.key] ?? '').padEnd(widths[i]))
          .join(' | ');
        stdout.write(`${line}\n`);
      });
    },

    hr(): void {
      stdout.write(`${'-'.repeat(40)}\n`);
    },

    newline(): void {
      stdout.write('\n');
    },

    // Control
    isInteractive,
    isVerbose: verbose,
  };

  return io;
}

/**
 * Create a mock CliIO for testing
 */
export function createMockIO<TResult = void>(): CliIO<TResult> & {
  output: string[]
  errors: string[]
  results: unknown[]
  setInputs(inputs: string[]): void
} {
  const output: string[] = [];
  const errors: string[] = [];
  const results: unknown[] = [];
  let inputs: string[] = [];
  let inputIndex = 0;

  function nextInput(): string {
    return inputs[inputIndex++] || '';
  }

  const io: CliIO<TResult> & {
    output: string[]
    errors: string[]
    results: unknown[]
    setInputs(inputs: string[]): void
  } = {
    output,
    errors,
    results,

    setInputs(newInputs: string[]): void {
      inputs = newInputs;
      inputIndex = 0;
    },

    write(text: string): void {
      output.push(text);
    },

    log(message: string): void {
      output.push(message);
    },

    warn(message: string): void {
      output.push(`[WARN] ${message}`);
    },

    error(message: string): void {
      errors.push(message);
    },

    debug(message: string): void {
      output.push(`[DEBUG] ${message}`);
    },

    result(data: TResult): void {
      results.push(data);
    },

    async prompt(_question: string, defaultValue?: string): Promise<string> {
      return nextInput() || defaultValue || '';
    },

    async confirm(_question: string, defaultValue?: boolean): Promise<boolean> {
      const input = nextInput();
      if (!input && defaultValue !== undefined) return defaultValue;
      return input.toLowerCase().startsWith('y');
    },

    async select<T extends string>(
      _question: string,
      choices: T[] | { value: T; label: string }[],
    ): Promise<T> {
      const input = nextInput();
      const normalized = choices.map((c) =>
        typeof c === 'string' ? c : c.value,
      ) as T[];
      const index = Number.parseInt(input, 10) - 1;
      if (index >= 0 && index < normalized.length) {
        return normalized[index];
      }
      return normalized.find((c) => c === input) ?? normalized[0];
    },

    async multiSelect<T extends string>(
      _question: string,
      choices: T[],
    ): Promise<T[]> {
      const input = nextInput();
      const indices = input
        .split(',')
        .map((s) => Number.parseInt(s.trim(), 10) - 1);
      return indices
        .filter((i) => i >= 0 && i < choices.length)
        .map((i) => choices[i]);
    },

    async password(_question: string): Promise<string> {
      return nextInput();
    },

    progress(_label: string): ProgressBar {
      return {
        update(): void {},
        complete(): void {},
        fail(): void {},
      };
    },

    spinner(_label: string): Spinner {
      return {
        text(): void {},
        success(): void {},
        fail(): void {},
        stop(): void {},
      };
    },

    table<T extends Record<string, unknown>>(data: T[]): void {
      output.push(`[TABLE] ${JSON.stringify(data)}`);
    },

    hr(): void {
      output.push('---');
    },

    newline(): void {
      output.push('');
    },

    isInteractive: false,
    isVerbose: false,
  };

  return io;
}
