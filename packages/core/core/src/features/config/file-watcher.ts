
import { watch as fsWatch, existsSync, readFileSync } from 'fs';
import type { FSWatcher } from 'fs';

function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let timeout: NodeJS.Timeout | null = null;
  return ((...args: any[]) => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), ms);
  }) as T;
}

function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // Handle quoted values
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

export interface EnvFileWatcher {
  /** Current merged values from all watched files */
  readonly values: Record<string, string>
  /** Subscribe to changes */
  subscribe(callback: (values: Record<string, string>) => void): () => void
  /** Stop watching */
  close(): void
}

/**
 * Watch .env files for changes
 */
export function watchEnvFiles(
  paths: string[],
  debounceMs = 300
): EnvFileWatcher {
  let currentValues: Record<string, string> = {};
  const subscribers = new Set<(values: Record<string, string>) => void>();
  const watchers: FSWatcher[] = [];

  function readAllFiles(): Record<string, string> {
    const merged: Record<string, string> = {};
    for (const path of paths) {
      if (existsSync(path)) {
        try {
          const content = readFileSync(path, 'utf-8');
          const parsed = parseEnvFile(content);
          Object.assign(merged, parsed);
        } catch (error) {
          console.warn(`[config] Failed to read ${path}:`, error);
        }
      }
    }
    return merged;
  }

  function notify() {
    for (const callback of subscribers) {
      callback(currentValues);
    }
  }

  const handleChange = debounce(() => {
    const newValues = readAllFiles();
    currentValues = newValues;
    notify();
  }, debounceMs);

  currentValues = readAllFiles();

  for (const path of paths) {
    if (existsSync(path)) {
      try {
        const watcher = fsWatch(path, (eventType) => {
          if (eventType === 'change' || eventType === 'rename') {
            handleChange();
          }
        });
        watchers.push(watcher);
      } catch (error) {
        console.warn(`[config] Failed to watch ${path}:`, error);
      }
    }
  }

  return {
    get values() {
      return currentValues;
    },

    subscribe(callback: (values: Record<string, string>) => void): () => void {
      subscribers.add(callback);
      return () => {
        subscribers.delete(callback);
      };
    },

    close() {
      for (const watcher of watchers) {
        watcher.close();
      }
      watchers.length = 0;
      subscribers.clear();
    },
  };
}
