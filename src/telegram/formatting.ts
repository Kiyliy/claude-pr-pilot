/**
 * Telegram HTML formatting utilities.
 * Handles: Markdown→HTML conversion, HTML sanitization, safe chunking, comment formatting.
 */

// Telegram only supports: b, strong, i, em, u, ins, s, strike, del, a, code, pre, blockquote, tg-spoiler
const ALLOWED_TAGS = new Set([
  "b", "strong", "i", "em", "u", "ins", "s", "strike", "del",
  "a", "code", "pre", "blockquote", "tg-spoiler",
]);

/** Strip HTML tags not supported by Telegram, keep text content */
export function sanitizeHtml(html: string): string {
  // Strip unsupported tags
  let result = html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g, (match, tag) => {
    return ALLOWED_TAGS.has(tag.toLowerCase()) ? match : "";
  });
  // Escape stray < > & that aren't part of allowed tags (e.g. "x < y", "AT&T")
  // First protect allowed tags, then escape, then restore
  const placeholder = "\x00TAG";
  const tags: string[] = [];
  result = result.replace(/<\/?(?:b|strong|i|em|u|ins|s|strike|del|a|code|pre|blockquote|tg-spoiler)\b[^>]*>/gi, (m) => {
    tags.push(m);
    return `${placeholder}${tags.length - 1}\x00`;
  });
  result = result.replace(/&(?!amp;|lt;|gt;|quot;|#\d+;)/g, "&amp;");
  result = result.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  result = result.replace(new RegExp(`${placeholder}(\\d+)\x00`, "g"), (_, idx) => tags[Number(idx)]);
  return result;
}

/** Reverse HTML entity escaping (used to restore URLs that were escaped before link parsing) */
function unescapeHtmlEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

/**
 * Convert GitHub-flavored Markdown to Telegram-compatible HTML.
 * Handles: bold, italic, strikethrough, code, code blocks, links, headings, blockquotes.
 * Escapes HTML entities first, then applies conversions.
 */
export function markdownToTelegramHtml(md: string): string {
  let text = md;

  // 1. Escape HTML entities first (before any tag insertion)
  text = text.replace(/&/g, "&amp;");
  text = text.replace(/</g, "&lt;");
  text = text.replace(/>/g, "&gt;");

  // 2. Code blocks (``` ... ```) — must come before inline code
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    // Trim trailing newline inside block
    const trimmed = code.replace(/\n$/, "");
    return `<pre>${trimmed}</pre>`;
  });

  // 3. Inline code (`...`)
  text = text.replace(/`([^`\n]+)`/g, "<code>$1</code>");

  // 4. Images ![alt](url) → just show alt or url
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, url) => {
    return alt || unescapeHtmlEntities(url);
  });

  // 5. Links [text](url) — restore HTML entities in URL (escaped in step 1)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, linkText, url) => {
    return `<a href="${unescapeHtmlEntities(url)}">${linkText}</a>`;
  });

  // 6. Bold + italic (***text*** or ___text___)
  text = text.replace(/\*{3}(.+?)\*{3}/g, "<b><i>$1</i></b>");
  text = text.replace(/_{3}(.+?)_{3}/g, "<b><i>$1</i></b>");

  // 7. Bold (**text** or __text__)
  text = text.replace(/\*{2}(.+?)\*{2}/g, "<b>$1</b>");
  text = text.replace(/_{2}(.+?)_{2}/g, "<b>$1</b>");

  // 8. Italic (*text* or _text_) — avoid matching inside words with _
  text = text.replace(/\*(.+?)\*/g, "<i>$1</i>");

  // 9. Strikethrough (~~text~~)
  text = text.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // 10. Headings (# ... ) → bold
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // 11. Blockquotes (&gt; ... ) — we escaped > earlier so match &gt;
  text = text.replace(/^(?:&gt;)\s?(.*)$/gm, "<blockquote>$1</blockquote>");
  // Merge consecutive blockquote tags
  text = text.replace(/<\/blockquote>\n<blockquote>/g, "\n");

  // 12. Horizontal rules (---, ***, ___) → simple line
  text = text.replace(/^[-*_]{3,}\s*$/gm, "───────────");

  return text;
}

/**
 * Split an HTML string into chunks that respect tag boundaries.
 * Prefers splitting at paragraph breaks (\n\n), then newlines (\n), then spaces.
 * Tracks open tags and re-opens them in subsequent chunks.
 */
export function splitHtmlSafe(html: string, maxLen: number = 3800): string[] {
  if (html.length <= maxLen) return [html];

  const chunks: string[] = [];
  let remaining = html;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Find the best split point within maxLen
    let splitAt = -1;
    const searchRange = remaining.slice(0, maxLen);

    // Prefer paragraph break
    const paraIdx = searchRange.lastIndexOf("\n\n");
    if (paraIdx > maxLen * 0.3) {
      splitAt = paraIdx;
    }

    // Fallback to newline
    if (splitAt === -1) {
      const nlIdx = searchRange.lastIndexOf("\n");
      if (nlIdx > maxLen * 0.3) {
        splitAt = nlIdx;
      }
    }

    // Fallback to space
    if (splitAt === -1) {
      const spIdx = searchRange.lastIndexOf(" ");
      if (spIdx > maxLen * 0.3) {
        splitAt = spIdx;
      }
    }

    // Last resort: hard cut at maxLen
    if (splitAt === -1) {
      splitAt = maxLen;
    }

    let chunk = remaining.slice(0, splitAt);
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");

    // Close any unclosed tags in this chunk, reopen them in the next
    const openTags = getUnclosedTags(chunk);
    if (openTags.length > 0) {
      // Close in reverse order
      chunk += openTags.map((t) => `</${t.name}>`).reverse().join("");
      // Prepend reopening tags (with original attributes) to remaining
      remaining = openTags.map((t) => t.fullTag).join("") + remaining;
    }

    chunks.push(chunk);
  }

  return chunks;
}

/** Find unclosed HTML tags in a string (returns name + full opening tag) */
function getUnclosedTags(html: string): { name: string; fullTag: string }[] {
  const tagStack: { name: string; fullTag: string }[] = [];
  const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(html)) !== null) {
    const fullMatch = match[0];
    const tagName = match[1].toLowerCase();

    if (fullMatch.startsWith("</")) {
      // Closing tag — pop from stack if matching (search from end)
      let idx = -1;
      for (let i = tagStack.length - 1; i >= 0; i--) {
        if (tagStack[i].name === tagName) { idx = i; break; }
      }
      if (idx !== -1) tagStack.splice(idx, 1);
    } else if (!fullMatch.endsWith("/>")) {
      // Opening tag (not self-closing)
      tagStack.push({ name: tagName, fullTag: fullMatch });
    }
  }

  return tagStack;
}

/** Format a GitHub PR comment for Telegram display */
export function formatCommentForTG(comment: { author: string; body: string; createdAt: string }): string {
  const label = `<b>${comment.author}</b> <i>${comment.createdAt.replace("T", " ").slice(0, 19)}</i>`;
  const cleaned = markdownToTelegramHtml(comment.body);
  return `${label}\n\n${cleaned}`;
}

/** Strip ALL HTML tags, return plain text */
export function stripAllHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
}
