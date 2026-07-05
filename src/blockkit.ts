/**
 * Slack Block Kit → Discord markdown converter.
 *
 * Supported block types:
 *   rich_text, section, header, divider, image, context, actions
 *
 * Supported rich text leaf types:
 *   text (bold/italic/strike/code), link, emoji, user, channel, broadcast
 */

import type { SlackBlock, SlackRichTextElement, SlackRichTextLeaf, SlackTextObject } from "./types";

// ── Public entry point ────────────────────────────────────────

/**
 * Convert a Slack blocks array to a Discord markdown string.
 * Returns an empty string if blocks produce no renderable content.
 */
export function blocksToMarkdown(blocks: SlackBlock[]): string {
  return blocks
    .map(blockToMarkdown)
    .filter(Boolean)
    .join("\n");
}

// ── Block-level renderers ─────────────────────────────────────

function blockToMarkdown(block: SlackBlock): string {
  switch (block.type) {
    case "rich_text":
      return (block.elements as SlackRichTextElement[] | undefined ?? [])
        .map(richTextElementToMarkdown)
        .filter(Boolean)
        .join("\n");

    case "section": {
      const lines: string[] = [];
      if (block.text) lines.push(textObjectToMarkdown(block.text));
      if (block.fields?.length) {
        // Render fields as a two-column-style list
        lines.push(
          block.fields
            .map((f) => `**${textObjectToMarkdown(f)}**`)
            .join("  ·  ")
        );
      }
      return lines.join("\n");
    }

    case "header":
      return block.text ? `## ${block.text.text}` : "";

    case "divider":
      return "──────────────────────────";

    case "image": {
      const label = block.title?.text ?? block.alt_text ?? "image";
      return block.image_url ? `[${label}](${block.image_url})` : "";
    }

    case "context": {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctxElements = (block as any).elements as Array<{ type: string; text?: string; image_url?: string; alt_text?: string }> | undefined ?? [];
      return ctxElements
        .map((el) => {
          if (el.type === "mrkdwn" || el.type === "plain_text") return `-# ${el.text ?? ""}`;
          if (el.type === "image") return el.alt_text ? `[${el.alt_text}]` : "";
          return "";
        })
        .filter(Boolean)
        .join("  ·  ");
    }

    case "actions": {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const actionElements = (block as any).elements as Array<{ type: string; text?: SlackTextObject; url?: string }> | undefined ?? [];
      const labels = actionElements
        .map((el) => {
          const label = el.text?.text ?? "";
          return el.url ? `[${label}](${el.url})` : label;
        })
        .filter(Boolean);
      return labels.length ? `> ${labels.join("  |  ")}` : "";
    }

    default:
      return "";
  }
}

// ── Rich text element renderers ───────────────────────────────

function richTextElementToMarkdown(element: SlackRichTextElement): string {
  switch (element.type) {
    case "rich_text_section":
      return (element.elements ?? []).map(leafToMarkdown).join("");

    case "rich_text_list": {
      const items = element.elements ?? [];
      return items
        .map((item, i) => {
          // Each list item is itself a rich_text_section-like element
          const content = ((item as unknown as SlackRichTextElement).elements ?? []).map(leafToMarkdown).join("");
          const indent = "  ".repeat(element.indent ?? 0);
          const bullet = element.style === "ordered" ? `${i + 1}.` : "•";
          return `${indent}${bullet} ${content}`;
        })
        .join("\n");
    }

    case "rich_text_preformatted": {
      const code = (element.elements ?? []).map(leafToMarkdown).join("");
      return `\`\`\`\n${code}\n\`\`\``;
    }

    case "rich_text_quote": {
      const content = (element.elements ?? []).map(leafToMarkdown).join("");
      return content
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    }

    default:
      return "";
  }
}

// ── Rich text leaf renderers ──────────────────────────────────

function leafToMarkdown(leaf: SlackRichTextLeaf): string {
  switch (leaf.type) {
    case "text": {
      let text = leaf.text ?? "";
      const s = leaf.style ?? {};
      // code takes priority — no other formatting inside code
      if (s.code) return `\`${text}\``;
      if (s.bold)   text = `**${text}**`;
      if (s.italic) text = `*${text}*`;
      if (s.strike) text = `~~${text}~~`;
      return text;
    }

    case "link": {
      const label = leaf.text ?? leaf.url ?? "";
      return leaf.url ? `[${label}](${leaf.url})` : label;
    }

    case "emoji":
      return leaf.name ? `:${leaf.name}:` : "";

    case "user":
      return leaf.user_id ? `<@${leaf.user_id}>` : "";

    case "channel":
      return leaf.channel_id ? `<#${leaf.channel_id}>` : "";

    case "broadcast":
      return `@${leaf.range ?? "channel"}`;

    default:
      return "";
  }
}

// ── Text object renderer (section / header) ───────────────────

function textObjectToMarkdown(obj: SlackTextObject): string {
  // mrkdwn: leave as-is (Discord understands most of it)
  // plain_text: return verbatim
  return obj.text ?? "";
}
