import { httpUrl } from "./api.ts";

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
    const reveal = button(options.reveal, "cc-spoiler");
    reveal.setAttribute("aria-expanded", "false");
    const content = element("span", "cc-spoiler-content");
    content.hidden = true;
    content.append(...spoiler.childNodes);
    spoiler.append(reveal, content);
    reveal.addEventListener("click", () => {
      content.hidden = !content.hidden;
      reveal.setAttribute("aria-expanded", String(!content.hidden));
    });
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
