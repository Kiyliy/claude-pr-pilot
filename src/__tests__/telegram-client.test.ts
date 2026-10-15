import { describe, it, expect } from "vitest";
import { sanitizeHtml, markdownToTelegramHtml, formatCommentForTG, splitHtmlSafe } from "../telegram/client";

describe("sanitizeHtml", () => {
  it("keeps allowed Telegram HTML tags", () => {
    expect(sanitizeHtml("<b>bold</b>")).toBe("<b>bold</b>");
    expect(sanitizeHtml("<i>italic</i>")).toBe("<i>italic</i>");
    expect(sanitizeHtml("<code>code</code>")).toBe("<code>code</code>");
    expect(sanitizeHtml("<pre>preformatted</pre>")).toBe("<pre>preformatted</pre>");
    expect(sanitizeHtml('<a href="url">link</a>')).toBe('<a href="url">link</a>');
    expect(sanitizeHtml("<strong>strong</strong>")).toBe("<strong>strong</strong>");
    expect(sanitizeHtml("<em>em</em>")).toBe("<em>em</em>");
    expect(sanitizeHtml("<s>strike</s>")).toBe("<s>strike</s>");
    expect(sanitizeHtml("<blockquote>quote</blockquote>")).toBe("<blockquote>quote</blockquote>");
  });

  it("strips unsupported tags", () => {
    expect(sanitizeHtml("<div>content</div>")).toBe("content");
    expect(sanitizeHtml("<span>content</span>")).toBe("content");
    expect(sanitizeHtml("<p>paragraph</p>")).toBe("paragraph");
    expect(sanitizeHtml("<h1>heading</h1>")).toBe("heading");
    expect(sanitizeHtml('<img src="url" />')).toBe("");
  });

  it("escapes stray angle brackets and ampersands", () => {
    expect(sanitizeHtml("x < y")).toContain("&lt;");
    expect(sanitizeHtml("x > y")).toContain("&gt;");
    expect(sanitizeHtml("AT&T")).toContain("&amp;");
  });

  it("handles mixed allowed and unsupported tags", () => {
    const input = "<div><b>bold</b> text <span>more</span></div>";
    const result = sanitizeHtml(input);
    expect(result).toContain("<b>bold</b>");
    expect(result).not.toContain("<div>");
    expect(result).not.toContain("<span>");
  });
});

describe("markdownToTelegramHtml", () => {
  it("converts bold markdown", () => {
    expect(markdownToTelegramHtml("**bold**")).toBe("<b>bold</b>");
    expect(markdownToTelegramHtml("__bold__")).toBe("<b>bold</b>");
  });

  it("converts italic markdown", () => {
    expect(markdownToTelegramHtml("*italic*")).toBe("<i>italic</i>");
  });

  it("converts strikethrough", () => {
    expect(markdownToTelegramHtml("~~deleted~~")).toBe("<s>deleted</s>");
  });

  it("converts inline code", () => {
    expect(markdownToTelegramHtml("`code`")).toBe("<code>code</code>");
  });

  it("converts code blocks", () => {
    const input = "```js\nconsole.log('hi');\n```";
    const result = markdownToTelegramHtml(input);
    expect(result).toContain("<pre>");
    expect(result).toContain("</pre>");
  });

  it("converts links", () => {
    const result = markdownToTelegramHtml("[text](url)");
    expect(result).toContain('<a href="url">text</a>');
  });

  it("preserves & in link URLs without double-escaping", () => {
    const result = markdownToTelegramHtml("[click](https://example.com?a=1&b=2&c=3)");
    expect(result).toBe('<a href="https://example.com?a=1&b=2&c=3">click</a>');
  });

  it("converts headings to bold", () => {
    expect(markdownToTelegramHtml("# Heading")).toBe("<b>Heading</b>");
    expect(markdownToTelegramHtml("## Sub")).toBe("<b>Sub</b>");
  });

  it("converts horizontal rules", () => {
    expect(markdownToTelegramHtml("---")).toContain("───");
  });

  it("escapes HTML entities in source", () => {
    const result = markdownToTelegramHtml("x < y & z > w");
    expect(result).toContain("&lt;");
    expect(result).toContain("&amp;");
    expect(result).toContain("&gt;");
  });

  it("converts images to alt text", () => {
    expect(markdownToTelegramHtml("![alt text](image.png)")).toBe("alt text");
  });

  it("converts bold+italic", () => {
    expect(markdownToTelegramHtml("***both***")).toBe("<b><i>both</i></b>");
  });

  it("converts blockquotes", () => {
    const result = markdownToTelegramHtml("> quoted text");
    expect(result).toContain("<blockquote>");
    expect(result).toContain("quoted text");
  });
});

