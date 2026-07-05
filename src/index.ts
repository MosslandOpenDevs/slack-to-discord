import "dotenv/config";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import type { SlackMessageEvent } from "./types";
import { transform } from "./transform";
import { messageBody } from "./convert";
import { buildDefaultPayload, isEmptyPayload } from "./payload";

const iso = () => new Date().toISOString();

// ── Environment variable validation ───────────────────────────
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

if (!SLACK_APP_TOKEN || !SLACK_APP_TOKEN.startsWith("xapp-")) {
  console.error("❌ SLACK_APP_TOKEN is missing or invalid (must start with xapp-)");
  process.exit(1);
}
if (!SLACK_BOT_TOKEN || !SLACK_BOT_TOKEN.startsWith("xoxb-")) {
  console.error("❌ SLACK_BOT_TOKEN is missing or invalid (must start with xoxb-)");
  process.exit(1);
}
if (
  !DISCORD_WEBHOOK_URL ||
  !["https://discord.com/api/webhooks/", "https://ptb.discord.com/api/webhooks/", "https://canary.discord.com/api/webhooks/"].some(
    (prefix) => DISCORD_WEBHOOK_URL.startsWith(prefix)
  )
) {
  console.error("❌ DISCORD_WEBHOOK_URL is missing or invalid");
  process.exit(1);
}

// Fixed display name for Discord (overrides sender name when set)
const DISCORD_USERNAME = process.env.DISCORD_USERNAME?.trim() || null;

// Log message content to stdout (opt-in, disabled by default for compliance)
const DEBUG_LOG_CONTENT = process.env.DEBUG_LOG_CONTENT === "true";

// Channel allowlist (forward all channels if empty)
const CHANNEL_ALLOWLIST = (process.env.SLACK_CHANNEL_ALLOWLIST ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Bot ID allowlist (block all bot messages if empty, allow listed bots if set)
const BOT_ALLOWLIST = (process.env.SLACK_BOT_ALLOWLIST ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ── Slack clients ─────────────────────────────────────────────
const socketClient = new SocketModeClient({ appToken: SLACK_APP_TOKEN });
const webClient = new WebClient(SLACK_BOT_TOKEN);

// Bridge bot's own user ID — populated at startup to prevent self-forwarding loops
let ownBotUserId: string | null = null;

// ── TTL cache ─────────────────────────────────────────────────
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_NEG_TTL_MS = 60 * 1000;
const CACHE_MAX_SIZE = 5000; // hard cap so a busy workspace can't grow the map unbounded

interface CacheEntry { value: string; expiresAt: number; }

const channelNameCache = new Map<string, CacheEntry>();
const userNameCache = new Map<string, CacheEntry>();

function cacheGet(cache: Map<string, CacheEntry>, key: string): string | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) { cache.delete(key); return undefined; }
  return entry.value;
}

function cacheSet(cache: Map<string, CacheEntry>, key: string, value: string, ttl: number): void {
  if (cache.size >= CACHE_MAX_SIZE && !cache.has(key)) {
    // Evict the oldest entry (Map preserves insertion order).
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expiresAt: Date.now() + ttl });
}

async function getChannelName(channelId: string): Promise<string> {
  const cached = cacheGet(channelNameCache, channelId);
  if (cached !== undefined) return cached;
  try {
    const res = await webClient.conversations.info({ channel: channelId });
    const name = (res.channel as { name?: string })?.name ?? channelId;
    cacheSet(channelNameCache, channelId, name, CACHE_TTL_MS);
    return name;
  } catch {
    cacheSet(channelNameCache, channelId, channelId, CACHE_NEG_TTL_MS);
    return channelId;
  }
}

