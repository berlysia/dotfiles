#!/usr/bin/env node --test

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

// We test the pure file-based functions by overriding THREADS_FILE via module internals.
// Since the module uses a const path derived from HOME, we override HOME before importing.
const originalHome = process.env.HOME;

describe("discord-forum", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "discord-forum-test-"));
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  // Dynamic import after setting HOME so the module picks up the temp path
  async function importModule() {
    // Use cache-busting query to force fresh module evaluation
    const cacheBuster = `?t=${Date.now()}-${Math.random()}`;
    return await import(`../../lib/discord-forum.ts${cacheBuster}`);
  }

  describe("loadThreadMap", () => {
    it("should return empty map when file does not exist", async () => {
      const mod = await importModule();
      const result = mod.loadThreadMap();
      deepStrictEqual(result, {});
    });

    it("should return empty map when file contains invalid JSON", async () => {
      const claudeDir = join(tempDir, ".claude");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(
        join(claudeDir, ".discord-forum-threads.json"),
        "not json",
      );

      const mod = await importModule();
      const result = mod.loadThreadMap();
      deepStrictEqual(result, {});
    });

    it("should return empty map when file contains array", async () => {
      const claudeDir = join(tempDir, ".claude");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(
        join(claudeDir, ".discord-forum-threads.json"),
        JSON.stringify([1, 2, 3]),
      );

      const mod = await importModule();
      const result = mod.loadThreadMap();
      deepStrictEqual(result, {});
    });

    it("should parse valid thread map", async () => {
      const claudeDir = join(tempDir, ".claude");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(claudeDir, { recursive: true });

      const data = {
        "session-1": { threadId: "thread-123", createdAt: 1000 },
      };
      writeFileSync(
        join(claudeDir, ".discord-forum-threads.json"),
        JSON.stringify(data),
      );

      const mod = await importModule();
      const result = mod.loadThreadMap();
      deepStrictEqual(result, data);
    });
  });

  describe("saveThreadId", () => {
    it("should create file and save thread ID", async () => {
      const mod = await importModule();
      mod.saveThreadId("session-abc", "thread-xyz");

      const filePath = join(tempDir, ".claude", ".discord-forum-threads.json");
      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);

      ok(parsed["session-abc"], "should have session entry");
      strictEqual(parsed["session-abc"].threadId, "thread-xyz");
      ok(
        typeof parsed["session-abc"].createdAt === "number",
        "should have createdAt timestamp",
      );
    });

    it("should preserve existing entries", async () => {
      const claudeDir = join(tempDir, ".claude");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(claudeDir, { recursive: true });

      const existing = {
        "old-session": { threadId: "old-thread", createdAt: 1000 },
      };
      writeFileSync(
        join(claudeDir, ".discord-forum-threads.json"),
        JSON.stringify(existing),
      );

      const mod = await importModule();
      mod.saveThreadId("new-session", "new-thread");

      const filePath = join(claudeDir, ".discord-forum-threads.json");
      const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
      ok(parsed["old-session"], "should preserve old entry");
      ok(parsed["new-session"], "should have new entry");
    });
  });

  describe("getThreadId", () => {
    it("should return null for unknown session", async () => {
      const mod = await importModule();
      const result = mod.getThreadId("nonexistent");
      strictEqual(result, null);
    });

    it("should return thread ID for known session", async () => {
      const claudeDir = join(tempDir, ".claude");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(claudeDir, { recursive: true });

      const data = {
        "known-session": { threadId: "thread-456", createdAt: Date.now() },
      };
      writeFileSync(
        join(claudeDir, ".discord-forum-threads.json"),
        JSON.stringify(data),
      );

      const mod = await importModule();
      const result = mod.getThreadId("known-session");
      strictEqual(result, "thread-456");
    });
  });

  describe("cleanupOldThreads", () => {
    it("should remove entries older than maxAge", async () => {
      const claudeDir = join(tempDir, ".claude");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(claudeDir, { recursive: true });

      const now = Date.now();
      const data = {
        old: { threadId: "t1", createdAt: now - 10_000 },
        recent: { threadId: "t2", createdAt: now - 1_000 },
      };
      writeFileSync(
        join(claudeDir, ".discord-forum-threads.json"),
        JSON.stringify(data),
      );

      const mod = await importModule();
      // Cleanup entries older than 5 seconds
      mod.cleanupOldThreads(5_000);

      const filePath = join(claudeDir, ".discord-forum-threads.json");
      const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
      strictEqual(parsed["old"], undefined, "old entry should be removed");
      ok(parsed["recent"], "recent entry should remain");
    });

    it("should not write file when nothing to clean", async () => {
      const claudeDir = join(tempDir, ".claude");
      const { mkdirSync, statSync } = await import("node:fs");
      mkdirSync(claudeDir, { recursive: true });

      const data = {
        recent: { threadId: "t1", createdAt: Date.now() },
      };
      const filePath = join(claudeDir, ".discord-forum-threads.json");
      writeFileSync(filePath, JSON.stringify(data));
      const mtimeBefore = statSync(filePath).mtimeMs;

      // Small delay to detect file modification
      await new Promise((r) => setTimeout(r, 50));

      const mod = await importModule();
      mod.cleanupOldThreads(999_999_999);

      const mtimeAfter = statSync(filePath).mtimeMs;
      strictEqual(mtimeAfter, mtimeBefore, "file should not be rewritten");
    });
  });

  describe("createForumThread", () => {
    it("should construct correct URL with wait=true and parse response", async () => {
      let capturedUrl = "";
      let capturedBody = "";

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: any, init?: any) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedBody = init?.body ?? "";
        return new Response(
          JSON.stringify({ id: "msg-1", channel_id: "thread-999" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      try {
        const mod = await importModule();
        const threadId = await mod.createForumThread(
          "https://discord.com/api/webhooks/123/abc",
          "Test Thread",
          { title: "Test", description: "Desc", color: 3447003 },
        );

        strictEqual(threadId, "thread-999");
        ok(capturedUrl.includes("wait=true"), "URL should have wait=true");
        const body = JSON.parse(capturedBody);
        strictEqual(body.thread_name, "Test Thread");
        ok(Array.isArray(body.embeds), "should have embeds array");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should throw on non-ok response", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () =>
        new Response("Bad Request", { status: 400, statusText: "Bad Request" });

      try {
        const mod = await importModule();
        let threw = false;
        try {
          await mod.createForumThread(
            "https://discord.com/api/webhooks/123/abc",
            "Thread",
            { title: "T", description: "D", color: 0 },
          );
        } catch (e: any) {
          threw = true;
          ok(e.message.includes("400"), "error should include status code");
        }
        ok(threw, "should throw error");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("sendToThread", () => {
    it("should construct URL with thread_id parameter", async () => {
      let capturedUrl = "";

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: any) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return new Response(null, { status: 200 });
      };

      try {
        const mod = await importModule();
        await mod.sendToThread(
          "https://discord.com/api/webhooks/123/abc",
          "thread-42",
          { title: "T", description: "D", color: 0 },
        );

        ok(
          capturedUrl.includes("thread_id=thread-42"),
          "URL should have thread_id",
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should throw on non-ok response", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () =>
        new Response("Not Found", { status: 404, statusText: "Not Found" });

      try {
        const mod = await importModule();
        let threw = false;
        try {
          await mod.sendToThread(
            "https://discord.com/api/webhooks/123/abc",
            "thread-42",
            { title: "T", description: "D", color: 0 },
          );
        } catch (e: any) {
          threw = true;
          ok(e.message.includes("404"), "error should include status code");
        }
        ok(threw, "should throw error");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
