import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { gfmSanitizeSchema, rehypeHardenNodes } from "./sanitize-schema.ts";

/**
 * Pure official GFM Markdown renderer backed by unified/remark-gfm/rehype-sanitize.
 * Produces an inner sanitized HTML fragment (B-side wraps it in `.cc-md`).
 */
export class GfmRenderer {
  private readonly processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkBreaks)
    .use(remarkRehype, { allowDangerousHtml: false })
    .use(rehypeSanitize, gfmSanitizeSchema)
    .use(rehypeHardenNodes)
    .use(rehypeStringify);

  render(markdown: string): string {
    return String(this.processor.processSync(markdown)).trim();
  }
}
