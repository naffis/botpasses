import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createShutdown, installProcessGuards } from "../src/hosted/boot.ts";

type Logged = { event: string; fields: Record<string, unknown> };

function collector(): { events: Logged[]; log: (event: string, fields: Record<string, unknown>) => void } {
  const events: Logged[] = [];
  return { events, log: (event, fields) => void events.push({ event, fields }) };
}

test("shutdown drains, cuts connections at the deadline, closes the pool once, then exits 0", async () => {
  const order: string[] = [];
  let closeAll = 0;
  let resolveClose: (() => void) | undefined;
  const http = {
    close: () =>
      new Promise<void>((resolve) => {
        order.push("http.close");
        resolveClose = resolve; // hangs like an open SSE stream until connections are cut
      }),
    server: {
      closeAllConnections: () => {
        closeAll += 1;
        order.push("closeAllConnections");
        resolveClose?.();
      },
    },
  };
  let storeCloses = 0;
  const store = {
    close: async () => {
      storeCloses += 1;
      order.push("store.close");
    },
  };
  const exits: number[] = [];
  const { events, log } = collector();
  const shutdown = createShutdown({
    http,
    store,
    log,
    drainMs: 30,
    forceMarginMs: 1000,
    onDone: () => order.push("onDone"),
    exit: (code) => void exits.push(code),
  });
  shutdown.stop("SIGTERM");
  shutdown.stop("SIGTERM"); // second signal must not start a second drain
  shutdown.stop("SIGINT");
  await shutdown.done;
  assert.deepEqual(order, ["http.close", "closeAllConnections", "store.close", "onDone"]);
  assert.equal(closeAll, 1);
  assert.equal(storeCloses, 1);
  assert.deepEqual(exits, [0]);
  assert.deepEqual(
    events.map((e) => e.event),
    ["shutdown_begin", "shutdown_repeat_signal", "shutdown_repeat_signal", "shutdown_cut_connections", "shutdown_done"],
  );
  assert.equal(events.at(-1)?.fields.forced, true);
});

test("shutdown that closes before the deadline never cuts connections and reports forced=false", async () => {
  let closeAll = 0;
  const exits: number[] = [];
  const { events, log } = collector();
  const shutdown = createShutdown({
    http: { close: async () => undefined, server: { closeAllConnections: () => void (closeAll += 1) } },
    store: { close: async () => undefined },
    log,
    drainMs: 1000,
    exit: (code) => void exits.push(code),
  });
  shutdown.stop("SIGTERM");
  await shutdown.done;
  assert.equal(closeAll, 0);
  assert.deepEqual(exits, [0]);
  assert.equal(events.at(-1)?.event, "shutdown_done");
  assert.equal(events.at(-1)?.fields.forced, false);
});

test("a failing pool close still zeroes the key and exits non-zero", async () => {
  const exits: number[] = [];
  let done = false;
  const shutdown = createShutdown({
    http: { close: async () => undefined },
    store: {
      close: async () => {
        throw new Error("pool already ended");
      },
    },
    drainMs: 1000,
    onDone: () => void (done = true),
    exit: (code) => void exits.push(code),
  });
  shutdown.stop("SIGTERM");
  await shutdown.done;
  assert.equal(done, true);
  assert.deepEqual(exits, [1]);
});

test("real node:http server with a hanging response is drained within the deadline", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("event: ping\n\n"); // never ends
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const controller = new AbortController();
  const pending = fetch(`http://127.0.0.1:${addr.port}/mcp`, { signal: controller.signal });
  const res = await pending;
  assert.equal(res.status, 200);
  const started = Date.now();
  const exits: number[] = [];
  const shutdown = createShutdown({
    http: {
      close: () =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        }),
      server,
    },
    store: { close: async () => undefined },
    drainMs: 100,
    forceMarginMs: 2000,
    exit: (code) => void exits.push(code),
  });
  shutdown.stop("SIGTERM");
  await shutdown.done;
  const took = Date.now() - started;
  assert.ok(took >= 90 && took < 1500, `drained in ${took} ms`);
  assert.deepEqual(exits, [0]);
  controller.abort();
  await res.body?.cancel().catch(() => undefined);
});

test("process guards log one line and exit 1 on unhandled rejection or uncaught exception", () => {
  const handlers = new Map<string, (arg: unknown) => void>();
  const exits: number[] = [];
  const { events, log } = collector();
  const fakeProcess = {
    on: (event: string, handler: (arg: unknown) => void) => {
      handlers.set(event, handler);
      return fakeProcess;
    },
    exit: (code?: number) => {
      exits.push(code ?? 0);
      return undefined as never;
    },
  } as unknown as Pick<NodeJS.Process, "on" | "exit">;
  installProcessGuards(fakeProcess, log);
  handlers.get("unhandledRejection")?.(new Error("boom"));
  handlers.get("uncaughtException")?.(new TypeError("bad"));
  assert.deepEqual(exits, [1, 1]);
  assert.deepEqual(
    events.map((e) => [e.event, e.fields.message]),
    [
      ["unhandled_rejection", "boom"],
      ["uncaught_exception", "bad"],
    ],
  );
});
