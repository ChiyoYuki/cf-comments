import type { Element, ElementContent, Root } from "hast";
import * as mfm from "mfm-js";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import { unified } from "unified";
import {
  isSafeHttpUrl,
  mfmSanitizeSchema,
  rehypeHardenNodes,
} from "./sanitize-schema.ts";

export const ALLOWED_MFM_FUNCTIONS = [
  "blur",
  "fg",
  "bg",
  "font",
  "x2",
  "x3",
  "x4",
  "position",
  "flip",
  "rotate",
  "scale",
  "border",
  "ruby",
  "unixtime",
  "tada",
  "jelly",
  "shake",
  "spin",
  "jump",
  "bounce",
  "twitch",
  "rainbow",
  "sparkle",
] as const;

export const MFM_MAX_NESTING_DEPTH = 4;

const HEX_COLOR_RE = /^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/;
const FONT_FAMILIES = new Set(["serif", "monospace", "cursive", "fantasy"]);
const BORDER_STYLES = new Set(["solid", "dashed", "dotted", "double"]);
const ANIM_FUNCTIONS = new Set([
  "tada",
  "jelly",
  "shake",
  "spin",
  "jump",
  "bounce",
  "twitch",
  "rainbow",
  "sparkle",
]);

export interface MfmRenderOptions {
  misskeyInstanceUrl?: string | null;
}

interface WalkContext {
  misskeyOrigin: string | null;
  inSizeScale: boolean;
  animDepth: number;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function parseSeconds(
  raw: string | true | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof raw !== "string") return fallback;
  const match = raw.trim().match(/^(-?\d+(?:\.\d+)?)s?$/i);
  if (!match?.[1]) return fallback;
  const num = Number.parseFloat(match[1]);
  if (!Number.isFinite(num)) return fallback;
  return Number(clamp(num, min, max).toFixed(3));
}

function parseNumber(
  raw: string | true | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof raw !== "string") return fallback;
  const num = Number.parseFloat(raw.trim());
  if (!Number.isFinite(num)) return fallback;
  return Number(clamp(num, min, max).toFixed(3));
}

function textWithBreaks(text: string): ElementContent[] {
  const lines = text.split("\n");
  const out: ElementContent[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line) {
      out.push({ type: "text", value: line });
    }
    if (i < lines.length - 1) {
      out.push({
        type: "element",
        tagName: "br",
        properties: {},
        children: [],
      });
    }
  }
  return out;
}

function el(
  tagName: string,
  properties: Element["properties"],
  children: ElementContent[],
): Element {
  return { type: "element", tagName, properties, children };
}

/**
 * Pure official `mfm-js` parser + HAST mapper + official `rehype-sanitize` pipeline.
 * - Zero custom MFM grammar parsing (delegated 100% to `mfm-js`).
 * - No KaTeX rendering (`mathInline`/`mathBlock` output safe literal code elements).
 * - No search form rendering (`search` outputs original plain text).
 * - No server-side emoji cache/fetch (`emojiCode` emits `<span class="mfm-emoji" data-emoji="...">` when `misskeyInstanceUrl` is set).
 * - `$[position]` allowed (contained by `.cc-md { overflow: hidden }`).
 * - `$[x2]` / `$[x3]` / `$[x4]` all allowed with nested magnification disabled.
 */
export class MfmRenderer {
  private readonly serializer = unified()
    .use(rehypeSanitize, mfmSanitizeSchema)
    .use(rehypeHardenNodes)
    .use(rehypeStringify);

  render(input: string, options: MfmRenderOptions = {}): string {
    const misskeyOrigin = options.misskeyInstanceUrl
      ? (isSafeHttpUrl(options.misskeyInstanceUrl)?.replace(/\/$/, "") ?? null)
      : null;

    const ast = mfm.parse(input, { nestLimit: 10 });
    const ctx: WalkContext = {
      misskeyOrigin,
      inSizeScale: false,
      animDepth: 0,
    };

    const hastChildren = this.mapNodes(ast, ctx);
    const root: Root = { type: "root", children: hastChildren };
    const sanitized = this.serializer.runSync(root);
    return String(this.serializer.stringify(sanitized)).trim();
  }

  private mapNodes(nodes: mfm.MfmNode[], ctx: WalkContext): ElementContent[] {
    const out: ElementContent[] = [];
    for (const node of nodes) {
      out.push(...this.mapNode(node, ctx));
    }
    return out;
  }

