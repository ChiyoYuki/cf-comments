import type { PublicComment } from "../shared/types.ts";
import { element } from "./content.ts";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const gravatarUrl =
  /^https:\/\/gravatar\.com\/avatar\/[0-9a-f]{64}\?s=96&d=404&r=g$/;

export function avatarInitial(name: string): string {
  return graphemes.segment(name.trim()).containing(0)?.segment ?? "";
}

export function commentAvatarUrl(
  row: Pick<PublicComment, "avatar_url" | "is_placeholder">,
): string | null {
  return !row.is_placeholder &&
    typeof row.avatar_url === "string" &&
    gravatarUrl.test(row.avatar_url)
    ? row.avatar_url
    : null;
}

export function renderAvatar(
  name: string,
  row: PublicComment,
  signal: AbortSignal,
): HTMLElement {
  const avatar = element("span", "cc-avatar");
  avatar.setAttribute("aria-hidden", "true");
  const initial = element("span", "", avatarInitial(name));
  avatar.append(initial);
  if (typeof row.avatar_hue === "number" && Number.isFinite(row.avatar_hue))
    avatar.style.setProperty(
      "--avatar-hue",
      String(Math.max(0, Math.min(359, row.avatar_hue))),
    );

  const url = commentAvatarUrl(row);
  if (!url) return avatar;
  const image = element("img", "cc-avatar-image");
  image.alt = "";
  image.loading = "lazy";
  image.decoding = "async";
  image.referrerPolicy = "no-referrer";
  image.addEventListener(
    "load",
    () => {
      initial.hidden = true;
      image.classList.add("cc-avatar-loaded");
    },
    { once: true, signal },
  );
  image.addEventListener("error", () => image.remove(), { once: true, signal });
  image.src = url;
  avatar.append(image);
  return avatar;
}
