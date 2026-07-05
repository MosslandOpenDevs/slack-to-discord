// ── Slack Block Kit types ─────────────────────────────────────

export interface SlackTextObject {
  type: "plain_text" | "mrkdwn";
  text: string;
  emoji?: boolean;
  verbatim?: boolean;
}

export interface SlackRichTextLeaf {
  type: "text" | "link" | "emoji" | "user" | "channel" | "usergroup" | "broadcast" | "color";
  text?: string;
  url?: string;
  name?: string;         // emoji name
  user_id?: string;
  channel_id?: string;
  range?: string;        // broadcast: "channel" | "here" | "everyone"
  style?: {
    bold?: boolean;
    italic?: boolean;
    strike?: boolean;
    code?: boolean;
  };
}

export interface SlackRichTextElement {
  type: "rich_text_section" | "rich_text_list" | "rich_text_preformatted" | "rich_text_quote";
  elements?: SlackRichTextLeaf[];
  style?: "ordered" | "bullet";
  indent?: number;
  border?: number;
}

export interface SlackBlock {
  type: string;
  block_id?: string;
  // rich_text
  elements?: SlackRichTextElement[];
  // section
  text?: SlackTextObject;
  fields?: SlackTextObject[];
  accessory?: unknown;
  // image
  image_url?: string;
  alt_text?: string;
  title?: SlackTextObject;
  // context / actions
  // (elements is reused, typed loosely below for non-rich_text blocks)
}

export interface SlackFile {
  name?: string;
  url_private?: string;
  is_public?: boolean;
  permalink_public?: string;
}

export interface SlackAttachment {
  fallback?: string;
  text?: string;
  title?: string;
  title_link?: string;
  color?: string;
}

export interface SlackMessageEvent {
  type: string;
  subtype?: string;
  bot_id?: string;
  username?: string;
  user?: string;
  text?: string;
  channel?: string;
  ts?: string;
  blocks?: SlackBlock[];
  files?: SlackFile[];
  attachments?: SlackAttachment[];
}

// ── Discord Webhook types ─────────────────────────────────────

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  timestamp?: string;
  footer?: { text: string; icon_url?: string };
  thumbnail?: { url: string };
  image?: { url: string };
  author?: { name: string; url?: string; icon_url?: string };
  fields?: DiscordEmbedField[];
}

export interface DiscordPayload {
  username?: string;
  avatar_url?: string;
  content?: string;
  embeds?: DiscordEmbed[];
}

// ── Transform context ─────────────────────────────────────────

export interface TransformContext {
  /** Raw Slack message event (includes blocks, attachments, files) */
  event: SlackMessageEvent;
  /** Resolved Slack channel name (e.g. "general") */
  channelName: string;
  /** Resolved sender display name */
  userName: string;
  /** Message body as Discord markdown — mrkdwn text, or Block Kit rendered when text is absent, with mentions resolved */
  text: string;
  /** Default Discord payload built by the bridge — modify or replace as needed */
  payload: DiscordPayload;
}
