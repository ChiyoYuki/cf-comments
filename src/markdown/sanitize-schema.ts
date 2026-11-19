import type { Element, ElementContent, Root } from "hast";
import { defaultSchema } from "rehype-sanitize";
import type { Plugin } from "unified";

type SanitizeSchema = typeof defaultSchema;

const SAFE_STYLE_RULES: Record<string, RegExp> = {
  color: /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i,
  "background-color": /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i,
  "--mfm-deg": /^-?\d+(?:\.\d+)?deg$/,
  "--mfm-sx": /^\d+(?:\.\d+)?$/,
  "--mfm-sy": /^\d+(?:\.\d+)?$/,
  "--mfm-px": /^-?\d+(?:\.\d+)?em$/,
  "--mfm-py": /^-?\d+(?:\.\d+)?em$/,
  "--mfm-speed": /^\d+(?:\.\d+)?s$/,
  "--mfm-delay": /^\d+(?:\.\d+)?s$/,
  "--mfm-border-style": /^(?:solid|dashed|dotted|double)$/,
  "--mfm-border-width": /^\d+(?:\.\d+)?px$/,
  "--mfm-border-radius": /^\d+(?:\.\d+)?px$/,
  "--mfm-border-color": /^(?:currentColor|#[0-9a-f]{3}(?:[0-9a-f]{3})?)$/i,
};

export function isSafeHttpUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed.charCodeAt(i) <= 0x1f) return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function filterSafeStyle(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const safeParts: string[] = [];
  for (const decl of raw.split(";")) {
    const trimmed = decl.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const prop = trimmed.slice(0, colon).trim().toLowerCase();
    const val = trimmed.slice(colon + 1).trim();
    const rule = SAFE_STYLE_RULES[prop];
    if (rule?.test(val)) {
      safeParts.push(`${prop}:${val}`);
    }
  }
  return safeParts.length > 0 ? safeParts.join(";") : undefined;
}

/**
 * Official GitHub `defaultSchema` tightened for GFM blog comments:
 * - http(s) only for links and remote images
 * - allows task-list disabled checkboxes and language-* code classes
 */
export const gfmSanitizeSchema: SanitizeSchema = {
  ...defaultSchema,
  protocols: {
    href: ["http", "https"],
    src: ["http", "https"],
  },
  attributes: {
    ...defaultSchema.attributes,
    a: ["href"],
    img: ["src", "alt"],
    code: [["className", /^language-[a-zA-Z0-9_-]+$/]],
    input: [["type", "checkbox"], "checked", "disabled"],
  },
};

/**
 * Official `defaultSchema` extended strictly for MFM HAST elements emitted from `mfm-js`.
 * Disallows <img> entirely in MFM mode (remote images belong in GFM mode; emojis use
 * `<span class="mfm-emoji" data-emoji="...">` resolved client-side from Misskey).
 */
export const mfmSanitizeSchema: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    "p",
    "br",
    "blockquote",
    "pre",
    "code",
    "strong",
    "em",
    "del",
    "a",
    "span",
    "div",
    "small",
    "ruby",
    "rt",
    "time",
  ],
  protocols: {
    href: ["http", "https"],
  },
  attributes: {
    "*": [],
    a: ["href", ["className", /^mfm-(?:mention|hashtag|link|url)$/]],
    code: [["className", /^(?:language-[a-zA-Z0-9_-]+|mfm-math-inline)$/]],
    pre: [["className", /^mfm-math-block$/]],
    span: [["className", /^mfm-[a-z0-9-]+$/], "style", "dataEmoji"],
    div: [["className", /^mfm-center$/]],
    small: [["className", /^mfm-small$/]],
    ruby: [["className", /^mfm-ruby$/]],
    time: [["className", /^mfm-unixtime$/], "dateTime", "dataUnixtime"],
  },
};

function hardenNode(node: ElementContent): ElementContent | null {
  if (node.type !== "element") {
    return node;
  }

  const el: Element = node;
  const props = el.properties ?? {};

  if (el.tagName === "a") {
    const safeHref = isSafeHttpUrl(props.href);
    if (!safeHref) {
      el.tagName = "span";
      el.properties = {};
    } else {
      el.properties = {
        ...(props.className ? { className: props.className } : {}),
        href: safeHref,
        target: "_blank",
        rel: ["noopener", "noreferrer", "ugc", "nofollow"],
      };
    }
  } else if (el.tagName === "img") {
    const safeSrc = isSafeHttpUrl(props.src);
    if (!safeSrc) {
      return null;
    }
    el.properties = {
      src: safeSrc,
      alt: typeof props.alt === "string" ? props.alt : "",
      loading: "lazy",
      decoding: "async",
      referrerPolicy: "no-referrer",
      className: ["cc-img"],
    };
  } else if (el.tagName === "input") {
    if (props.type !== "checkbox") {
      return null;
    }
    el.properties = {
      type: "checkbox",
      disabled: true,
      ...(props.checked ? { checked: true } : {}),
    };
  } else if (props.style !== undefined) {
    const safeStyle = filterSafeStyle(props.style);
    if (safeStyle) {
      props.style = safeStyle;
    } else {
      delete props.style;
    }
    el.properties = props;
  }

  if (Array.isArray(el.children)) {
    const nextChildren: ElementContent[] = [];
    for (const child of el.children) {
      const hardened = hardenNode(child);
      if (hardened) nextChildren.push(hardened);
    }
    el.children = nextChildren;
  }

  return el;
}

export const rehypeHardenNodes: Plugin<[], Root> = () => {
  return (tree: Root) => {
    const nextChildren: ElementContent[] = [];
    for (const child of tree.children) {
      if (
        child.type === "element" ||
        child.type === "text" ||
        child.type === "comment"
      ) {
        const hardened = hardenNode(child as ElementContent);
        if (hardened) nextChildren.push(hardened);
      }
    }
    tree.children = nextChildren;
  };
};
