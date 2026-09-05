import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createShutdown, installProcessGuards } from "../src/hosted/boot.ts";
import type { RebindOptions } from "../src/hosted/kernel-items.ts";
import { serveHosted } from "../src/hosted/main.ts";

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

type FakeProc = { handlers: Map<string, () => void>; proc: Pick<NodeJS.Process, "on"> };

function fakeProc(): FakeProc {
  const handlers = new Map<string, () => void>();
  const proc = {
    on: (event: string, handler: () => void) => {
      handlers.set(event, handler);
      return proc;
    },
  } as unknown as Pick<NodeJS.Process, "on">;
  return { handlers, proc };
}

/** The `serveHosted` fakes: every dependency records its call in `order`. */
function serveFakes(order: string[]) {
  const http = {
    listen: async () => {
      order.push("listen");
      return { host: "127.0.0.1", port: 0 };
    },
    close: async () => void order.push("http.close"),
  };
  const store = {
    close: async () => void order.push("store.close"),
    sweepExpired: async () => {
      order.push("sweep");
      return {
        emailOtpChallenges: 0,
        operatorSessions: 0,
        approvalChallenges: 0,
        needItems: 0,
        rateHits: 0,
        oidcPayloads: 0,
        orgInvites: 0,
        grants: 0,
      };
    },
  };
  return { http, store };
}

test("R4b: the hosted process listens and installs its signal handlers before the legacy AAD rebind, and sweeps after it", async () => {
  const order: string[] = [];
  const { http, store } = serveFakes(order);
  const { handlers, proc } = fakeProc();
  const { events, log } = collector();
  const exits: number[] = [];
  const rebind: RebindOptions[] = [];
  const serving = serveHosted({
    http,
    store,
    proc,
    log,
    exit: (code) => void exits.push(code),
    drainMs: 30,
    forceMarginMs: 1000,
    onListening: (addr) => order.push(`listening ${addr.host}:${addr.port}`),
    onDone: () => order.push("onDone"),
    rebind: async (opts) => {
      order.push(`rebind handlers=${[...handlers.keys()].sort().join(",")}`);
      rebind.push(opts);
      opts.onBatch?.({ batch: 1, rows: 200, rebound: 200, verified: 0, unreadable: 0 });
      opts.onBatch?.({ batch: 2, rows: 5, rebound: 204, verified: 1, unreadable: 0 });
      return { rebound: 204, verified: 1, unreadable: 0, batches: 2, stopped: false };
    },
  });
  // Yield until the first sweep has run: listen, rebind, and sweep are all awaited in turn.
  while (!order.includes("sweep")) await new Promise((r) => setTimeout(r, 1));
  assert.deepEqual(order, ["listen", "listening 127.0.0.1:0", "rebind handlers=SIGINT,SIGTERM", "sweep"]);
  assert.equal(rebind[0]?.shouldStop?.(), false, "no signal yet, so the rebind is not asked to stop");
  assert.deepEqual(
    events.map((e) => e.event),
    ["aad_rebind_progress", "aad_rebind_progress", "aad_rebind", "sweep_expired"],
  );
  assert.deepEqual(events[1]?.fields.rebound, 204);
  assert.deepEqual(events[2]?.fields.batches, 2);
  assert.equal(typeof events[2]?.fields.ms, "number");
  handlers.get("SIGTERM")?.();
  await serving;
  assert.deepEqual(order.slice(4), ["http.close", "store.close", "onDone"]);
  assert.deepEqual(exits, [0]);
});

test("R4b: a SIGTERM during the rebind stops it at a batch boundary and the drain waits for that batch before closing the store", async () => {
  const order: string[] = [];
  const { http, store } = serveFakes(order);
  const { handlers, proc } = fakeProc();
  const { events, log } = collector();
  const exits: number[] = [];
  const serving = serveHosted({
    http,
    store,
    proc,
    log,
    exit: (code) => void exits.push(code),
    drainMs: 30,
    forceMarginMs: 1000,
    onListening: () => order.push("listening"),
    rebind: async (opts) => {
      const counts = { rebound: 0, verified: 0, unreadable: 0, batches: 0, stopped: false };
      for (;;) {
        if (opts.shouldStop?.()) {
          counts.stopped = true;
          order.push("rebind.stopped");
          return counts;
        }
        counts.batches += 1;
        order.push(`batch ${counts.batches} start`);
        if (counts.batches === 1) handlers.get("SIGTERM")?.(); // the signal lands mid-batch
        await new Promise((r) => setTimeout(r, 5)); // the batch's statements are still in flight
        counts.rebound += 3;
        order.push(`batch ${counts.batches} done`);
        opts.onBatch?.({ batch: counts.batches, rows: 3, ...counts });
      }
    },
  });
  await serving;
  assert.deepEqual(order, [
    "listen",
    "listening",
    "batch 1 start",
    "http.close",
    "batch 1 done",
    "rebind.stopped",
    "store.close",
  ]);
  assert.ok(!order.includes("sweep"), "no sweep starts on a process that is shutting down");
  const summary = events.find((e) => e.event === "aad_rebind");
  assert.deepEqual([summary?.fields.batches, summary?.fields.stopped, summary?.fields.rebound], [1, true, 3]);
  assert.deepEqual(exits, [0]);
});

test("R4b: a rebind that throws is logged as aad_rebind_failed and the process keeps serving", async () => {
  const order: string[] = [];
  const { http, store } = serveFakes(order);
  const { handlers, proc } = fakeProc();
  const { events, log } = collector();
  const exits: number[] = [];
  const serving = serveHosted({
    http,
    store,
    proc,
    log,
    exit: (code) => void exits.push(code),
    drainMs: 30,
    forceMarginMs: 1000,
    onListening: () => order.push("listening"),
    rebind: async () => {
      throw new Error("connection terminated");
    },
  });
  while (!order.includes("sweep")) await new Promise((r) => setTimeout(r, 1));
  assert.deepEqual(
    events.map((e) => [e.event, e.fields.message]),
    [
      ["aad_rebind_failed", "connection terminated"],
      ["sweep_expired", undefined],
    ],
  );
  handlers.get("SIGTERM")?.();
  await serving;
  assert.deepEqual(exits, [0]);
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
