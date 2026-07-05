/**
 * Slack mrkdwn → Discord markdown conversion.
 *
 * Shared by index.ts (live bridge) and test.ts (offline tester) so both
 * produce identical output. Pure and synchronous.
 *
 * Handles, in order:
 *   1. Protect inline / fenced code so nothing inside it is rewritten.
 *   2. Slack link & mention entities  (<@U|name>, <#C|name>, <url|text>, <url>).
 *   3. Bold (*x* → **x**) and strikethrough (~x~ → ~~x~~) with word-boundary
 *      guards so arithmetic ("3 * 4 * 5") and paths ("~/dir") are left alone.
 *   4. Decode the HTML entities Slack escapes in message text (& < >).
 *
 * Bare mentions without a label (<@U123>, <#C123>) are intentionally left as
 * tokens here; the live bridge resolves them to names asynchronously.
 */

import type { SlackMessageEvent } from "./types";
import { blocksToMarkdown } from "./blockkit";

// Characters allowed immediately outside a *bold* / ~strike~ span. Excludes the
// delimiters themselves so we never chew into an adjacent span.
const OUTER = "\\s.,!?;:'\"()\\[\\]{}<>|";

const BOLD_RE = new RegExp(`(?<=^|[${OUTER}])\\*(?=\\S)([^*\\n]*?)(?<=\\S)\\*(?=$|[${OUTER}])`, "g");
const STRIKE_RE = new RegExp(`(?<=^|[${OUTER}])~(?=\\S)([^~\\n]*?)(?<=\\S)~(?=$|[${OUTER}])`, "g");

export function convertMarkdown(text: string): string {
  if (!text) return "";

  // 1. Stash code spans/blocks behind NUL placeholders.
  const chunks: string[] = [];
  const protectedText = text.replace(/```[\s\S]*?```|`[^`]+`/g, (match) => {
    chunks.push(match);
    return `\x00${chunks.length - 1}\x00`;
  });

  const converted = protectedText
    // 2. Slack entities.
    .replace(/<@([A-Z0-9]+)(\|[^>]+)?>/g, (_, id, label) =>
      label ? `@${label.slice(1)}` : `<@${id}>`
    )
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "[$2]($1)")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    // 3. Emphasis (boundary-guarded so it won't touch "3 * 4" or "~/path").
    .replace(BOLD_RE, "**$1**")
    .replace(STRIKE_RE, "~~$1~~")
    // 4. Decode HTML entities (&amp; must be last to avoid double-decoding).
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

  // 5. Restore code spans verbatim.
  return converted.replace(/\x00(\d+)\x00/g, (_, i) => chunks[Number(i)]);
}

/**
 * Produce the Discord-markdown body for a message. Prefers the mrkdwn `text`
 * field; when a Block Kit message omits it, the blocks are rendered instead so
 * the content is not lost. Bare mentions in the result are resolved elsewhere.
 */
export function messageBody(event: SlackMessageEvent): string {
  const text = (event.text ?? "").trim();
  if (text) return convertMarkdown(text);
  if (event.blocks?.length) return blocksToMarkdown(event.blocks);
  return "";
}
