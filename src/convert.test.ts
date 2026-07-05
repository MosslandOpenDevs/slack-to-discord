import { test } from "node:test";
import assert from "node:assert/strict";
import { convertMarkdown, messageBody } from "./convert";

test("bold and strikethrough convert", () => {
  assert.equal(convertMarkdown("*hello*"), "**hello**");
  assert.equal(convertMarkdown("~gone~"), "~~gone~~");
  assert.equal(convertMarkdown("a *b* c"), "a **b** c");
  assert.equal(convertMarkdown("(*b*)"), "(**b**)");
});

test("arithmetic and paths are left alone", () => {
  assert.equal(convertMarkdown("3 * 4 * 5"), "3 * 4 * 5");
  assert.equal(convertMarkdown("2*3"), "2*3");
  assert.equal(convertMarkdown("~/path/to and ~/other"), "~/path/to and ~/other");
});

test("Slack link and mention entities", () => {
  assert.equal(convertMarkdown("<https://a.com|click>"), "[click](https://a.com)");
  assert.equal(convertMarkdown("<https://a.com>"), "https://a.com");
  assert.equal(convertMarkdown("<#C123|general>"), "#general");
  assert.equal(convertMarkdown("<@U1|john>"), "@john");
});

test("bare mentions are left as tokens for later resolution", () => {
  assert.equal(convertMarkdown("<@U1>"), "<@U1>");
});

test("HTML entities are decoded (amp last)", () => {
  assert.equal(convertMarkdown("a &amp; b &lt; c &gt; d"), "a & b < c > d");
  assert.equal(convertMarkdown("&amp;lt;"), "&lt;");
});

test("code spans are never rewritten", () => {
  assert.equal(convertMarkdown("`*not*`"), "`*not*`");
  assert.equal(convertMarkdown("```\n*x* & <y>\n```"), "```\n*x* & <y>\n```");
});

test("nested link inside bold", () => {
  assert.equal(convertMarkdown("*<https://x.com|y>*"), "**[y](https://x.com)**");
});

test("empty input yields empty string", () => {
  assert.equal(convertMarkdown(""), "");
});

test("messageBody prefers text over blocks", () => {
  const event = { type: "message", text: "*hi*", blocks: [{ type: "section", text: { type: "mrkdwn" as const, text: "block" } }] };
  assert.equal(messageBody(event), "**hi**");
});

test("messageBody falls back to blocks when text is absent", () => {
  const event = {
    type: "message",
    blocks: [{ type: "header", text: { type: "plain_text" as const, text: "Title" } }],
  };
  assert.equal(messageBody(event), "## Title");
});

test("messageBody is empty when there is nothing to render", () => {
  assert.equal(messageBody({ type: "message" }), "");
});