describe("formatCommentForTG", () => {
  it("formats a PR comment for Telegram display", () => {
    const comment = {
      author: "octocat",
      body: "LGTM **approved**",
      createdAt: "2024-01-15T10:30:00Z",
    };
    const result = formatCommentForTG(comment);
    expect(result).toContain("<b>octocat</b>");
    expect(result).toContain("2024-01-15 10:30:00");
    expect(result).toContain("<b>approved</b>");
  });

  it("preserves full content for long bodies (no truncation)", () => {
    const comment = {
      author: "user",
      body: "x".repeat(5000),
      createdAt: "2024-01-01T00:00:00Z",
    };
    const result = formatCommentForTG(comment);
    // formatCommentForTG no longer truncates; splitting is done by sendLongMessage
    expect(result).toContain("x".repeat(5000));
    expect(result).not.toContain("...");
  });
});

describe("splitHtmlSafe", () => {
  it("returns single chunk for short text", () => {
    const chunks = splitHtmlSafe("short text", 100);
    expect(chunks).toEqual(["short text"]);
  });

  it("splits at paragraph boundaries", () => {
    const text = "a".repeat(50) + "\n\n" + "b".repeat(50);
    const chunks = splitHtmlSafe(text, 80);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe("a".repeat(50));
    expect(chunks[1]).toBe("b".repeat(50));
  });

  it("splits at newline when no paragraph break", () => {
    const text = "a".repeat(50) + "\n" + "b".repeat(50);
    const chunks = splitHtmlSafe(text, 80);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe("a".repeat(50));
    expect(chunks[1]).toBe("b".repeat(50));
  });

  it("closes and reopens HTML tags across chunks", () => {
    const inner = "x".repeat(100);
    const text = `<b>${inner}</b>`;
    const chunks = splitHtmlSafe(text, 80);
    expect(chunks.length).toBeGreaterThan(1);
    // First chunk should close the <b> tag
    expect(chunks[0]).toContain("</b>");
    // Second chunk should reopen it
    expect(chunks[1].startsWith("<b>")).toBe(true);
  });

  it("handles nested tags", () => {
    const inner = "y".repeat(100);
    const text = `<b><i>${inner}</i></b>`;
    const chunks = splitHtmlSafe(text, 80);
    expect(chunks.length).toBeGreaterThan(1);
    // First chunk should close both tags
    expect(chunks[0]).toContain("</i>");
    expect(chunks[0]).toContain("</b>");
    // Second chunk should reopen both
    expect(chunks[1].startsWith("<b><i>")).toBe(true);
  });

  it("handles very long text with multiple splits", () => {
    const text = Array.from({ length: 10 }, (_, i) => `Section ${i}: ${"z".repeat(200)}`).join("\n\n");
    const chunks = splitHtmlSafe(text, 500);
    expect(chunks.length).toBeGreaterThan(1);
    // All content should be preserved across chunks
    const reassembled = chunks.join("");
    for (let i = 0; i < 10; i++) {
      expect(reassembled).toContain(`Section ${i}`);
    }
  });
});
