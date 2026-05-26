/**
 * E2E: a minimal chat over HTTP + SSE, driven by real browsers.
 *
 * Proves the whole datastar loop end to end against the REAL Datastar client
 * (v1.0.0-beta.11), not a hand-rolled SSE parser:
 *
 *   browser @post('/chat/send')      -- input signal -> JSON body
 *     -> ChatStore broadcast         -- in-memory fan-out to subscribers
 *     -> Watch async generator       -- @justscale/datastar route factory
 *     -> datastar SSE frames         -- merge-fragments (the message) +
 *                                       merge-signals (the running count)
 *     -> Datastar client patches DOM -- appends <.msg>, updates $count
 *
 * Each client is its OWN browser, so a message typed in one must travel
 * through the server to appear in the other -- that is the "chat", and it
 * exercises the subscriber fan-out. (Two tabs in one browser don't work:
 * the backgrounded tab is throttled and can't receive synthetic input.)
 *
 * The transport is real (a JustScale HTTP app on a real socket, datastar's
 * own SSE wire format); only the message store is in-memory, which is all
 * the loop under test needs. A real app would back it with a Channel/Repo.
 *
 * Skips cleanly when no Chrome/Chromium can launch (e.g. CI without a
 * browser); runs for real locally.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Browser, Page, LaunchOptions } from 'puppeteer';
import puppeteer from 'puppeteer';

import JustScale, {
  createController,
  createConfig,
  createQueue,
  type Queue,
} from '@justscale/core';
import { Get, Post, listen, HttpConfig } from '@justscale/http';
// Importing the package runs its side effects: registers the Watch route
// factory and the request handler that intercepts Watch routes in listen().
import { Watch, html } from '../src/index.js';

interface ChatMessage {
  author: string;
  text: string;
}

/** In-memory chat store: history + live fan-out to per-connection queues. */
function createChatStore() {
  const history: ChatMessage[] = [];
  const subscribers = new Set<Queue<ChatMessage>>();

  return {
    send(author: string, text: string): void {
      const message = { author, text };
      history.push(message);
      for (const queue of subscribers) queue.push(message);
    },
    count: (): number => history.length,
    /** A new subscriber replays history, then receives live messages. */
    subscribe(): Queue<ChatMessage> {
      const queue = createQueue<ChatMessage>();
      for (const message of history) queue.push(message);
      subscribers.add(queue);
      return queue;
    },
    release(queue: Queue<ChatMessage>): void {
      if (subscribers.delete(queue)) queue.close();
    },
    /** Unblock every parked generator so the server can shut down. */
    closeAll(): void {
      for (const queue of subscribers) queue.close();
      subscribers.clear();
    },
  };
}

type ChatStore = ReturnType<typeof createChatStore>;

