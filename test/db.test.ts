import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openDb, closeDb } from "../src/db.js";

let tmpDir: string;

describe("db", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-db-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the notifications table and enables WAL", () => {
    const db = openDb(path.join(tmpDir, "notifications.db"));
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notifications'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe("notifications");

    const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(mode.journal_mode).toBe("wal");
    closeDb(db);
  });

  it("is idempotent — second open succeeds without error", () => {
    const p = path.join(tmpDir, "notifications.db");
    const db1 = openDb(p);
    closeDb(db1);
    const db2 = openDb(p);
    expect(db2).toBeDefined();
    closeDb(db2);
  });
});