  private mapNode(node: mfm.MfmNode, ctx: WalkContext): ElementContent[] {
    switch (node.type) {
      case "text":
        return textWithBreaks(node.props.text);

      case "plain":
        return node.children.flatMap((child) =>
          textWithBreaks(child.props.text),
        );

      case "unicodeEmoji":
        return [{ type: "text", value: node.props.emoji }];

      case "emojiCode": {
        const name = node.props.name;
        const literal = `:${name}:`;
        if (!ctx.misskeyOrigin || !/^[a-zA-Z0-9_+-]+$/.test(name)) {
          return [{ type: "text", value: literal }];
        }
        return [
          el("span", { className: ["mfm-emoji"], dataEmoji: name }, [
            { type: "text", value: literal },
          ]),
        ];
      }

      case "bold":
        return [el("strong", {}, this.mapNodes(node.children, ctx))];

      case "italic":
        return [el("em", {}, this.mapNodes(node.children, ctx))];

      case "strike":
        return [el("del", {}, this.mapNodes(node.children, ctx))];

      case "small":
        return [
          el(
            "small",
            { className: ["mfm-small"] },
            this.mapNodes(node.children, ctx),
          ),
        ];

      case "center":
        return [
          el(
            "div",
            { className: ["mfm-center"] },
            this.mapNodes(node.children, ctx),
          ),
        ];

      case "quote":
        return [el("blockquote", {}, this.mapNodes(node.children, ctx))];

      case "inlineCode":
        return [el("code", {}, [{ type: "text", value: node.props.code }])];

      case "blockCode": {
        const lang = node.props.lang?.trim();
        const codeProps: Element["properties"] =
          lang && /^[a-zA-Z0-9_-]+$/.test(lang)
            ? { className: [`language-${lang}`] }
            : {};
        return [
          el("pre", {}, [
            el("code", codeProps, [{ type: "text", value: node.props.code }]),
          ]),
        ];
      }

      case "mathInline":
        return [
          el("code", { className: ["mfm-math-inline"] }, [
            { type: "text", value: node.props.formula },
          ]),
        ];

      case "mathBlock":
        return [
          el("pre", { className: ["mfm-math-block"] }, [
            el("code", {}, [{ type: "text", value: node.props.formula }]),
          ]),
        ];

      case "search":
        // Explicitly do NOT render search forms; preserve original text
        return textWithBreaks(node.props.content);

      case "url": {
        const safeUrl = isSafeHttpUrl(node.props.url);
        if (!safeUrl) {
          return [{ type: "text", value: node.props.url }];
        }
        return [
          el("a", { href: safeUrl, className: ["mfm-url"] }, [
            { type: "text", value: node.props.url },
          ]),
        ];
      }

      case "link": {
        const safeUrl = isSafeHttpUrl(node.props.url);
        const children = this.mapNodes(node.children, ctx);
        if (!safeUrl) {
          return children;
        }
        return [el("a", { href: safeUrl, className: ["mfm-link"] }, children)];
      }

      case "mention": {
        const { username, host, acct } = node.props;
        if (!ctx.misskeyOrigin) {
          return [{ type: "text", value: acct }];
        }
        const target = host
          ? `${ctx.misskeyOrigin}/@${encodeURIComponent(username)}@${encodeURIComponent(host)}`
          : `${ctx.misskeyOrigin}/@${encodeURIComponent(username)}`;
        return [
          el("a", { href: target, className: ["mfm-mention"] }, [
            { type: "text", value: acct },
          ]),
        ];
      }

      case "hashtag": {
        const tag = node.props.hashtag;
        const label = `#${tag}`;
        if (!ctx.misskeyOrigin) {
          return [{ type: "text", value: label }];
        }
        const target = `${ctx.misskeyOrigin}/tags/${encodeURIComponent(tag)}`;
        return [
          el("a", { href: target, className: ["mfm-hashtag"] }, [
            { type: "text", value: label },
          ]),
        ];
      }

      case "fn":
        return this.mapFnNode(node, ctx);
    }
  }

