/**
 * examples/transform.attendance.ts
 *
 * Example transform for a Slack attendance bot.
 *
 * Parses Block Kit structured messages from an attendance bot and formats
 * them as plain-text Discord messages like:
 *   "3월 17일(화) 홍길동 근무 시작 시간: 09:00 출근했습니다."
 *   "3월 17일(화) 홍길동 4시간 30분 (09:00 ~ 13:30) 퇴근했습니다."
 *   "3월 17일(화) 홍길동 2시간 10분째 (09:00 ~ ) 근무중 입니다."
 *
 * Usage:
 *   cp examples/transform.attendance.ts src/transform.ts
 */

import type { TransformContext, DiscordPayload } from "../src/types.js";

export function transform(ctx: TransformContext): DiscordPayload | null {
  const { event, payload } = ctx;

  const text = event.text ?? "";

  // ── Extract name & date from Block Kit ───────────────────────
  // blocks[0] → rich_text → rich_text_section → leaf elements
  const leafs = event.blocks?.[0]?.elements?.[0]?.elements ?? [];
  const name = leafs.find((el) => el.style?.bold)?.text?.trim() ?? "";
  const date = leafs.find((el) => el.style?.code)?.text?.trim() ?? "";

  // attachment[0].text holds work time summary (e.g. "4시간 3분 (10:19 ~ 15:28)")
  // Strip Slack mrkdwn asterisks (e.g. "*10:55*" → "10:55")
  const workTime = (event.attachments?.[0]?.text?.trim() ?? "").replace(/\*([^*]+)\*/g, "$1");

  // No name/date means we couldn't parse the block structure — drop the message
  if (!name || !date) return null;

  let content: string;

  if (text.includes("출근했습니다")) {
    content = workTime
      ? `${date} ${name} ${workTime} 출근했습니다.`
      : `${date} ${name} 출근했습니다.`;

  } else if (text.includes("퇴근했습니다")) {
    content = workTime
      ? `${date} ${name} ${workTime} 퇴근했습니다.`
      : `${date} ${name} 퇴근했습니다.`;

  } else if (text.includes("근무중")) {
    content = workTime
      ? `${date} ${name} ${workTime} 근무중 입니다.`
      : `${date} ${name} 근무중 입니다.`;

  } else {
    // Unknown message type — drop silently
    return null;
  }

  content = content.trim();
  if (!content) return null;

  return {
    username: payload.username,
    content: content.length > 2000 ? content.slice(0, 1997) + "..." : content,
  };
}
