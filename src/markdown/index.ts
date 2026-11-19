import { Marked, type Token, type TokenizerAndRendererExtension } from "marked";
import {
  ALLOWED_MFM_FUNCTIONS,
  escapeHtml,
  MFM_MAX_NESTING_DEPTH,
  type MfmFunctionName,
  matchMfmFunction,
  renderMfmHtml,
} from "./mfm.ts";
import { sanitizeHtml } from "./sanitize.ts";

export { ALLOWED_MFM_FUNCTIONS, MFM_MAX_NESTING_DEPTH };

interface MfmToken {
  type: "mfmFn";
  raw: string;
  fn: MfmFunctionName;
  args: Record<string, string | true>;
  body: string;
  tokens: Token[];
  rubyBaseTokens?: Token[];
  rubyRt?: string;
}

interface MfmTagToken {
  type: "mfmWrapperTag";
  raw: string;
  tag: "small" | "center";
  tokens: Token[];
}

function createMarkdownRenderer(): {
  render: (markdown: string) => string;
} {
  let depth = 0;

  const mfmFnExtension: TokenizerAndRendererExtension = {
    name: "mfmFn",
    level: "inline",
    start(src: string) {
      return src.indexOf("$[");
    },
    tokenizer(src: string) {
      if (depth >= MFM_MAX_NESTING_DEPTH) {
        return undefined;
      }
      const matched = matchMfmFunction(src);
      if (!matched) {
        return undefined;
      }
      depth++;
      try {
        let rubyBaseTokens: Token[] | undefined;
        let rubyRt: string | undefined;
        let tokens: Token[];

        if (matched.fn === "ruby") {
          const spaceIdx = matched.body.search(/\s+/);
          if (spaceIdx !== -1) {
            const baseText = matched.body.slice(0, spaceIdx);
            rubyRt = matched.body.slice(spaceIdx).trim();
            rubyBaseTokens = this.lexer.inlineTokens(baseText);
            tokens = [];
          } else {
            tokens = this.lexer.inlineTokens(matched.body);
          }
        } else {
          tokens = this.lexer.inlineTokens(matched.body);
        }

        const token: MfmToken = {
          type: "mfmFn",
          raw: matched.raw,
          fn: matched.fn,
          args: matched.args,
          body: matched.body,
          tokens,
          rubyBaseTokens,
          rubyRt,
        };
        return token;
      } finally {
        depth--;
      }
    },
    renderer(token) {
      const mfmToken = token as unknown as MfmToken;
      if (
        mfmToken.fn === "ruby" &&
        mfmToken.rubyBaseTokens &&
        mfmToken.rubyRt !== undefined
      ) {
        const baseHtml = this.parser.parseInline(mfmToken.rubyBaseTokens);
        return `<ruby class="mfm-ruby">${baseHtml}<rt>${escapeHtml(mfmToken.rubyRt)}</rt></ruby>`;
      }
      const renderedBody = this.parser.parseInline(mfmToken.tokens);
      return renderMfmHtml(
        mfmToken.fn,
        mfmToken.args,
        renderedBody,
        mfmToken.body,
        (text: string) => escapeHtml(text),
      );
    },
  };

  const mfmWrapperTagExtension: TokenizerAndRendererExtension = {
    name: "mfmWrapperTag",
    level: "inline",
    start(src: string) {
      const smallIdx = src.indexOf("<small>");
      const centerIdx = src.indexOf("<center>");
      if (smallIdx === -1) return centerIdx;
      if (centerIdx === -1) return smallIdx;
      return Math.min(smallIdx, centerIdx);
    },
    tokenizer(src: string) {
      if (depth >= MFM_MAX_NESTING_DEPTH) {
        return undefined;
      }
      const match = src.match(/^<(small|center)>([\s\S]+?)<\/\1>/);
      if (!match?.[1] || !match[2]) {
        return undefined;
      }
      const tag = match[1] as "small" | "center";
      depth++;
      try {
        const tokens = this.lexer.inlineTokens(match[2]);
        const token: MfmTagToken = {
          type: "mfmWrapperTag",
          raw: match[0],
          tag,
          tokens,
        };
        return token;
      } finally {
        depth--;
      }
    },
    renderer(token) {
      const wrapToken = token as unknown as MfmTagToken;
      const inner = this.parser.parseInline(wrapToken.tokens);
      if (wrapToken.tag === "small") {
        return `<small class="mfm-small">${inner}</small>`;
      }
      return `<div class="mfm-center">${inner}</div>`;
    },
  };

  const marked = new Marked({
    gfm: true,
    breaks: true,
    async: false,
  });

  marked.use({
    extensions: [mfmFnExtension, mfmWrapperTagExtension],
    renderer: {
      // Escape all raw HTML rather than passing through
      html({ text }) {
        return escapeHtml(text);
      },
    },
  });

  return {
    render(markdown: string): string {
      depth = 0;
      const rawHtml = marked.parse(markdown, { async: false }) as string;
      return sanitizeHtml(rawHtml);
    },
  };
}

/**
 * Render GFM + safe MFM Markdown into a sanitized inner HTML fragment.
 * Does NOT wrap in `.cc-md` (B-side wraps rendered fragments in `.cc-md`).
 */
export function renderMarkdown(markdown: string): string {
  const renderer = createMarkdownRenderer();
  return renderer.render(markdown);
}
