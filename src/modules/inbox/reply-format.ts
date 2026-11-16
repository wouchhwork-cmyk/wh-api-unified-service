import { CHATBOT_DM_REPLY_CHARS, CHATBOT_PUBLIC_REPLY_CHARS } from '@/shared/constants';
import { ConversationKind } from '@/shared/enums';

/**
 * The reply as it will actually arrive, rather than as a model composed it.
 *
 * MARKDOWN IS NOT A FORMAT HERE, IT IS NOISE. Instagram and Facebook render
 * a direct message as plain text, so `**in stock**` arrives with the
 * asterisks attached and a bulleted list arrives as a column of hyphens.
 * Both read as a machine writing, which is the one impression a business
 * reply cannot afford — and both are exactly what a model reaches for when
 * it is being helpful.
 *
 * The instruction already says not to. This is the half that does not
 * depend on the model having listened: an instruction is advice, and a
 * customer sees whatever actually comes out.
 */
export function shapeReply(text: string, maxChars: number): string {
  const plain = stripMarkup(text).trim();
  return clamp(plain, maxChars);
}

/** How long a reply may be where this conversation is happening. */
export function replyCapFor(kind: ConversationKind): number {
  return kind === ConversationKind.CommentThread || kind === ConversationKind.Mention
    ? CHATBOT_PUBLIC_REPLY_CHARS
    : CHATBOT_DM_REPLY_CHARS;
}

function stripMarkup(text: string): string {
  return (
    text
      /* `[Menu](https://…)` → `Menu (https://…)`, because the URL is the useful half. */
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)')
      /* Headings: a DM has no sections. */
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      /* Quote markers, which arrive as literal angle brackets. */
      .replace(/^\s{0,3}>\s?/gm, '')
      /* List markers, keeping the line — turning a list into prose is a
       * rewrite, and rewriting what the model said is not this function's
       * job. Losing the hyphen is enough. */
      .replace(/^\s{0,3}[-*+]\s+/gm, '')
      .replace(/^\s{0,3}\d+[.)]\s+/gm, '')
      .replace(/\*\*(.+?)\*\*/gs, '$1')
      .replace(/__(.+?)__/gs, '$1')
      /*
       * Single asterisks only when they wrap something — a lone `*` is
       * somebody's shrug or a footnote marker, and `2 * 3` is arithmetic.
       * Underscores are left alone entirely: they live in handles and URLs
       * far more often than they emphasise anything.
       */
      .replace(/(^|[\s(])\*(\S[^*\n]*?)\*(?=[\s).,!?]|$)/g, '$1$2')
      .replace(/`([^`\n]+)`/g, '$1')
      /* Three blank lines is a model laying out a document. */
      .replace(/\n{3,}/g, '\n\n')
  );
}

/**
 * Shortened at a place a person would have stopped.
 *
 * A SENTENCE END IS PREFERRED and a word boundary is the fallback, because
 * the failure being avoided is a message that ends mid-word — which reads as
 * a crash rather than as brevity. The ellipsis is only added when the cut
 * was not at a sentence end, where it is the honest signal that something
 * was dropped.
 */
function clamp(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const head = text.slice(0, maxChars);
  const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  if (sentence >= maxChars * 0.5) return head.slice(0, sentence + 1).trim();

  const word = head.lastIndexOf(' ');
  return `${(word > 0 ? head.slice(0, word) : head).trim()}…`;
}
