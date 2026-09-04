/**
 * Both SQLite stores set `busy_timeout`, so a second writer (`vault serve` next to `vault set`,
 * or two hosted test processes on one file) waits for the lock instead of failing at once with
 * "database is locked". The lock is held from a worker thread because the main thread blocks
 * synchronously on the write.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { dbPath } from "../src/db.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import { cleanup, makeVault, tempHome } from "./helpers.ts";

const HOLD_MS = 400;

/** Takes SQLite's write lock on `path` in another thread for `ms`; resolves once it is held. */
function holdWriteLock(path: string, ms: number): Promise<Worker> {
  const worker = new Worker(
    `const { DatabaseSync } = require("node:sqlite");
     const { parentPort, workerData } = require("node:worker_threads");
     const db = new DatabaseSync(workerData.path);
     db.exec("BEGIN IMMEDIATE");
     parentPort.postMessage("locked");
     Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.ms);
     db.exec("COMMIT");
     db.close();`,
    { eval: true, workerData: { path, ms } },
  );
  return new Promise((resolve, reject) => {
    worker.once("message", () => resolve(worker));
    worker.once("error", reject);
  });
}

function exited(worker: Worker): Promise<void> {
  return new Promise((resolve) => worker.once("exit", () => resolve()));
}

test("local vault: a write waits for a concurrent writer instead of failing with database is locked", async () => {
  const { vault, home } = makeVault();
  try {
    const worker = await holdWriteLock(dbPath(home), HOLD_MS);
    const started = Date.now();
    const meta = vault.setSecret("HELD_KEY", "value-written-while-locked");
    const waited = Date.now() - started;
    await exited(worker);
    assert.equal(meta.name, "HELD_KEY");
    assert.ok(waited >= HOLD_MS - 100, `waited ${waited} ms for the lock`);
  } finally {
    vault.close();
    cleanup(home);
  }
});

test("hosted sqlite store: a write waits for a concurrent writer instead of failing with database is locked", async () => {
  const home = tempHome();
  const path = join(home, "hosted.sqlite");
  const store = openHostedSqlite(path);
  try {
    const worker = await holdWriteLock(path, HOLD_MS);
    const started = Date.now();
    await store.insertAudit({ id: "aud_busy", orgId: "org_busy", action: "store", actor: "test", itemName: null, clientId: null, at: new Date().toISOString() });
    const waited = Date.now() - started;
    await exited(worker);
    assert.ok(waited >= HOLD_MS - 100, `waited ${waited} ms for the lock`);
  } finally {
    await store.close();
    cleanup(home);
  }
});
