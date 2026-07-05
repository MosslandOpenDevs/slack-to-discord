/**
 * preview.ts — Offline transform preview
 *
 * Fetches the last N messages from a Slack channel, runs them through the exact
 * same payload builder + transform pipeline the live bridge uses, and writes the
 * results to preview.log. Nothing is sent to Discord.
 *
 * Because it shares buildDefaultPayload() with index.ts, the payload you preview
 * here (embeds, attachments, file links) matches what production would send.
 * Inline <@user>/<#channel> mentions are not resolved offline.
 *
 * Usage:
 *   npm run build && node dist/preview.js      # today's messages
 *   node dist/preview.js 20                     # last 20 messages
 */

import "dotenv/config";
import { WebClient } from "@slack/web-api";
import { transform } from "./transform";
import { messageBody } from "./convert";
import { buildDefaultPayload } from "./payload";
import type { SlackMessageEvent } from "./types";
import * as fs from "fs";

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN!;
const CHANNEL_ID = (process.env.SLACK_CHANNEL_ALLOWLIST ?? "").split(",")[0].trim();
const FETCH_COUNT = parseInt(process.argv[2] ?? "100", 10);
const LOG_FILE = "preview.log";

// Today's midnight in KST (UTC+9)
const KST_OFFSET = 9 * 60 * 60 * 1000;
const nowKst = new Date(Date.now() + KST_OFFSET);
nowKst.setUTCHours(0, 0, 0, 0);
const OLDEST_TS = String((nowKst.getTime() - KST_OFFSET) / 1000);

if (!SLACK_BOT_TOKEN) { console.error("SLACK_BOT_TOKEN missing"); process.exit(1); }
if (!CHANNEL_ID)       { console.error("SLACK_CHANNEL_ALLOWLIST missing"); process.exit(1); }

const webClient = new WebClient(SLACK_BOT_TOKEN);

async function getDisplayName(userId?: string): Promise<string> {
  if (!userId) return "Unknown";
  try {
    const res = await webClient.users.info({ user: userId });
    const profile = (res.user as { profile?: { display_name?: string; real_name?: string } })?.profile;
    return profile?.display_name?.trim() || profile?.real_name?.trim() || userId;
  } catch { return userId; }
}

async function getChannelName(channelId: string): Promise<string> {
  try {
    const res = await webClient.conversations.info({ channel: channelId });
    return (res.channel as { name?: string })?.name ?? channelId;
  } catch { return channelId; }
}

async function main() {
  console.log(`Fetching today's messages from channel ${CHANNEL_ID} (since ${new Date(Number(OLDEST_TS) * 1000).toISOString()})...`);

  const history = await webClient.conversations.history({
    channel: CHANNEL_ID,
    limit: FETCH_COUNT,
    oldest: OLDEST_TS,
  });

  const messages = (history.messages ?? []) as SlackMessageEvent[];

  if (messages.length === 0) {
    console.log("No messages found.");
    return;
  }

  const channelName = await getChannelName(CHANNEL_ID);
  const lines: string[] = [];
  lines.push(`Test run : ${new Date().toISOString()}`);
  lines.push(`Channel  : #${channelName} (${CHANNEL_ID})`);
  lines.push(`Fetched  : ${messages.length} message(s)`);
  lines.push("─".repeat(60));

  let sent = 0;
  let dropped = 0;

  for (const event of messages) {
    const userName = await getDisplayName(event.user);
    const bodyText = messageBody(event);
    const defaultPayload = buildDefaultPayload({ event, userName, channelName, bodyText });

    const result = transform({ event, channelName, userName, text: bodyText, payload: defaultPayload });

    if (result === null) {
      dropped++;
    } else {
      sent++;
      const ts = event.ts ? new Date(parseFloat(event.ts) * 1000).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : "";
      lines.push(`[${ts}] ${result.content ?? JSON.stringify(result.embeds?.[0])}`);
    }
  }

  lines.push("─".repeat(60));
  lines.push(`Sent: ${sent}  |  Dropped: ${dropped}`);

  fs.writeFileSync(LOG_FILE, lines.join("\n"), "utf-8");
  console.log(`✅ Done. Results written to ${LOG_FILE}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
