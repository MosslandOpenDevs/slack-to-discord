/**
 * Builds the default Discord webhook payload from a Slack message.
 *
 * Shared by the live bridge (index.ts) and the offline tester (test.ts) so the
 * payload previewed offline is byte-for-byte what production would send.
 *
 * All of Discord's hard limits are enforced here in one place:
 *   - username          ≤ 80 chars
 *   - content           ≤ 2000 chars
 *   - embeds            ≤ 10 per message
 *   - embed.title       ≤ 256 chars
 *   - embed.description ≤ 4096 chars
 *   - total text across all embeds ≤ 6000 chars
 *
 * Embeds that would carry no renderable content (e.g. an attachment with only a
 * color) are dropped rather than sent, since Discord rejects them with HTTP 400.
 */

import type { SlackMessageEvent, DiscordPayload, DiscordEmbed } from "./types";

export const MAX_DISCORD_USERNAME_LEN = 80;
export const MAX_DISCORD_CONTENT_LEN = 2000;
export const MAX_DISCORD_EMBEDS = 10;
export const MAX_EMBED_TITLE_LEN = 256;
export const MAX_EMBED_DESC_LEN = 4096;
export const MAX_TOTAL_EMBED_CHARS = 6000;

const SLACK_PURPLE = 0x4a154b;
const ATTACHMENT_GRAY = 0x888888;

/** Clamp `text` to at most `max` characters, never returning more than `max`. */
function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max <= 3) return text.slice(0, max); // no room for an ellipsis
  return text.slice(0, max - 3) + "...";
}

/** Total character cost Discord counts for an embed (title + description + footer). */
function embedCost(embed: DiscordEmbed): number {
  return (embed.title?.length ?? 0) + (embed.description?.length ?? 0) + (embed.footer?.text.length ?? 0);
}

export interface BuildPayloadInput {
  event: SlackMessageEvent;
  /** Sender display name (already resolved). */
  userName: string;
  /** Resolved channel name, shown in the embed footer. */
  channelName: string;
  /** Message body already converted to Discord markdown (mentions resolved). */
  bodyText: string;
  /** Fixed Discord display name that overrides the sender name when set. */
  discordUsername?: string | null;
}

/**
 * Assemble the default payload. Returns a payload that may have no content and
 * no embeds — call {@link isEmptyPayload} before sending to avoid a Discord 400.
 */
export function buildDefaultPayload(input: BuildPayloadInput): DiscordPayload {
  const { event, userName, channelName, bodyText, discordUsername } = input;

  const embeds: DiscordEmbed[] = [];
  let embedBudget = MAX_TOTAL_EMBED_CHARS;

  const pushEmbed = (embed: DiscordEmbed): void => {
    if (embeds.length >= MAX_DISCORD_EMBEDS || embedBudget <= 0) return;
    // Clamp title first (per-field cap + remaining budget) so it can never
    // push the aggregate total over MAX_TOTAL_EMBED_CHARS.
    if (embed.title) {
      embed.title = truncate(embed.title, Math.min(MAX_EMBED_TITLE_LEN, embedBudget));
      if (!embed.title) delete embed.title;
    }
    // Then clamp the description to whatever budget the title/footer leaves.
    if (embed.description) {
      const fixedCost = (embed.title?.length ?? 0) + (embed.footer?.text.length ?? 0);
      const room = Math.min(MAX_EMBED_DESC_LEN, embedBudget - fixedCost);
      if (room <= 0) {
        delete embed.description;
      } else if (embed.description.length > room) {
        embed.description = truncate(embed.description, room);
      }
    }
    // Drop embeds that carry nothing renderable — Discord rejects them.
    if (!embed.title && !embed.description) return;
    embeds.push(embed);
    embedBudget -= embedCost(embed);
  };

  // ── Primary message body ────────────────────────────────────
  if (bodyText) {
    const tsNum = parseFloat(event.ts ?? "");
    const timestamp = Number.isFinite(tsNum) ? new Date(tsNum * 1000).toISOString() : new Date().toISOString();
    pushEmbed({
      description: bodyText,
      color: SLACK_PURPLE,
      footer: { text: `#${channelName}` },
      timestamp,
    });
  }

  // ── Slack attachments → gray embeds ─────────────────────────
  for (const att of event.attachments ?? []) {
    const embed: DiscordEmbed = { color: ATTACHMENT_GRAY };
    if (att.title) {
      const rawTitle = att.title_link ? `[${att.title}](${att.title_link})` : att.title;
      embed.title = truncate(rawTitle, MAX_EMBED_TITLE_LEN);
    }
    const attText = att.text || att.fallback || "";
    if (attText) embed.description = attText;
    pushEmbed(embed);
  }

  // ── File attachments → content links ────────────────────────
  const fileLines = (event.files ?? []).map((f) => {
    const url = f.is_public && f.permalink_public ? f.permalink_public : null;
    const label = f.name ?? "file";
    return url ? `[${label}](${url})` : `${label} *(private)*`;
  });

  const payload: DiscordPayload = {
    username: (discordUsername || userName).slice(0, MAX_DISCORD_USERNAME_LEN) || "Unknown",
    embeds,
  };

  if (fileLines.length > 0) {
    payload.content = truncate(`📎 Attachments:\n${fileLines.join("\n")}`, MAX_DISCORD_CONTENT_LEN);
  }

  return payload;
}

/** True when the payload has neither content nor any embed — Discord would 400 on send. */
export function isEmptyPayload(payload: DiscordPayload): boolean {
  const hasContent = typeof payload.content === "string" && payload.content.trim().length > 0;
  const hasEmbeds = Array.isArray(payload.embeds) && payload.embeds.length > 0;
  return !hasContent && !hasEmbeds;
}