  private mapFnNode(node: mfm.MfmFn, ctx: WalkContext): ElementContent[] {
    const { name, args } = node.props;

    if (name === "x2" || name === "x3" || name === "x4") {
      // Allow x2, x3, x4 without upper cap, but prevent nested magnification
      if (ctx.inSizeScale) {
        return this.mapNodes(node.children, ctx);
      }
      const childCtx: WalkContext = { ...ctx, inSizeScale: true };
      return [
        el(
          "span",
          { className: ["mfm-size", `mfm-${name}`] },
          this.mapNodes(node.children, childCtx),
        ),
      ];
    }

    if (name === "position") {
      const px = parseNumber(args.x, 0, -10, 10);
      const py = parseNumber(args.y, 0, -10, 10);
      return [
        el(
          "span",
          {
            className: ["mfm-position"],
            style: `--mfm-px:${px}em;--mfm-py:${py}em`,
          },
          this.mapNodes(node.children, ctx),
        ),
      ];
    }

    if (name === "blur") {
      return [
        el(
          "span",
          { className: ["mfm-blur"] },
          this.mapNodes(node.children, ctx),
        ),
      ];
    }

    if (name === "fg") {
      const color = typeof args.color === "string" ? args.color.trim() : "";
      const style = HEX_COLOR_RE.test(color)
        ? `color:#${color.toLowerCase()}`
        : undefined;
      return [
        el(
          "span",
          { className: ["mfm-fg"], ...(style ? { style } : {}) },
          this.mapNodes(node.children, ctx),
        ),
      ];
    }

    if (name === "bg") {
      const color = typeof args.color === "string" ? args.color.trim() : "";
      const style = HEX_COLOR_RE.test(color)
        ? `background-color:#${color.toLowerCase()}`
        : undefined;
      return [
        el(
          "span",
          { className: ["mfm-bg"], ...(style ? { style } : {}) },
          this.mapNodes(node.children, ctx),
        ),
      ];
    }

    if (name === "font") {
      const family =
        Object.keys(args).find((k) => FONT_FAMILIES.has(k)) ?? "serif";
      return [
        el(
          "span",
          { className: [`mfm-font-${family}`] },
          this.mapNodes(node.children, ctx),
        ),
      ];
    }

    if (name === "flip") {
      const hasH = args.h === true;
      const hasV = args.v === true;
      const cls =
        hasH && hasV ? "mfm-flip-hv" : hasV ? "mfm-flip-v" : "mfm-flip-h";
      return [
        el("span", { className: [cls] }, this.mapNodes(node.children, ctx)),
      ];
    }

    if (name === "rotate") {
      const deg = parseNumber(args.deg, 90, -360, 360);
      return [
        el(
          "span",
          { className: ["mfm-rotate"], style: `--mfm-deg:${deg}deg` },
          this.mapNodes(node.children, ctx),
        ),
      ];
    }

    if (name === "scale") {
      const sx = parseNumber(args.x, 1, 0.5, 2);
      const sy = parseNumber(args.y, 1, 0.5, 2);
      return [
        el(
          "span",
          { className: ["mfm-scale"], style: `--mfm-sx:${sx};--mfm-sy:${sy}` },
          this.mapNodes(node.children, ctx),
        ),
      ];
    }

    if (name === "border") {
      const styleArg =
        typeof args.style === "string" && BORDER_STYLES.has(args.style)
          ? args.style
          : "solid";
      const width = parseNumber(args.width, 1, 1, 4);
      const radius = parseNumber(args.radius, 0, 0, 16);
      const colorRaw = typeof args.color === "string" ? args.color.trim() : "";
      const color = HEX_COLOR_RE.test(colorRaw)
        ? `#${colorRaw.toLowerCase()}`
        : "currentColor";
      return [
        el(
          "span",
          {
            className: ["mfm-border"],
            style: `--mfm-border-style:${styleArg};--mfm-border-width:${width}px;--mfm-border-radius:${radius}px;--mfm-border-color:${color}`,
          },
          this.mapNodes(node.children, ctx),
        ),
      ];
    }

    if (name === "ruby") {
      const raw = mfm.toString(node.children);
      const spaceIdx = raw.search(/\s+/);
      if (spaceIdx === -1) {
        return [
          el(
            "ruby",
            { className: ["mfm-ruby"] },
            this.mapNodes(node.children, ctx),
          ),
        ];
      }
      const baseAst = mfm.parse(raw.slice(0, spaceIdx), { nestLimit: 4 });
      const rtText = raw.slice(spaceIdx).trim();
      return [
        el("ruby", { className: ["mfm-ruby"] }, [
          ...this.mapNodes(baseAst, ctx),
          el("rt", {}, [{ type: "text", value: rtText }]),
        ]),
      ];
    }

    if (name === "unixtime") {
      const rawSec = mfm.toString(node.children).trim();
      if (!/^-?\d{1,12}$/.test(rawSec)) {
        return [{ type: "text", value: mfm.toString(node) }];
      }
      const sec = Number.parseInt(rawSec, 10);
      const dt = new Date(sec * 1000);
      if (Number.isNaN(dt.getTime())) {
        return [{ type: "text", value: mfm.toString(node) }];
      }
      const iso = dt.toISOString();
      return [
        el(
          "time",
          {
            className: ["mfm-unixtime"],
            dateTime: iso,
            dataUnixtime: String(sec),
          },
          [
            {
              type: "text",
              value: iso.replace("T", " ").replace(".000Z", " UTC"),
            },
          ],
        ),
      ];
    }

    if (ANIM_FUNCTIONS.has(name)) {
      if (ctx.animDepth >= MFM_MAX_NESTING_DEPTH) {
        return [{ type: "text", value: mfm.toString(node) }];
      }
      const defaultSpeed = name === "spin" ? 1.5 : 1;
      const speed = parseSeconds(args.speed, defaultSpeed, 0.4, 10);
      const delay = parseSeconds(args.delay, 0, 0, 5);
      const classes = ["mfm-anim", `mfm-${name}`];
      if (name === "spin") {
        if (args.x === true) {
          classes.push("mfm-spin-x");
        } else if (args.y === true) {
          classes.push("mfm-spin-y");
        }
        if (args.left === true) {
          classes.push("mfm-spin-left");
        }
        if (args.alternate === true) {
          classes.push("mfm-spin-alternate");
        }
      }
      const childCtx: WalkContext = { ...ctx, animDepth: ctx.animDepth + 1 };
      return [
        el(
          "span",
          {
            className: classes,
            style: `--mfm-speed:${speed}s;--mfm-delay:${delay}s`,
          },
          this.mapNodes(node.children, childCtx),
        ),
      ];
    }

    // Unknown MFM function: render literal text via official mfm.toString
    return [{ type: "text", value: mfm.toString(node) }];
  }
}
