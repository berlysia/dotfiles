/**
 * Discord Forum Thread Management
 *
 * Manages forum channel threads for Discord webhook notifications.
 * Each Claude Code session maps to one forum thread, allowing all events
 * within a session to be grouped together for better visibility.
 *
 * Thread mapping is persisted to a JSON file so that events across
 * different hook invocations within the same session share a thread.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const THREADS_FILE = path.join(
  process.env.HOME ?? "~",
  ".claude",
  ".discord-forum-threads.json",
);

const MAX_THREAD_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface ThreadEntry {
  threadId: string;
  createdAt: number;
}

type ThreadMap = Record<string, ThreadEntry>;

/**
 * Load session-to-thread mapping from disk.
 * Returns empty map if file doesn't exist or is malformed.
 */
export function loadThreadMap(): ThreadMap {
  try {
    const raw = fs.readFileSync(THREADS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as ThreadMap;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Persist a session's thread ID to the mapping file.
 */
export function saveThreadId(sessionId: string, threadId: string): void {
  const map = loadThreadMap();
  map[sessionId] = { threadId, createdAt: Date.now() };
  const dir = path.dirname(THREADS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(THREADS_FILE, JSON.stringify(map, null, 2));
}

/**
 * Look up a thread ID for a given session.
 */
export function getThreadId(sessionId: string): string | null {
  const map = loadThreadMap();
  return map[sessionId]?.threadId ?? null;
}

/**
 * Remove entries older than maxAge from the thread map.
 */
export function cleanupOldThreads(maxAgeMs: number = MAX_THREAD_AGE_MS): void {
  const map = loadThreadMap();
  const now = Date.now();
  let changed = false;

  for (const [sessionId, entry] of Object.entries(map)) {
    if (now - entry.createdAt > maxAgeMs) {
      delete map[sessionId];
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(THREADS_FILE, JSON.stringify(map, null, 2));
  }
}

interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  footer?: { text: string };
}

interface ForumThreadResponse {
  id: string;
  channel_id: string;
}

/**
 * Create a new forum thread via Discord webhook.
 *
 * Discord forum webhooks use `thread_name` in the POST body to create
 * a new thread. The `?wait=true` query parameter makes the API return
 * the created message, whose `channel_id` is the thread ID.
 */
export async function createForumThread(
  webhookUrl: string,
  threadName: string,
  embed: DiscordEmbed,
): Promise<string> {
  const url = new URL(webhookUrl);
  url.searchParams.set("wait", "true");

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      thread_name: threadName,
      embeds: [embed],
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Discord forum thread creation failed: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as ForumThreadResponse;
  return data.channel_id;
}

/**
 * Send a message to an existing forum thread via Discord webhook.
 *
 * Appends `?thread_id={id}` to the webhook URL to target the thread.
 */
export async function sendToThread(
  webhookUrl: string,
  threadId: string,
  embed: DiscordEmbed,
): Promise<void> {
  const url = new URL(webhookUrl);
  url.searchParams.set("thread_id", threadId);

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] }),
  });

  if (!response.ok) {
    throw new Error(
      `Discord forum thread post failed: ${response.status} ${response.statusText}`,
    );
  }
}
