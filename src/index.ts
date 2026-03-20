import "dotenv/config";
// import * as fs from "fs";
// import * as path from "path";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import type { SlackMessageEvent, DiscordPayload } from "./types.js";
import { transform } from "./transform.js";
import { convertMarkdown } from "./convert.js";

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

// ── Last-processed timestamp persistence (disabled) ───────────
// const LAST_TS_FILE = path.join(process.cwd(), "last_ts.json");
//
// function readLastTs(): Record<string, string> {
//   try { return JSON.parse(fs.readFileSync(LAST_TS_FILE, "utf-8")); }
//   catch { return {}; }
// }
//
// function writeLastTs(channelId: string, ts: string): void {
//   const data = readLastTs();
//   data[channelId] = ts;
//   fs.writeFileSync(LAST_TS_FILE, JSON.stringify(data, null, 2), "utf-8");
// }

// ── Send to Discord webhook (with rate-limit retry) ───────────
const FETCH_TIMEOUT_MS = 10_000;
const MAX_DISCORD_USERNAME_LEN = 80;
const MAX_DISCORD_CONTENT_LEN = 2000;
const MAX_DISCORD_EMBEDS = 10;

async function sendToDiscord(payload: object, attempt = 0): Promise<void> {
  const res = await fetch(DISCORD_WEBHOOK_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (res.status === 429 && attempt < 3) {
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

// ── Core: process one message and send to Discord ─────────────
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

async function processMessage(event: SlackMessageEvent, channelId: string): Promise<boolean> {
  const text = (event.text ?? "").trim();
  const userId = event.user;

  const [channelName, resolvedName] = await Promise.all([
    getChannelName(channelId),
    userId ? getUserName(userId) : Promise.resolve(null),
  ]);

  const rawUserName = event.username ?? resolvedName ?? "Unknown";
  const userName = rawUserName.slice(0, MAX_DISCORD_USERNAME_LEN) || "Unknown";
  const convertedText = convertMarkdown(text);

  const embeds: DiscordPayload["embeds"] = [];

  if (convertedText) {
    const tsNum = parseFloat(event.ts ?? "");
    const timestamp = Number.isFinite(tsNum) ? new Date(tsNum * 1000).toISOString() : new Date().toISOString();
    embeds.push({
      description: convertedText.length > 4096 ? convertedText.slice(0, 4093) + "..." : convertedText,
      color: 0x4a154b,
      footer: { text: `#${channelName}` },
      timestamp,
    });
  }

  for (const att of event.attachments ?? []) {
    if (embeds.length >= MAX_DISCORD_EMBEDS) break;
    const attText = att.text || att.fallback || "";
    const embed: import("./types.js").DiscordEmbed = { color: 0x888888 };
    if (att.title) embed.title = att.title_link ? `[${att.title}](${att.title_link})` : att.title;
    if (attText) embed.description = attText.length > 4096 ? attText.slice(0, 4093) + "..." : attText;
    embeds.push(embed);
  }

  const fileLines = (event.files ?? []).map((f) => {
    const url = f.is_public && f.permalink_public ? f.permalink_public : null;
    const label = f.name ?? "file";
    return url ? `[${label}](${url})` : `${label} *(private)*`;
  });
  const rawContent = `📎 Attachments:\n${fileLines.join("\n")}`;

  const defaultPayload: DiscordPayload = {
    username: DISCORD_USERNAME ?? userName,
    embeds,
    ...(fileLines.length > 0 && {
      content: rawContent.length > MAX_DISCORD_CONTENT_LEN
        ? rawContent.slice(0, MAX_DISCORD_CONTENT_LEN - 3) + "..."
        : rawContent,
    }),
  };

  const finalPayload = transform({ event, channelName, userName, text: convertedText, payload: defaultPayload });
  if (finalPayload === null) return false; // dropped by transform

  await sendToDiscord(finalPayload);

  const logMsg = DEBUG_LOG_CONTENT
    ? `#${channelName} → Discord | ${userName}: ${text.slice(0, 60)}`
    : `#${channelName} → Discord | ${userName}`;
  console.log(`[${new Date().toISOString()}] ✅ ${logMsg}`);
  return true;
}

// ── Catch-up: send missed messages since last processed ts ────
async function catchUp(channelId: string, sinceTs: string): Promise<void> {
  console.log(`⏪ Catching up #${channelId} since ts=${sinceTs}...`);

  const history = await webClient.conversations.history({
    channel: channelId,
    oldest: sinceTs,
    inclusive: false, // exclude the already-processed message
    limit: 200,
  });

  const missed = ((history.messages ?? []) as SlackMessageEvent[]).reverse(); // oldest first

  if (missed.length === 0) {
    console.log("✅ No missed messages.");
    return;
  }

  console.log(`📬 ${missed.length} missed message(s) — forwarding...`);

  for (const event of missed) {
    if (shouldSkip(event)) continue;
    try {
      await processMessage(event, channelId);
      // if (sent && event.ts) writeLastTs(channelId, event.ts);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] ❌ Catch-up send failed:`, err);
    }
  }
}

// ── Message event handler ─────────────────────────────────────
let inFlightCount = 0;
let shutdownResolve: (() => void) | null = null;

socketClient.on("message", async ({ event, ack }: { event: SlackMessageEvent; ack: () => Promise<void> }) => {
  await ack();

  if (shouldSkip(event)) return;

  const channelId = event.channel;
  if (!channelId) return;

  if (CHANNEL_ALLOWLIST.length > 0 && !CHANNEL_ALLOWLIST.includes(channelId)) return;

  inFlightCount++;
  try {
    await processMessage(event, channelId);
    // if (sent && event.ts) writeLastTs(channelId, event.ts);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ❌ Failed to send:`, err);
  } finally {
    inFlightCount--;
    if (inFlightCount === 0 && shutdownResolve) shutdownResolve();
  }
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

  // ── Catch-up missed messages (disabled) ───────────────────
  // const lastTs = readLastTs();
  // for (const channelId of CHANNEL_ALLOWLIST) {
  //   if (lastTs[channelId]) {
  //     await catchUp(channelId, lastTs[channelId]);
  //   } else {
  //     console.log(`ℹ️  No last_ts for ${channelId} — skipping catch-up (first run)`);
  //   }
  // }

  await socketClient.start();
  console.log("✅ Connected to Slack via Socket Mode. Waiting for messages...");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

// ── Graceful shutdown ─────────────────────────────────────────
async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received — shutting down...`);

  if (inFlightCount > 0) {
    console.log(`⏳ Waiting for ${inFlightCount} in-flight request(s)...`);
    await Promise.race([
      new Promise<void>((resolve) => { shutdownResolve = resolve; }),
      new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
    ]);
  }

  try { await socketClient.disconnect(); }
  catch (err) { console.error("Error during disconnect:", err); }
  process.exit(0);
}

process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT",  () => { void shutdown("SIGINT"); });
