import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openDb, closeDb, type Db } from "../src/db.js";
import { enqueue, getPending, markSent, purge, claimRows, releaseRows, MAX_PER_TICK, RESERVATION_TIMEOUT_MS, MAX_DELIVERY_ATTEMPTS } from "../src/queue.js";

let tmpDir: string;
let db: Db;

describe("queue enqueue / getPending", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-queue-"));
    db = openDb(path.join(tmpDir, "notifications.db"));
  });
  afterEach(() => {
    closeDb(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("enqueues a row and returns it from getPending", () => {
    const id = enqueue(db, {
      source: "todo",
      category: "reminder",
      destination: "default",
      rawData: { text: "Buy beans", priority: "high" },
      shouldFormat: true,
      dedupKey: null,
    });
    expect(typeof id).toBe("number");

    const rows = getPending(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("todo");
    expect(rows[0].destination).toBe("default");
    expect(rows[0].should_format).toBe(1);
    expect(JSON.parse(rows[0].raw_data)).toEqual({ text: "Buy beans", priority: "high" });
  });

  it("orders pending rows by created_at ascending", () => {
    enqueue(db, { source: "a", category: null, destination: "default", rawData: { text: "1" }, shouldFormat: false, dedupKey: null });
    enqueue(db, { source: "b", category: null, destination: "default", rawData: { text: "2" }, shouldFormat: false, dedupKey: null });
    const rows = getPending(db);
    expect(rows.map((r) => r.source)).toEqual(["a", "b"]);
  });

  it("excludes rows with sent_at set", () => {
    const id = enqueue(db, { source: "x", category: null, destination: "default", rawData: { text: "done" }, shouldFormat: false, dedupKey: null });
    db.prepare("UPDATE notifications SET sent_at = ? WHERE id = ?").run(Date.now(), id);
    expect(getPending(db)).toHaveLength(0);
  });
});

describe("dedup", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-dedup-"));
    db = openDb(path.join(tmpDir, "notifications.db"));
  });
  afterEach(() => {
    closeDb(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("updates the existing pending row when dedup_key collides within window", () => {
    const dedupWindowMin = 15;
    const id1 = enqueue(db, { source: "todo", category: "reminder", destination: "default", rawData: { text: "v1" }, shouldFormat: true, dedupKey: "k1" }, { dedupWindowMin });
    const id2 = enqueue(db, { source: "todo", category: "reminder", destination: "default", rawData: { text: "v2" }, shouldFormat: true, dedupKey: "k1" }, { dedupWindowMin });
    expect(id2).toBe(id1);
    const rows = getPending(db);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].raw_data)).toEqual({ text: "v2" });
  });

  it("creates a new row when dedup_key is outside the window", () => {
    const dedupWindowMin = 15;
    const id1 = enqueue(db, { source: "todo", category: null, destination: "default", rawData: { text: "old" }, shouldFormat: false, dedupKey: "k1" }, { dedupWindowMin });
    // Simulate that the earlier row is now older than the window.
    db.prepare("UPDATE notifications SET created_at = ? WHERE id = ?").run(Date.now() - 20 * 60 * 1000, id1);
    const id2 = enqueue(db, { source: "todo", category: null, destination: "default", rawData: { text: "new" }, shouldFormat: false, dedupKey: "k1" }, { dedupWindowMin });
    expect(id2).not.toBe(id1);
    expect(getPending(db)).toHaveLength(2);
  });

  it("does not collide across different dedup_keys", () => {
    const dedupWindowMin = 15;
    const id1 = enqueue(db, { source: "todo", category: null, destination: "default", rawData: { text: "a" }, shouldFormat: false, dedupKey: "k1" }, { dedupWindowMin });
    const id2 = enqueue(db, { source: "todo", category: null, destination: "default", rawData: { text: "b" }, shouldFormat: false, dedupKey: "k2" }, { dedupWindowMin });
    expect(id1).not.toBe(id2);
    expect(getPending(db)).toHaveLength(2);
  });

  it("does not collide across different destinations with the same dedup_key", () => {
    const dedupWindowMin = 15;
    const id1 = enqueue(db, { source: "todo", category: null, destination: "default", rawData: { text: "personal" }, shouldFormat: false, dedupKey: "k1" }, { dedupWindowMin });
    const id2 = enqueue(db, { source: "todo", category: null, destination: "work",    rawData: { text: "workly"   }, shouldFormat: false, dedupKey: "k1" }, { dedupWindowMin });
    expect(id1).not.toBe(id2);
    const rows = getPending(db);
    expect(rows).toHaveLength(2);
    const texts = rows.map((r) => JSON.parse(r.raw_data).text).sort();
    expect(texts).toEqual(["personal", "workly"]);
  });
});

