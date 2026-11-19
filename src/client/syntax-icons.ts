import type { CommentSyntax } from "../shared/types.ts";

declare const SIMPLE_SYNTAX_ICONS: Record<CommentSyntax, string>;

export function syntaxIcon(mode: CommentSyntax): SVGSVGElement {
  const namespace = "http://www.w3.org/2000/svg";
  const icon = document.createElementNS(namespace, "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(namespace, "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute("d", SIMPLE_SYNTAX_ICONS[mode]);
  icon.append(path);
  return icon;
}