/** The page wires the real Datastar client (inlined) to our routes. */
function pageHtml(clientBundle: string, author: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>JustScale datastar chat</title></head>
<body data-signals="{ count: 0, message: '', author: '${author}' }">
  <h1>chat</h1>
  <p>messages: <span id="count" data-text="$count">0</span></p>
  <div id="messages"></div>
  <input id="draft" type="text" data-bind-message />
  <button id="send" data-on-click="@post('/chat/send')">send</button>
  <!-- open the long-lived SSE stream on load -->
  <div data-on-load="@get('/chat/stream')"></div>
  <script type="module">${clientBundle}</script>
</body>
</html>`;
}

function buildServer(store: ChatStore, clientBundle: string) {
  const portCfg = createConfig({
    provides: [HttpConfig],
    factory: () => ({ [HttpConfig.key]: { port: 0, host: '127.0.0.1' } }),
  });

  const ChatController = createController({
    inject: {},
    routes: () => ({
      // Author comes in as ?author=alice and is baked into the page signals.
      page: Get('/').handle((ctx: any) =>
        ctx.res.html(pageHtml(clientBundle, ctx.rawQuery?.author ?? 'anon')),
      ),

      send: Post('/chat/send').handle((ctx: any) => {
        const body = (ctx.rawBody ?? {}) as { message?: string; author?: string };
        const text = (body.message ?? '').trim();
        if (text) store.send(body.author ?? 'anon', text);
        // 204: datastar's @post opens this like an SSE stream but tolerates an
        // empty no-content response; the real updates arrive via /chat/stream.
        ctx.res.status(204).end();
      }),

      stream: Watch('/chat/stream').heartbeat(false).handle(
        async function* ({ stream, aborted }: any) {
          const queue = store.subscribe();
          // Release the subscriber when the browser disconnects. The framework
          // resolves `aborted` on client close; closing the queue ends the loop
          // below (so `finally` runs too). This is the canonical cleanup that
          // the disconnect fix enables.
          aborted.then(() => store.release(queue));
          try {
            for await (const message of queue) {
              stream.mergeFragments(
                html`<div class="msg" data-author=${message.author}>${message.author}: ${message.text}</div>`,
                { selector: '#messages', mergeMode: 'append' },
              );
              // Also push a plain signal so the client's $count updates —
              // exercises merge-signals alongside merge-fragments.
              yield { count: store.count() };
            }
          } finally {
            store.release(queue);
          }
        },
      ),
    }),
  });

  return JustScale().add(portCfg).add(ChatController).build().compile();
}

const LAUNCH_OPTS: LaunchOptions = {
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
};

let browserA: Browser | undefined;
let browserB: Browser | undefined;
let server: Server | undefined;
let store: ChatStore | undefined;
let baseUrl = '';
let launchError: unknown;

before(async () => {
  try {
    // One browser per client: each page stays foreground in its own browser,
    // so neither is throttled and both can receive synthetic input.
    [browserA, browserB] = await Promise.all([
      puppeteer.launch(LAUNCH_OPTS),
      puppeteer.launch(LAUNCH_OPTS),
    ]);
  } catch (err) {
    launchError = err;
    return;
  }

  const bundlePath = fileURLToPath(
    new URL(
      '../node_modules/@starfederation/datastar/dist/datastar.js',
      import.meta.url,
    ),
  );
  const clientBundle = await readFile(bundlePath, 'utf8');

  store = createChatStore();
  const app = buildServer(store, clientBundle);
  await app.ready;

  server = listen(app, 0);
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  const { port } = server!.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  store?.closeAll();
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  await Promise.all([browserA?.close(), browserB?.close()]);
});

/** Open a client page for `author` and wait for the datastar module to run. */
async function openClient(browser: Browser, author: string): Promise<Page> {
  const page = await browser.newPage();
  // NOT networkidle: the data-on-load SSE stream is a long-lived connection
  // that never goes idle. domcontentloaded is enough — the inlined datastar
  // module script has run by then.
  await page.goto(`${baseUrl}/?author=${author}`, {
    waitUntil: 'domcontentloaded',
  });
  return page;
}

/** Send a chat message from a page via the real input + button. */
async function sendMessage(page: Page, text: string): Promise<void> {
  await page.type('#draft', text);
  await page.click('#send');
}

/** Wait until #messages holds >= n rows, return their text in order. */
async function messages(page: Page, n: number): Promise<string[]> {
  await page.waitForFunction(
    (count: number) =>
      document.querySelectorAll('#messages .msg').length >= count,
    { timeout: 8000 },
    n,
  );
  return page.$$eval('#messages .msg', (els) =>
    els.map((el) => el.textContent ?? ''),
  );
}

/** Wait until the $count signal (rendered into #count) reaches `n`. */
async function expectCount(page: Page, n: number): Promise<void> {
  await page.waitForFunction(
    (count: number) =>
      document.querySelector('#count')?.textContent === String(count),
    { timeout: 8000 },
    n,
  );
}

test(
  'two browsers exchange chat messages over datastar SSE',
  { timeout: 30_000 },
  async (t) => {
    if (!browserA || !browserB) {
      t.skip(`no browser available: ${String(launchError).split('\n')[0]}`);
      return;
    }

    const alice = await openClient(browserA, 'alice');
    const bob = await openClient(browserB, 'bob');

    // Alice sends. The message must round-trip through the server (datastar
    // does not echo locally) and land in BOTH browsers.
    await sendMessage(alice, 'hello bob');

    for (const page of [alice, bob]) {
      const rows = await messages(page, 1);
      assert.equal(rows.length, 1);
      assert.match(rows[0]!, /alice: hello bob/);
      await expectCount(page, 1);
    }

    // Bob replies; both browsers now show two messages in order.
    await sendMessage(bob, 'hi alice');

    for (const page of [alice, bob]) {
      const rows = await messages(page, 2);
      assert.equal(rows.length, 2);
      assert.match(rows[0]!, /alice: hello bob/);
      assert.match(rows[1]!, /bob: hi alice/);
      await expectCount(page, 2);
    }
  },
);
