import type { CommentSyntax } from "../shared/types.ts";
import { GfmRenderer } from "./gfm.ts";
import {
  ALLOWED_MFM_FUNCTIONS,
  MFM_MAX_NESTING_DEPTH,
  MfmRenderer,
  type MfmRenderOptions,
} from "./mfm.ts";
import { escapeHtml } from "./sanitize-schema.ts";

export {
  ALLOWED_MFM_FUNCTIONS,
  escapeHtml,
  GfmRenderer,
  MFM_MAX_NESTING_DEPTH,
  MfmRenderer,
  type MfmRenderOptions,
};

const gfmRenderer = new GfmRenderer();
const mfmRenderer = new MfmRenderer();

/**
 * Render comment source text using the explicitly selected syntax (`gfm` or `mfm`).
 * Always produces a sanitized inner HTML fragment without an outer `.cc-md` wrapper.
 */
export function renderCommentContent(
  source: string,
  syntax: CommentSyntax = "gfm",
  options: MfmRenderOptions = {},
): string {
  if (syntax === "mfm") {
    return mfmRenderer.render(source, options);
  }
  return gfmRenderer.render(source);
}