describe("queue claim / release", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-claim-"));
    db = openDb(path.join(tmpDir, "notifications.db"));
  });
  afterEach(() => {
    closeDb(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("claimRows reserves the rows and returns their current contents", () => {
    const id = enqueue(db, { source: "a", category: null, destination: "default", rawData: { text: "x" }, shouldFormat: false, dedupKey: null });
    expect(getPending(db)).toHaveLength(1);
    const claimed = claimRows(db, [id]);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].id).toBe(id);
    expect(JSON.parse(claimed[0].raw_data)).toEqual({ text: "x" });
    expect(getPending(db)).toHaveLength(0);
  });

  it("releaseRows restores reserved rows to getPending", () => {
    const id = enqueue(db, { source: "a", category: null, destination: "default", rawData: { text: "x" }, shouldFormat: false, dedupKey: null });
    claimRows(db, [id]);
    expect(getPending(db)).toHaveLength(0);
    releaseRows(db, [id]);
    expect(getPending(db)).toHaveLength(1);
  });

  it("claimRows returns empty and leaves raw_data alone when the row is already reserved", () => {
    const id = enqueue(db, { source: "a", category: null, destination: "default", rawData: { text: "x" }, shouldFormat: false, dedupKey: null });
    const first = claimRows(db, [id]);
    expect(first).toHaveLength(1);
    const second = claimRows(db, [id]);
    expect(second).toHaveLength(0);
  });

  it("claimRows returns fresh raw_data after a dedup update between getPending and claim (C1)", () => {
    const dedupWindowMin = 15;
    const id = enqueue(db, { source: "todo", category: null, destination: "default", rawData: { text: "v1" }, shouldFormat: false, dedupKey: "k1" }, { dedupWindowMin });
    // Simulate: tick calls getPending and reads the row snapshot.
    const snapshot = getPending(db);
    expect(JSON.parse(snapshot[0].raw_data)).toEqual({ text: "v1" });
    // Concurrent enqueue with same dedup key updates raw_data in place.
    enqueue(db, { source: "todo", category: null, destination: "default", rawData: { text: "v2" }, shouldFormat: false, dedupKey: "k1" }, { dedupWindowMin });
    // Tick now claims. The returned row must carry v2, not the stale v1 snapshot.
    const claimed = claimRows(db, [id]);
    expect(claimed).toHaveLength(1);
    expect(JSON.parse(claimed[0].raw_data)).toEqual({ text: "v2" });
  });

  it("getPending re-exposes rows whose reservation is older than the timeout", () => {
    const id = enqueue(db, { source: "a", category: null, destination: "default", rawData: { text: "x" }, shouldFormat: false, dedupKey: null });
    claimRows(db, [id]);
    expect(getPending(db)).toHaveLength(0);
    // Simulate a crashed tick: reserved_at is set but very old.
    const longAgo = Date.now() - RESERVATION_TIMEOUT_MS - 1000;
    db.prepare("UPDATE notifications SET reserved_at = ? WHERE id = ?").run(longAgo, id);
    expect(getPending(db)).toHaveLength(1);
  });

  it("claimRows re-claims a row whose prior reservation is stale", () => {
    const id = enqueue(db, { source: "a", category: null, destination: "default", rawData: { text: "x" }, shouldFormat: false, dedupKey: null });
    claimRows(db, [id]);
    const longAgo = Date.now() - RESERVATION_TIMEOUT_MS - 1000;
    db.prepare("UPDATE notifications SET reserved_at = ? WHERE id = ?").run(longAgo, id);
    const reclaimed = claimRows(db, [id]);
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0].id).toBe(id);
  });

  it("dedup folds into a row whose reservation is stale (crashed tick recovery)", () => {
    const dedupWindowMin = 15;
    const id1 = enqueue(db, { source: "todo", category: null, destination: "default", rawData: { text: "v1" }, shouldFormat: false, dedupKey: "k1" }, { dedupWindowMin });
    claimRows(db, [id1]);
    // Simulate the tick process crashing between claim and markSent — the
    // reservation is now past the timeout.
    const longAgo = Date.now() - RESERVATION_TIMEOUT_MS - 1000;
    db.prepare("UPDATE notifications SET reserved_at = ? WHERE id = ?").run(longAgo, id1);
    // A fresh enqueue with the same key should FOLD into the stale row, not
    // create a second one. Otherwise, when the stale row is reclaimed, we
    // deliver the same notification twice.
    const id2 = enqueue(db, { source: "todo", category: null, destination: "default", rawData: { text: "v2" }, shouldFormat: false, dedupKey: "k1" }, { dedupWindowMin });
    expect(id2).toBe(id1);
    const rows = db.prepare("SELECT raw_data FROM notifications").all() as { raw_data: string }[];
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].raw_data)).toEqual({ text: "v2" });
  });

  it("dedup creates a new row instead of mutating a claimed row", () => {
    const dedupWindowMin = 15;
    const id1 = enqueue(db, { source: "todo", category: null, destination: "default", rawData: { text: "v1" }, shouldFormat: false, dedupKey: "k1" }, { dedupWindowMin });
    claimRows(db, [id1]);
    const id2 = enqueue(db, { source: "todo", category: null, destination: "default", rawData: { text: "v2" }, shouldFormat: false, dedupKey: "k1" }, { dedupWindowMin });
    expect(id2).not.toBe(id1);
    const reserved = db.prepare("SELECT raw_data FROM notifications WHERE id = ?").get(id1) as { raw_data: string };
    expect(JSON.parse(reserved.raw_data)).toEqual({ text: "v1" });
    const pending = getPending(db);
    expect(pending.map((r) => JSON.parse(r.raw_data).text)).toEqual(["v2"]);
  });
});

