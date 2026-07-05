import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDefaultPayload,
  isEmptyPayload,
  MAX_DISCORD_EMBEDS,
  MAX_EMBED_TITLE_LEN,
  MAX_EMBED_DESC_LEN,
  MAX_TOTAL_EMBED_CHARS,
} from "./payload";

const embedTextTotal = (embeds: { title?: string; description?: string; footer?: { text: string } }[]) =>
  embeds.reduce((n, e) => n + (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.footer?.text.length ?? 0), 0);
import type { SlackMessageEvent } from "./types";

const base = (over: Partial<SlackMessageEvent> = {}): SlackMessageEvent => ({
  type: "message",
  ts: "1700000000.000100",
  ...over,
});

test("plain text builds a single Slack-purple embed with channel footer", () => {
  const p = buildDefaultPayload({ event: base(), userName: "Alice", channelName: "general", bodyText: "hello" });
  assert.equal(p.embeds?.length, 1);
  assert.equal(p.embeds?.[0].description, "hello");
  assert.equal(p.embeds?.[0].color, 0x4a154b);
  assert.equal(p.embeds?.[0].footer?.text, "#general");
  assert.ok(p.embeds?.[0].timestamp);
  assert.equal(isEmptyPayload(p), false);
});

test("empty body with no attachments/files is an empty payload", () => {
  const p = buildDefaultPayload({ event: base({ blocks: [{ type: "divider" }] }), userName: "Bot", channelName: "c", bodyText: "" });
  assert.deepEqual(p.embeds, []);
  assert.equal(p.content, undefined);
  assert.equal(isEmptyPayload(p), true);
});

test("attachment with only a color is dropped (would 400 on Discord)", () => {
  const event = base({ attachments: [{ color: "#ff0000" }] });
  const p = buildDefaultPayload({ event, userName: "u", channelName: "c", bodyText: "" });
  assert.deepEqual(p.embeds, []);
  assert.equal(isEmptyPayload(p), true);
});

test("attachment with title/text becomes an embed", () => {
  const event = base({ attachments: [{ title: "T", title_link: "https://x.com", text: "body" }] });
  const p = buildDefaultPayload({ event, userName: "u", channelName: "c", bodyText: "" });
  assert.equal(p.embeds?.length, 1);
  assert.equal(p.embeds?.[0].title, "[T](https://x.com)");
  assert.equal(p.embeds?.[0].description, "body");
});

test("public files render as links, private files are marked", () => {
  const event = base({
    files: [
      { name: "a.png", is_public: true, permalink_public: "https://f/a" },
      { name: "secret.pdf", is_public: false },
    ],
  });
  const p = buildDefaultPayload({ event, userName: "u", channelName: "c", bodyText: "" });
  assert.ok(p.content?.includes("[a.png](https://f/a)"));
  assert.ok(p.content?.includes("secret.pdf *(private)*"));
});

test("discordUsername overrides sender and is length-capped", () => {
  const p = buildDefaultPayload({ event: base(), userName: "sender", channelName: "c", bodyText: "x", discordUsername: "Fixed" });
  assert.equal(p.username, "Fixed");
  const long = "n".repeat(200);
  const p2 = buildDefaultPayload({ event: base(), userName: long, channelName: "c", bodyText: "x" });
  assert.equal(p2.username?.length, 80);
});

test("body longer than the per-embed cap is truncated", () => {
  const p = buildDefaultPayload({ event: base(), userName: "u", channelName: "c", bodyText: "a".repeat(5000) });
  assert.ok((p.embeds?.[0].description?.length ?? 0) <= MAX_EMBED_DESC_LEN);
  assert.ok(p.embeds?.[0].description?.endsWith("..."));
});

test("aggregate embed text never exceeds Discord's 6000-char budget", () => {
  const attachments = Array.from({ length: 20 }, (_, i) => ({ title: `t${i}`, text: "z".repeat(1000) }));
  const p = buildDefaultPayload({ event: base({ attachments }), userName: "u", channelName: "c", bodyText: "b".repeat(1000) });
  assert.ok(embedTextTotal(p.embeds ?? []) <= MAX_TOTAL_EMBED_CHARS);
});

test("attachment title is capped at Discord's 256-char limit", () => {
  const event = base({ attachments: [{ title: "T".repeat(400), text: "body" }] });
  const p = buildDefaultPayload({ event, userName: "u", channelName: "c", bodyText: "" });
  assert.ok((p.embeds?.[0].title?.length ?? 0) <= MAX_EMBED_TITLE_LEN);
});

test("budget holds even when a huge title nearly exhausts it (room in 1..3 regression)", () => {
  // Adversarial shape from review: body clamps to 4096, then an attachment whose
  // title + text would previously overshoot via a broken truncate().
  const event = base({ attachments: [{ title: "x".repeat(1894), text: "z".repeat(500) }] });
  const p = buildDefaultPayload({ event, userName: "u", channelName: "general", bodyText: "a".repeat(5000) });
  assert.ok(embedTextTotal(p.embeds ?? []) <= MAX_TOTAL_EMBED_CHARS);
});

test("budget and per-field caps hold across many large mixed embeds", () => {
  const attachments = Array.from({ length: 40 }, () => ({ title: "t".repeat(300), text: "z".repeat(800) }));
  const p = buildDefaultPayload({ event: base({ attachments }), userName: "u", channelName: "general", bodyText: "b".repeat(9000) });
  assert.ok(embedTextTotal(p.embeds ?? []) <= MAX_TOTAL_EMBED_CHARS, "aggregate over 6000");
  for (const e of p.embeds ?? []) {
    assert.ok((e.title?.length ?? 0) <= MAX_EMBED_TITLE_LEN, "title over 256");
    assert.ok((e.description?.length ?? 0) <= MAX_EMBED_DESC_LEN, "description over 4096");
  }
});

test("embed count is capped", () => {
  const attachments = Array.from({ length: 30 }, (_, i) => ({ title: `t${i}`, text: "short" }));
  const p = buildDefaultPayload({ event: base({ attachments }), userName: "u", channelName: "c", bodyText: "body" });
  assert.ok((p.embeds?.length ?? 0) <= MAX_DISCORD_EMBEDS);
});
