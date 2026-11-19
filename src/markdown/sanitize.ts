import { escapeHtml } from "./mfm.ts";

const ALLOWED_TAGS = new Set([
  "p",
  "br",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "ul",
  "ol",
  "li",
  "input",
  "pre",
  "code",
  "strong",
  "em",
  "del",
  "hr",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "a",
  "img",
  "span",
  "div",
  "small",
  "ruby",
  "rt",
]);

const VOID_TAGS = new Set(["br", "hr", "img", "input"]);

const DROP_CONTENT_TAGS = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "svg",
  "math",
  "template",
]);

const MFM_CLASS_RE = /^mfm-[a-z0-9-]+$/;
const LANG_CLASS_RE = /^language-[a-zA-Z0-9_-]+$/;
const ALIGN_VALUES = new Set(["left", "center", "right"]);

const STYLE_RULES: Record<string, RegExp> = {
  color: /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i,
  "background-color": /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i,
  "--mfm-deg": /^-?\d+(?:\.\d+)?deg$/,
  "--mfm-sx": /^\d+(?:\.\d+)?$/,
  "--mfm-sy": /^\d+(?:\.\d+)?$/,
  "--mfm-speed": /^\d+(?:\.\d+)?s$/,
  "--mfm-delay": /^\d+(?:\.\d+)?s$/,
  "--mfm-border-style": /^(?:solid|dashed|dotted|double)$/,
  "--mfm-border-width": /^\d+(?:\.\d+)?px$/,
  "--mfm-border-radius": /^\d+(?:\.\d+)?px$/,
  "--mfm-border-color": /^(?:currentColor|#[0-9a-f]{3}(?:[0-9a-f]{3})?)$/i,
};

function decodeBasicEntities(str: string): string {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function isSafeHttpUrl(raw: string): string | null {
  const decoded = decodeBasicEntities(raw).trim();
  if (!decoded) return null;
  // Reject control characters or whitespace inside scheme
  for (let i = 0; i < decoded.length; i++) {
    if (decoded.charCodeAt(i) <= 0x1f) return null;
  }
  try {
    const parsed = new URL(decoded);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function sanitizeStyle(raw: string): string | null {
  const decoded = decodeBasicEntities(raw);
  const safeParts: string[] = [];
  for (const decl of decoded.split(";")) {
    const trimmed = decl.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const prop = trimmed.slice(0, colon).trim().toLowerCase();
    const val = trimmed.slice(colon + 1).trim();
    const rule = STYLE_RULES[prop];
    if (rule?.test(val)) {
      safeParts.push(`${prop}:${val}`);
    }
  }
  return safeParts.length > 0 ? safeParts.join(";") : null;
}

function parseAttributes(attrStr: string): Map<string, string> {
  const attrs = new Map<string, string>();
  let i = 0;
  const len = attrStr.length;

  while (i < len) {
    while (i < len && /\s/.test(attrStr[i] ?? "")) i++;
    if (i >= len || attrStr[i] === "/") break;

    const nameStart = i;
    while (i < len && !/[\s=/>]/.test(attrStr[i] ?? "")) i++;
    const name = attrStr.slice(nameStart, i).toLowerCase();
    if (!name) {
      i++;
      continue;
    }

    while (i < len && /\s/.test(attrStr[i] ?? "")) i++;
    let value = "";
    if (attrStr[i] === "=") {
      i++;
      while (i < len && /\s/.test(attrStr[i] ?? "")) i++;
      const quote = attrStr[i];
      if (quote === '"' || quote === "'") {
        i++;
        const valStart = i;
        while (i < len && attrStr[i] !== quote) i++;
        value = attrStr.slice(valStart, i);
        if (i < len) i++;
      } else {
        const valStart = i;
        while (i < len && !/[\s>]/.test(attrStr[i] ?? "")) i++;
        value = attrStr.slice(valStart, i);
      }
    }
    attrs.set(name, value);
  }

  return attrs;
}

function buildSafeStartTag(tag: string, rawAttrs: string): string | null {
  const attrs = parseAttributes(rawAttrs);

  if (tag === "a") {
    const href = attrs.get("href");
    const safeUrl = href ? isSafeHttpUrl(href) : null;
    if (!safeUrl) {
      return "<span>";
    }
    return `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer ugc nofollow">`;
  }

  if (tag === "img") {
    const src = attrs.get("src");
    const safeUrl = src ? isSafeHttpUrl(src) : null;
    if (!safeUrl) {
      return null;
    }
    const alt = escapeHtml(decodeBasicEntities(attrs.get("alt") ?? ""));
    return `<img src="${escapeHtml(safeUrl)}" alt="${alt}" loading="lazy" decoding="async" referrerpolicy="no-referrer" class="cc-img">`;
  }

  if (tag === "input") {
    if (attrs.get("type")?.toLowerCase() !== "checkbox") {
      return null;
    }
    const checked = attrs.has("checked") ? " checked" : "";
    return `<input type="checkbox" disabled${checked}>`;
  }

  if (tag === "code") {
    const cls = attrs.get("class")?.trim() ?? "";
    const safeClasses = cls.split(/\s+/).filter((c) => LANG_CLASS_RE.test(c));
    return safeClasses.length > 0
      ? `<code class="${safeClasses.join(" ")}">`
      : "<code>";
  }

  if (tag === "th" || tag === "td") {
    const align = attrs.get("align")?.toLowerCase() ?? "";
    return ALIGN_VALUES.has(align) ? `<${tag} align="${align}">` : `<${tag}>`;
  }

  if (tag === "span" || tag === "div" || tag === "small" || tag === "ruby") {
    const parts: string[] = [];
    const cls = attrs.get("class")?.trim() ?? "";
    const safeClasses = cls.split(/\s+/).filter((c) => MFM_CLASS_RE.test(c));
    if (safeClasses.length > 0) {
      parts.push(`class="${safeClasses.join(" ")}"`);
    }
    const style = attrs.get("style");
    if (style) {
      const safeStyle = sanitizeStyle(style);
      if (safeStyle) {
        parts.push(`style="${safeStyle}"`);
      }
    }
    return parts.length > 0 ? `<${tag} ${parts.join(" ")}>` : `<${tag}>`;
  }

  return `<${tag}>`;
}

/**
 * Defense-in-depth HTML allowlist sanitizer.
 * Strips HTML comments, drops disallowed tags (and contents of dangerous tags),
 * enforces strict URL/class/style allowlists, and balances open tags.
 */
export function sanitizeHtml(input: string): string {
  const out: string[] = [];
  const openStack: string[] = [];
  let dropTag: string | null = null;
  let dropDepth = 0;

  let i = 0;
  const len = input.length;

  while (i < len) {
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      if (!dropTag) out.push(input.slice(i));
      break;
    }
    if (lt > i && !dropTag) {
      out.push(input.slice(i, lt));
    }

    // HTML comment
    if (input.startsWith("<!--", lt)) {
      const endComment = input.indexOf("-->", lt + 4);
      i = endComment === -1 ? len : endComment + 3;
      continue;
    }

    // Find tag end respecting quotes
    let gt = lt + 1;
    let quote: string | null = null;
    while (gt < len) {
      const ch = input[gt];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        break;
      }
      gt++;
    }
    if (gt >= len) {
      if (!dropTag) out.push(escapeHtml(input.slice(lt)));
      break;
    }

    const inner = input.slice(lt + 1, gt).trim();
    i = gt + 1;

    if (!inner) continue;

    const isClosing = inner.startsWith("/");
    const tagMatch = (isClosing ? inner.slice(1) : inner).match(
      /^([a-zA-Z][a-zA-Z0-9]*)(?:\s+([\s\S]*))?$/,
    );
    if (!tagMatch?.[1]) {
      if (!dropTag) out.push(escapeHtml(`<${inner}>`));
      continue;
    }

    const tag = tagMatch[1].toLowerCase();
    const rawAttrs = tagMatch[2] ?? "";

    if (dropTag) {
      if (tag === dropTag) {
        if (isClosing) {
          dropDepth--;
          if (dropDepth <= 0) {
            dropTag = null;
            dropDepth = 0;
          }
        } else {
          dropDepth++;
        }
      }
      continue;
    }

    if (DROP_CONTENT_TAGS.has(tag)) {
      if (!isClosing) {
        dropTag = tag;
        dropDepth = 1;
      }
      continue;
    }

    if (!ALLOWED_TAGS.has(tag)) {
      continue;
    }

    if (isClosing) {
      if (VOID_TAGS.has(tag)) continue;
      // Map invalid <a> downgraded to <span>
      const top = openStack[openStack.length - 1];
      if (tag === "a" && top === "span") {
        openStack.pop();
        out.push("</span>");
        continue;
      }
      const idx = openStack.lastIndexOf(tag);
      if (idx !== -1) {
        while (openStack.length > idx) {
          const popped = openStack.pop();
          if (popped) out.push(`</${popped}>`);
        }
      }
      continue;
    }

    const rendered = buildSafeStartTag(tag, rawAttrs);
    if (!rendered) continue;
    out.push(rendered);
    if (!VOID_TAGS.has(tag)) {
      const pushedTag = rendered.startsWith("<span") ? "span" : tag;
      openStack.push(pushedTag);
    }
  }

  while (openStack.length > 0) {
    const popped = openStack.pop();
    if (popped) out.push(`</${popped}>`);
  }

  return out.join("").trim();
}