describe("queue retry budget", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-retry-"));
    db = openDb(path.join(tmpDir, "notifications.db"));
  });
  afterEach(() => {
    closeDb(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("releaseRows reports retried ids below the budget", () => {
    const id = enqueue(db, { source: "a", category: null, destination: "default", rawData: { text: "x" }, shouldFormat: false, dedupKey: null });
    claimRows(db, [id]);
    const res = releaseRows(db, [id]);
    expect(res.retried).toEqual([id]);
    expect(res.failed).toEqual([]);
    expect(getPending(db)).toHaveLength(1);
  });

  it("stamps failed_at and reports the id in `failed` once delivery_attempts >= MAX", () => {
    const id = enqueue(db, { source: "a", category: null, destination: "default", rawData: { text: "x" }, shouldFormat: false, dedupKey: null });
    let lastResult: { retried: number[]; failed: number[] } = { retried: [], failed: [] };
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) {
      claimRows(db, [id]);
      lastResult = releaseRows(db, [id]);
    }
    expect(lastResult.failed).toEqual([id]);
    expect(lastResult.retried).toEqual([]);
    const row = db.prepare("SELECT delivery_attempts, failed_at FROM notifications WHERE id = ?").get(id) as { delivery_attempts: number; failed_at: number | null };
    expect(row.delivery_attempts).toBeGreaterThanOrEqual(MAX_DELIVERY_ATTEMPTS);
    expect(row.failed_at).not.toBeNull();
  });

  it("failed rows are excluded from getPending and not re-claimable", () => {
    const id = enqueue(db, { source: "a", category: null, destination: "default", rawData: { text: "x" }, shouldFormat: false, dedupKey: null });
    db.prepare("UPDATE notifications SET delivery_attempts = ?, failed_at = ? WHERE id = ?").run(MAX_DELIVERY_ATTEMPTS, Date.now(), id);
    expect(getPending(db)).toHaveLength(0);
    expect(claimRows(db, [id])).toHaveLength(0);
  });

  it("dedup re-enqueue resets delivery_attempts and clears reserved_at on a retried row", () => {
    const dedupWindowMin = 15;
    const id = enqueue(db, { source: "todo", category: null, destination: "default", rawData: { text: "v1" }, shouldFormat: false, dedupKey: "k1" }, { dedupWindowMin });
    // Simulate a couple of failed deliveries.
    claimRows(db, [id]);
    releaseRows(db, [id]);
    claimRows(db, [id]);
    releaseRows(db, [id]);
    // Fresh enqueue (same key) should fold in and reset the counter.
    const id2 = enqueue(db, { source: "todo", category: null, destination: "default", rawData: { text: "v2" }, shouldFormat: false, dedupKey: "k1" }, { dedupWindowMin });
    expect(id2).toBe(id);
    const row = db.prepare("SELECT delivery_attempts, reserved_at, raw_data FROM notifications WHERE id = ?").get(id) as { delivery_attempts: number; reserved_at: number | null; raw_data: string };
    expect(row.delivery_attempts).toBe(0);
    expect(row.reserved_at).toBeNull();
    expect(JSON.parse(row.raw_data)).toEqual({ text: "v2" });
  });

  it("does not fold a new dedup enqueue into a row that has already reached failed_at", () => {
    const dedupWindowMin = 15;
    const id = enqueue(db, { source: "todo", category: null, destination: "default", rawData: { text: "v1" }, shouldFormat: false, dedupKey: "k1" }, { dedupWindowMin });
    db.prepare("UPDATE notifications SET failed_at = ? WHERE id = ?").run(Date.now(), id);
    const id2 = enqueue(db, { source: "todo", category: null, destination: "default", rawData: { text: "v2" }, shouldFormat: false, dedupKey: "k1" }, { dedupWindowMin });
    expect(id2).not.toBe(id);
  });

  it("treats a reservation timestamp in the future (clock rollback) as broken", () => {
    const id = enqueue(db, { source: "a", category: null, destination: "default", rawData: { text: "x" }, shouldFormat: false, dedupKey: null });
    // Set reserved_at way in the future — simulates an NTP rollback that
    // would otherwise trap the row until wall time caught up.
    db.prepare("UPDATE notifications SET reserved_at = ? WHERE id = ?").run(Date.now() + 24 * 3600_000, id);
    expect(getPending(db)).toHaveLength(1);
    expect(claimRows(db, [id])).toHaveLength(1);
  });
});

