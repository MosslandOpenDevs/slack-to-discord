import { test } from "node:test";
import assert from "node:assert/strict";
import { blocksToMarkdown } from "./blockkit";
import type { SlackBlock } from "./types";

test("header renders as an H2", () => {
  const blocks: SlackBlock[] = [{ type: "header", text: { type: "plain_text", text: "Hello" } }];
  assert.equal(blocksToMarkdown(blocks), "## Hello");
});

test("rich_text section with styled leaves", () => {
  const blocks: SlackBlock[] = [
    {
      type: "rich_text",
      elements: [
        {
          type: "rich_text_section",
          elements: [
            { type: "text", text: "bold", style: { bold: true } },
            { type: "text", text: " and " },
            { type: "text", text: "code", style: { code: true } },
          ],
        },
      ],
    },
  ];
  assert.equal(blocksToMarkdown(blocks), "**bold** and `code`");
});

test("rich_text ordered list", () => {
  const blocks: SlackBlock[] = [
    {
      type: "rich_text",
      elements: [
        {
          type: "rich_text_list",
          style: "ordered",
          elements: [
            { type: "rich_text_section", elements: [{ type: "text", text: "one" }] } as never,
            { type: "rich_text_section", elements: [{ type: "text", text: "two" }] } as never,
          ],
        },
      ],
    },
  ];
  assert.equal(blocksToMarkdown(blocks), "1. one\n2. two");
});

test("bare user and channel leaves emit resolvable tokens", () => {
  const blocks: SlackBlock[] = [
    {
      type: "rich_text",
      elements: [
        {
          type: "rich_text_section",
          elements: [
            { type: "user", user_id: "U9" },
            { type: "text", text: " in " },
            { type: "channel", channel_id: "C9" },
          ],
        },
      ],
    },
  ];
  assert.equal(blocksToMarkdown(blocks), "<@U9> in <#C9>");
});

test("unknown blocks produce no output", () => {
  assert.equal(blocksToMarkdown([{ type: "who_knows" }]), "");
});