async function getUserName(userId: string): Promise<string> {
  const cached = cacheGet(userNameCache, userId);
  if (cached !== undefined) return cached;
  try {
    const res = await webClient.users.info({ user: userId });
    const profile = (res.user as { profile?: { display_name?: string; real_name?: string } })?.profile;
    const name = profile?.display_name?.trim() || profile?.real_name?.trim() || userId;
    cacheSet(userNameCache, userId, name, CACHE_TTL_MS);
    return name;
  } catch {
    cacheSet(userNameCache, userId, userId, CACHE_NEG_TTL_MS);
    return userId;
  }
}

/** Resolve bare <@U…> / <#C…> tokens (no inline label) to @name / #name. */
async function resolveMentions(text: string): Promise<string> {
  if (!text.includes("<@") && !text.includes("<#")) return text;

  const userIds = new Set<string>();
  const channelIds = new Set<string>();
  for (const m of text.matchAll(/<@([A-Z0-9]+)>/g)) userIds.add(m[1]);
  for (const m of text.matchAll(/<#([A-Z0-9]+)>/g)) channelIds.add(m[1]);

  const [users, channels] = await Promise.all([
    Promise.all([...userIds].map(async (id) => [id, await getUserName(id)] as const)),
    Promise.all([...channelIds].map(async (id) => [id, await getChannelName(id)] as const)),
  ]);
  const userMap = new Map(users);
  const channelMap = new Map(channels);

  return text
    .replace(/<@([A-Z0-9]+)>/g, (_, id) => `@${userMap.get(id) ?? id}`)
    .replace(/<#([A-Z0-9]+)>/g, (_, id) => `#${channelMap.get(id) ?? id}`);
}

// ── Send to Discord webhook (with rate-limit retry) ───────────
const FETCH_TIMEOUT_MS = 10_000;
const MAX_RATE_LIMIT_RETRIES = 3;

async function sendToDiscord(payload: object, attempt = 0): Promise<void> {
  const res = await fetch(DISCORD_WEBHOOK_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
    let retryAfterMs = 1000;
    try {
      const json = await res.json() as { retry_after?: number };
      if (typeof json.retry_after === "number") retryAfterMs = json.retry_after * 1000;
    } catch { /* use default */ }
    await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
    return sendToDiscord(payload, attempt + 1);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Discord error ${res.status}: ${body}`);
  }
}

// ── Filtering ─────────────────────────────────────────────────
function shouldSkip(event: SlackMessageEvent): boolean {
  if (event.subtype && ["message_changed", "message_deleted", "channel_join"].includes(event.subtype)) return true;
  if (event.bot_id || event.subtype === "bot_message") {
    if (!event.bot_id || !BOT_ALLOWLIST.includes(event.bot_id)) return true;
  }
  if (ownBotUserId && event.user === ownBotUserId) return true;
  const text = (event.text ?? "").trim();
  if (!text && !event.blocks?.length && !event.files?.length && !event.attachments?.length) return true;
  return false;
}

// ── Core: process one message and send to Discord ─────────────
async function processMessage(event: SlackMessageEvent, channelId: string): Promise<boolean> {
  const userId = event.user;

  const [channelName, resolvedName] = await Promise.all([
    getChannelName(channelId),
    userId ? getUserName(userId) : Promise.resolve(null),
  ]);

  const userName = event.username ?? resolvedName ?? "Unknown";
  const bodyText = await resolveMentions(messageBody(event));

  const defaultPayload = buildDefaultPayload({
    event,
    userName,
    channelName,
    bodyText,
    discordUsername: DISCORD_USERNAME,
  });

  const finalPayload = transform({ event, channelName, userName, text: bodyText, payload: defaultPayload });
  if (finalPayload === null) return false; // dropped by transform

  if (isEmptyPayload(finalPayload)) {
    console.warn(`[${iso()}] ⚠️  Skipped empty payload for #${channelName}`);
    return false;
  }

  await sendToDiscord(finalPayload);

  const logMsg = DEBUG_LOG_CONTENT
    ? `#${channelName} → Discord | ${userName}: ${bodyText.slice(0, 60)}`
    : `#${channelName} → Discord | ${userName}`;
  console.log(`[${iso()}] ✅ ${logMsg}`);
  return true;
}

// ── Per-channel serial queue ──────────────────────────────────
// Messages within one channel are forwarded strictly in order; different
// channels proceed in parallel. Node's EventEmitter does not await async
// listeners, so without this a slow send could reorder a channel's messages.
const channelQueues = new Map<string, Promise<void>>();
let inFlight = 0;
let shuttingDown = false;
let drainResolve: (() => void) | null = null;

function enqueue(channelId: string, task: () => Promise<void>): void {
  inFlight++;
  const prev = channelQueues.get(channelId) ?? Promise.resolve();
  const next = prev.then(task, task).finally(() => {
    inFlight--;
    if (channelQueues.get(channelId) === next) channelQueues.delete(channelId);
    if (inFlight === 0 && drainResolve) drainResolve();
  });
  channelQueues.set(channelId, next);
}

// ── Message event handler ─────────────────────────────────────
socketClient.on("message", async ({ event, ack }: { event: SlackMessageEvent; ack: () => Promise<void> }) => {
  try {
    await ack();
  } catch (err) {
    console.error(`[${iso()}] ⚠️  ack() failed:`, err);
  }

  if (shuttingDown) return;
  if (shouldSkip(event)) return;

  const channelId = event.channel;
  if (!channelId) return;
  if (CHANNEL_ALLOWLIST.length > 0 && !CHANNEL_ALLOWLIST.includes(channelId)) return;

  enqueue(channelId, async () => {
    try {
      await processMessage(event, channelId);
    } catch (err) {
      console.error(`[${iso()}] ❌ Failed to send:`, err);
    }
  });
});

// ── Start ─────────────────────────────────────────────────────
async function main() {
  console.log("🚀 slack2discord bridge starting...");

  try {
    const auth = await webClient.auth.test();
    ownBotUserId = (auth.user_id as string) ?? null;
    if (ownBotUserId) console.log(`🔒 Self-filter active (bot user ID: ${ownBotUserId})`);
  } catch {
    console.warn("⚠️  Could not fetch own bot user ID — self-filter disabled");
  }

  if (CHANNEL_ALLOWLIST.length > 0) {
    console.log(`📌 Channel filter: ${CHANNEL_ALLOWLIST.join(", ")}`);
  } else {
    console.log("📌 No channel filter — forwarding all channels");
  }
  if (BOT_ALLOWLIST.length > 0) {
    console.log(`🤖 Allowed bot IDs: ${BOT_ALLOWLIST.join(", ")}`);
  } else {
    console.log("🤖 All bot messages blocked (SLACK_BOT_ALLOWLIST not set)");
  }

  await socketClient.start();
  console.log("✅ Connected to Slack via Socket Mode. Waiting for messages...");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

// ── Graceful shutdown ─────────────────────────────────────────
const SHUTDOWN_TIMEOUT_MS = 10_000;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — shutting down...`);

  if (inFlight > 0) {
    console.log(`⏳ Waiting for ${inFlight} in-flight message(s)...`);
    await Promise.race([
      new Promise<void>((resolve) => { drainResolve = resolve; }),
      new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
    ]);
  }

  try { await socketClient.disconnect(); }
  catch (err) { console.error("Error during disconnect:", err); }
  process.exit(0);
}

process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT",  () => { void shutdown("SIGINT"); });

// ── Last-resort safety nets ───────────────────────────────────
// A single bad message must never take the whole bridge down silently.
process.on("unhandledRejection", (reason) => {
  console.error(`[${iso()}] ⚠️  Unhandled promise rejection:`, reason);
});
process.on("uncaughtException", (err) => {
  console.error(`[${iso()}] ❌ Uncaught exception:`, err);
  process.exit(1); // exit non-zero so systemd's Restart=on-failure brings us back
});