describe("getPending limit", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-limit-"));
    db = openDb(path.join(tmpDir, "notifications.db"));
  });
  afterEach(() => {
    closeDb(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("caps at MAX_PER_TICK rows by default", () => {
    for (let i = 0; i < MAX_PER_TICK + 5; i++) {
      enqueue(db, { source: "a", category: null, destination: "default", rawData: { text: String(i) }, shouldFormat: false, dedupKey: null });
    }
    expect(getPending(db)).toHaveLength(MAX_PER_TICK);
  });

  it("honors an explicit lower limit", () => {
    for (let i = 0; i < 10; i++) {
      enqueue(db, { source: "a", category: null, destination: "default", rawData: { text: String(i) }, shouldFormat: false, dedupKey: null });
    }
    expect(getPending(db, 3)).toHaveLength(3);
  });
});

describe("queue markSent", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-msent-"));
    db = openDb(path.join(tmpDir, "notifications.db"));
  });
  afterEach(() => {
    closeDb(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stamps sent_at on the given ids in one transaction", () => {
    const ids = [
      enqueue(db, { source: "a", category: null, destination: "default", rawData: { text: "1" }, shouldFormat: false, dedupKey: null }),
      enqueue(db, { source: "b", category: null, destination: "default", rawData: { text: "2" }, shouldFormat: false, dedupKey: null }),
    ];
    markSent(db, ids);
    const pending = getPending(db);
    expect(pending).toHaveLength(0);
    const rows = db.prepare("SELECT id, sent_at FROM notifications").all() as { id: number; sent_at: number }[];
    expect(rows.every((r) => typeof r.sent_at === "number" && r.sent_at > 0)).toBe(true);
  });
});

