export const ALLOWED_MFM_FUNCTIONS = [
  "blur",
  "fg",
  "bg",
  "font",
  "x2",
  "flip",
  "rotate",
  "scale",
  "border",
  "ruby",
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

export type MfmFunctionName = (typeof ALLOWED_MFM_FUNCTIONS)[number];

export const MFM_MAX_NESTING_DEPTH = 4;

const ALLOWED_SET = new Set<string>(ALLOWED_MFM_FUNCTIONS);
const ANIM_SET = new Set<string>([
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
const HEX_COLOR_RE = /^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/;
const FONT_FAMILIES = new Set(["serif", "monospace", "cursive", "fantasy"]);
const BORDER_STYLES = new Set(["solid", "dashed", "dotted", "double"]);

export interface ParsedMfmMatch {
  raw: string;
  fn: MfmFunctionName;
  args: Record<string, string | true>;
  body: string;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

function parseArgs(rawArgs: string | undefined): Record<string, string | true> {
  const result: Record<string, string | true> = {};
  if (!rawArgs) return result;
  for (const part of rawArgs.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) {
      result[trimmed] = true;
    } else {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (key) {
        result[key] = val;
      }
    }
  }
  return result;
}

/**
 * Scan balanced `$[fn(.args)? body]` starting at index 0 of `src`.
 * Respects nested `[` / `]` and inline backtick code spans inside the body.
 */
export function matchMfmFunction(src: string): ParsedMfmMatch | null {
  if (!src.startsWith("$[")) return null;
  const headerMatch = src.match(
    /^\$\[([a-z][a-z0-9]*)(?:\.([a-zA-Z0-9_,=.-]+))? /,
  );
  if (!headerMatch?.[1]) return null;

  const fn = headerMatch[1];
  if (!ALLOWED_SET.has(fn)) return null;

  const startBody = headerMatch[0].length;
  let depth = 1;
  let i = startBody;
  let inBacktickLen = 0;

  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\" && inBacktickLen === 0) {
      i += 2;
      continue;
    }
    if (ch === "`") {
      let run = 1;
      while (i + run < src.length && src[i + run] === "`") {
        run++;
      }
      if (inBacktickLen === 0) {
        inBacktickLen = run;
      } else if (inBacktickLen === run) {
        inBacktickLen = 0;
      }
      i += run;
      continue;
    }
    if (inBacktickLen === 0) {
      if (ch === "[") {
        depth++;
      } else if (ch === "]") {
        depth--;
        if (depth === 0) {
          const body = src.slice(startBody, i);
          if (!body) return null;
          return {
            raw: src.slice(0, i + 1),
            fn: fn as MfmFunctionName,
            args: parseArgs(headerMatch[2]),
            body,
          };
        }
      }
    }
    i++;
  }

  return null;
}

export function renderMfmHtml(
  fn: MfmFunctionName,
  args: Record<string, string | true>,
  renderedBody: string,
  rawBody: string,
  renderInline: (text: string) => string,
): string {
  switch (fn) {
    case "blur":
      return `<span class="mfm-blur">${renderedBody}</span>`;

    case "x2":
      return `<span class="mfm-x2">${renderedBody}</span>`;

    case "fg": {
      const color = typeof args.color === "string" ? args.color.trim() : "";
      if (!HEX_COLOR_RE.test(color)) {
        return `<span class="mfm-fg">${renderedBody}</span>`;
      }
      return `<span class="mfm-fg" style="color:#${color.toLowerCase()}">${renderedBody}</span>`;
    }

    case "bg": {
      const color = typeof args.color === "string" ? args.color.trim() : "";
      if (!HEX_COLOR_RE.test(color)) {
        return `<span class="mfm-bg">${renderedBody}</span>`;
      }
      return `<span class="mfm-bg" style="background-color:#${color.toLowerCase()}">${renderedBody}</span>`;
    }

    case "font": {
      const family = Object.keys(args).find((k) => FONT_FAMILIES.has(k));
      if (!family) {
        return `<span class="mfm-font-serif">${renderedBody}</span>`;
      }
      return `<span class="mfm-font-${family}">${renderedBody}</span>`;
    }

    case "flip": {
      const hasH = args.h === true;
      const hasV = args.v === true;
      const cls =
        hasH && hasV ? "mfm-flip-hv" : hasV ? "mfm-flip-v" : "mfm-flip-h";
      return `<span class="${cls}">${renderedBody}</span>`;
    }

    case "rotate": {
      const deg = parseNumber(args.deg, 90, -360, 360);
      return `<span class="mfm-rotate" style="--mfm-deg:${deg}deg">${renderedBody}</span>`;
    }

    case "scale": {
      const sx = parseNumber(args.x, 1, 0.5, 2);
      const sy = parseNumber(args.y, 1, 0.5, 2);
      return `<span class="mfm-scale" style="--mfm-sx:${sx};--mfm-sy:${sy}">${renderedBody}</span>`;
    }

    case "border": {
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
      return `<span class="mfm-border" style="--mfm-border-style:${styleArg};--mfm-border-width:${width}px;--mfm-border-radius:${radius}px;--mfm-border-color:${color}">${renderedBody}</span>`;
    }

    case "ruby": {
      const spaceIdx = rawBody.search(/\s+/);
      if (spaceIdx === -1) {
        return `<ruby class="mfm-ruby">${renderedBody}</ruby>`;
      }
      const baseText = rawBody.slice(0, spaceIdx);
      const rtText = rawBody.slice(spaceIdx).trim();
      return `<ruby class="mfm-ruby">${renderInline(baseText)}<rt>${escapeHtml(rtText)}</rt></ruby>`;
    }

    default: {
      if (!ANIM_SET.has(fn)) {
        return renderedBody;
      }
      const defaultSpeed = fn === "spin" ? 1.5 : 1;
      const speed = parseSeconds(args.speed, defaultSpeed, 0.4, 10);
      const delay = parseSeconds(args.delay, 0, 0, 5);
      const classes = ["mfm-anim", `mfm-${fn}`];
      if (fn === "spin") {
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
      return `<span class="${classes.join(" ")}" style="--mfm-speed:${speed}s;--mfm-delay:${delay}s">${renderedBody}</span>`;
    }
  }
}
