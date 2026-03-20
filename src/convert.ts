/**
 * Slack mrkdwn → Discord markdown conversion.
 * Extracted here so both index.ts and test.ts can share it.
 */
export function convertMarkdown(text: string): string {
  const chunks: string[] = [];
  const protected_ = text.replace(/```[\s\S]*?```|`[^`]+`/g, (match) => {
    chunks.push(match);
    return `\x00${chunks.length - 1}\x00`;
  });

  const converted = protected_
    .replace(/<@([A-Z0-9]+)(\|[^>]+)?>/g, (_, id, label) =>
      label ? `@${label.slice(1)}` : `<@${id}>`
    )
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "[$2]($1)")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    .replace(/\*([^*]+)\*/g, "**$1**")
    .replace(/~([^~]+)~/g, "~~$1~~");

  return converted.replace(/\x00(\d+)\x00/g, (_, i) => chunks[Number(i)]);
}