describe("two handles on the same DB file (CLI process vs service process)", () => {
  let dbPath: string;
  let cliDb: Db;
  let svcDb: Db;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-two-handle-"));
    dbPath = path.join(tmpDir, "notifications.db");
    // Simulate two processes (CLI + long-running service) both opening the
    // same file. WAL + atomic UPDATE...RETURNING is supposed to make this
    // safe; verify.
    cliDb = openDb(dbPath);
    svcDb = openDb(dbPath);
  });
  afterEach(() => {
    closeDb(cliDb);
    closeDb(svcDb);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("service-side claim sees rows enqueued by the CLI-side handle", () => {
    // CLI enqueues; service reads pending.
    const id = enqueue(cliDb, {
      source: "todo", category: null, destination: "default",
      rawData: { text: "from-cli" }, shouldFormat: false, dedupKey: null,
    });
    const pending = getPending(svcDb);
    expect(pending.map((r) => r.id)).toContain(id);
  });

  it("only one handle successfully claims a row both try to reserve", () => {
    const id = enqueue(cliDb, {
      source: "a", category: null, destination: "default",
      rawData: { text: "x" }, shouldFormat: false, dedupKey: null,
    });
    // Both handles try to claim the same row. Single UPDATE...RETURNING
    // guarantees only one gets it.
    const a = claimRows(cliDb, [id]);
    const b = claimRows(svcDb, [id]);
    expect(a.length + b.length).toBe(1);
  });

  it("markSent via one handle hides the row from getPending via the other", () => {
    const id = enqueue(cliDb, {
      source: "a", category: null, destination: "default",
      rawData: { text: "x" }, shouldFormat: false, dedupKey: null,
    });
    claimRows(svcDb, [id]);
    markSent(svcDb, [id]);
    expect(getPending(cliDb)).toHaveLength(0);
  });
});

describe("queue purge", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-purge-"));
    db = openDb(path.join(tmpDir, "notifications.db"));
  });
  afterEach(() => {
    closeDb(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("deletes sent rows older than the cutoff", () => {
    const id1 = enqueue(db, { source: "a", category: null, destination: "default", rawData: { text: "old" }, shouldFormat: false, dedupKey: null });
    const id2 = enqueue(db, { source: "b", category: null, destination: "default", rawData: { text: "recent" }, shouldFormat: false, dedupKey: null });
    const old = Date.now() - 40 * 86400_000;
    const recent = Date.now() - 5 * 86400_000;
    db.prepare("UPDATE notifications SET sent_at = ?, created_at = ? WHERE id = ?").run(old, old, id1);
    db.prepare("UPDATE notifications SET sent_at = ?, created_at = ? WHERE id = ?").run(recent, recent, id2);

    const deleted = purge(db, 30);
    expect(deleted).toBe(1);
    const remaining = db.prepare("SELECT id FROM notifications").all() as { id: number }[];
    expect(remaining.map((r) => r.id)).toEqual([id2]);
  });

  it("never deletes unsent rows, regardless of age", () => {
    const id = enqueue(db, { source: "a", category: null, destination: "default", rawData: { text: "still pending" }, shouldFormat: false, dedupKey: null });
    db.prepare("UPDATE notifications SET created_at = ? WHERE id = ?").run(Date.now() - 100 * 86400_000, id);
    const deleted = purge(db, 30);
    expect(deleted).toBe(0);
  });
});
