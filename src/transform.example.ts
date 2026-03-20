/**
 * transform.example.ts — Default passthrough transform
 *
 * Copy this file to transform.ts to get started:
 *   cp src/transform.example.ts src/transform.ts
 *
 * The `transform` function is called for every message that passes filters.
 * - Return a DiscordPayload object to send it to Discord.
 * - Return null to silently drop the message.
 *
 * `ctx.payload` contains the default payload built by the bridge.
 * You can modify it directly or build a completely new one from scratch
 * using the raw Slack event in `ctx.event`.
 *
 * Available context:
 *   ctx.event        — raw Slack message event (text, blocks, attachments, files, ...)
 *   ctx.channelName  — resolved Slack channel name  (e.g. "general")
 *   ctx.userName     — resolved sender display name
 *   ctx.text         — Slack mrkdwn converted to Discord markdown (event.text fallback)
 *   ctx.payload      — default Discord payload built by the bridge
 *
 * See examples/ for real-world use cases.
 */

import type { TransformContext, DiscordPayload } from "./types.js";

export function transform(ctx: TransformContext): DiscordPayload | null {
  // Default: forward the message as-is
  return ctx.payload;
}
