import { httpUrl } from "./api.ts";
import { labelsFor } from "./labels.ts";

export function element<Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  className = "",
  text = "",
): HTMLElementTagNameMap[Tag] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function button(
  label: string,
  className = "cc-button",
): HTMLButtonElement {
  const node = element("button", className, label);
  node.type = "button";
  return node;
}

export function formatTime(
  timestamp: string | number,
  locale?: string,
): string | null {
  const date = new Date(timestamp);
  if (Number.isNaN(date.valueOf())) return null;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatCommentTime(
  timestamp: string | number,
  locale: string,
  now = Date.now(),
): string | null {
  const date = new Date(timestamp);
  if (Number.isNaN(date.valueOf())) return null;
  const seconds = (date.getTime() - now) / 1000;
  const elapsed = Math.abs(seconds);
  const day = 24 * 60 * 60;
  if (elapsed > 7 * day)
    return new Intl.DateTimeFormat(locale, { dateStyle: "short" }).format(date);
  if (elapsed < 60) return labelsFor(locale).justNow;
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (elapsed >= day) return relative.format(Math.trunc(seconds / day), "day");
  if (elapsed >= 3600)
    return relative.format(Math.trunc(seconds / 3600), "hour");
  return relative.format(Math.trunc(seconds / 60), "minute");
}

type ContentOptions = {
  locale?: string;
  images: boolean;
  imageBlocked: string;
  reveal: string;
  emoji?: (name: string) => Promise<string | null>;
  signal: AbortSignal;
};

export function renderContent(
  target: HTMLElement,
  sanitizedHtml: string,
  options: ContentOptions,
): void {
  const template = element("template");
  template.innerHTML = sanitizedHtml;
  const fragment = template.content;
  for (const image of fragment.querySelectorAll("img")) {
    const url = httpUrl(image.getAttribute("src"));
    if (options.images && url) continue;
    const caption = [options.imageBlocked, image.alt, url?.href]
      .filter(Boolean)
      .join(" · ");
    image.replaceWith(element("span", "cc-image-placeholder", caption));
  }
  for (const time of fragment.querySelectorAll<HTMLTimeElement>(
    ".mfm-unixtime[data-unixtime]",
  )) {
    const raw = time.dataset.unixtime;
    const formatted =
      raw && /^-?\d+$/.test(raw)
        ? formatTime(Number(raw) * 1000, options.locale)
        : null;
    if (formatted) time.textContent = formatted;
  }
  for (const spoiler of fragment.querySelectorAll<HTMLElement>(".mfm-blur")) {
    spoiler.classList.add("cc-spoiler");
    spoiler.dataset.revealed = "false";
    const reveal = button("", "cc-spoiler-toggle");
    const content = element("span", "cc-spoiler-content");
    content.append(...spoiler.childNodes);
    const setRevealed = (visible: boolean) => {
      spoiler.dataset.revealed = String(visible);
      content.inert = !visible;
      reveal.setAttribute("aria-expanded", String(visible));
      reveal.setAttribute(
        "aria-label",
        visible ? labelsFor(options.locale ?? "en").conceal : options.reveal,
      );
    };
    setRevealed(false);
    spoiler.append(reveal, content);
    reveal.addEventListener("click", () => setRevealed(content.inert));
  }
  target.replaceChildren(fragment);
  if (!options.images || !options.emoji) return;
  for (const placeholder of target.querySelectorAll<HTMLElement>(
    ".mfm-emoji[data-emoji]",
  )) {
    const name = placeholder.dataset.emoji;
    if (!name) continue;
    void options.emoji(name).then((url) => {
      if (!url || options.signal.aborted || !target.contains(placeholder))
        return;
      const image = element("img", "cc-emoji-image");
      image.alt = `:${name}:`;
      image.loading = "lazy";
      image.decoding = "async";
      image.referrerPolicy = "no-referrer";
      image.addEventListener(
        "error",
        () => image.replaceWith(document.createTextNode(image.alt)),
        { once: true },
      );
      image.src = url;
      placeholder.replaceChildren(image);
    });
  }
}
