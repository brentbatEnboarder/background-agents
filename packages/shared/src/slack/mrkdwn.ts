/**
 * Pure sanitizers for Slack `mrkdwn` text supplied by an untrusted source
 * (e.g., an agent inside a sandbox). The control plane composes these into
 * `sanitizeAgentText` before handing text to `chat.postMessage`.
 */

export type MentionPolicy = "allow" | "escape" | "strip";

export const SLACK_DELIVERY_MENTION_PLACEHOLDER = "{{delivery_mention}}";

export interface SanitizeOptions {
  mentionsPolicy: MentionPolicy;
  /** When set, preserve only this exact direct user mention and strip all others. */
  allowedMentionUserId?: string | null;
  maxLength: number;
}

export interface SanitizeResult {
  text: string;
  truncated: boolean;
  strippedBroadcasts: boolean;
  mentionsModified: boolean;
}

const TRUNCATION_MARKER = "… (truncated)";

const BROADCAST_MENTION_RE = /<!(?:channel|here|everyone|subteam\^[A-Z0-9]+(?:\|[^>]*)?)>/g;
const URL_LINK_RE = /<(https?:\/\/[^|>\s]+|mailto:[^|>\s]+)(?:\|[^>]*)?>/g;
const USER_MENTION_RE = /<@([A-Z0-9]+)(?:\|[^>]*)?>/g;

export function stripBroadcastMentions(text: string): string {
  return text.replace(BROADCAST_MENTION_RE, "");
}

/**
 * Escape text for literal display inside Slack `mrkdwn`: `&`, `<`, and `>`
 * become entities, which neutralizes every control sequence (broadcast and
 * user mentions, links). For untrusted display *labels* — unlike
 * {@link sanitizeAgentText}, which preserves intentional formatting in prose.
 */
export function escapeMrkdwnText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function sanitizeLinks(text: string): string {
  return text.replace(URL_LINK_RE, "$1");
}

export function applyMentionPolicy(text: string, policy: MentionPolicy): string {
  if (policy === "allow") return text;
  if (policy === "escape") return text.replace(USER_MENTION_RE, "@$1");
  return text.replace(USER_MENTION_RE, "");
}

export function allowExactUserMention(text: string, allowedUserId: string | null): string {
  return text.replace(USER_MENTION_RE, (_mention, userId: string) =>
    userId === allowedUserId ? `<@${userId}>` : ""
  );
}

export function resolveDeliveryMentionPlaceholder(
  text: string,
  configuredUserId: string | null
): string {
  return text.replaceAll(
    SLACK_DELIVERY_MENTION_PLACEHOLDER,
    configuredUserId ? `<@${configuredUserId}>` : ""
  );
}

export function truncateForSlack(
  text: string,
  maxLength: number
): { text: string; truncated: boolean } {
  if (text.length <= maxLength) return { text, truncated: false };
  if (maxLength < TRUNCATION_MARKER.length) {
    return { text: TRUNCATION_MARKER.slice(0, maxLength), truncated: true };
  }
  return {
    text: text.slice(0, maxLength - TRUNCATION_MARKER.length) + TRUNCATION_MARKER,
    truncated: true,
  };
}

/**
 * Convert standard Markdown emphasis, headings, bullets, and links to Slack `mrkdwn`.
 *
 * Agents emit standard Markdown because that is their default and because every other surface --
 * Open-Inspect's own transcript view included -- renders it correctly. Slack does not, so the same
 * text that looks right everywhere else arrives with literal asterisks. Instructing the model not to
 * emit Markdown has repeatedly failed, because nothing the model can observe tells it that it was
 * wrong. Converting here removes the problem from the model's shoulders entirely.
 *
 * Only *unambiguous* Markdown is converted. A single `*text*` is deliberately left alone: it means
 * bold in Slack and italic in Markdown, so rewriting it would corrupt text that was already correct.
 * `_text_` is italic in both and needs no change. That leaves `**`, `***`, `__`, `___`, ATX headings,
 * `- ` bullets, and `[text](url)` links, none of which mean anything in Slack today.
 *
 * Fenced blocks and inline code spans pass through untouched: asterisks and hashes inside code are
 * content, not formatting.
 */
export function convertMarkdownToMrkdwn(text: string): string {
  // Split on fenced code blocks first, then on inline code spans, and transform only what is left.
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((block, blockIndex) => {
      if (blockIndex % 2 === 1) return block;
      return block
        .split(/(`[^`\n]*`)/g)
        .map((segment, segmentIndex) => {
          if (segmentIndex % 2 === 1) return segment;
          return (
            segment
              // Bold+italic before bold, or the bold rule would consume the first two markers.
              .replace(/\*\*\*(?!\s)([\s\S]+?)(?<!\s)\*\*\*/g, "*_$1_*")
              .replace(/___(?!\s)([\s\S]+?)(?<!\s)___/g, "*_$1_*")
              .replace(/\*\*(?!\s)([\s\S]+?)(?<!\s)\*\*/g, "*$1*")
              .replace(/__(?!\s)([\s\S]+?)(?<!\s)__/g, "*$1*")
              // Headings become a short bold line, which is the Slack equivalent of a heading.
              .replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*$/gm, "*$1*")
              // `- ` is unambiguous; `* ` is left alone because `*` opens bold in Slack.
              .replace(/^([ \t]*)[-][ \t]+/gm, "$1• ")
              // Flatten Markdown links rather than building `<url|label>`: sanitizeLinks already
              // strips Slack link syntax so an agent-supplied label cannot disguise a destination.
              // Keeping both parts preserves the meaning without reintroducing that risk.
              .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, "$1 ($2)")
          );
        })
        .join("");
    })
    .join("");
}

export function sanitizeAgentText(text: string, opts: SanitizeOptions): SanitizeResult {
  const afterBroadcasts = stripBroadcastMentions(text);
  const strippedBroadcasts = afterBroadcasts !== text;

  // Before truncation, so the length ceiling measures the text Slack will actually receive.
  const afterMarkdown = convertMarkdownToMrkdwn(afterBroadcasts);

  const afterLinks = sanitizeLinks(afterMarkdown);

  const afterMentions =
    opts.allowedMentionUserId !== undefined
      ? allowExactUserMention(afterLinks, opts.allowedMentionUserId)
      : applyMentionPolicy(afterLinks, opts.mentionsPolicy);
  const mentionsModified = afterMentions !== afterLinks;

  const truncated = truncateForSlack(afterMentions, opts.maxLength);

  return {
    text: truncated.text,
    truncated: truncated.truncated,
    strippedBroadcasts,
    mentionsModified,
  };
}
