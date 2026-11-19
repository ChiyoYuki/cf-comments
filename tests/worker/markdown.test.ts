import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderCommentContent } from "../../src/markdown/index.ts";

describe("Official GFM Pipeline (unified + remark-gfm + rehype-sanitize)", () => {
  it("renders GFM features without wrapping in .cc-md", () => {
    const html = renderCommentContent(
      "## 标题\n\n~~删除线~~ 与 **粗体**\n\n- [x] 完成\n- [ ] 待办\n\n| A | B |\n| - | - |\n| 1 | 2 |",
      "gfm",
    );
    assert.ok(!html.includes("cc-md"), "A-side must not add .cc-md wrapper");
    assert.ok(html.includes("<h2>标题</h2>"));
    assert.ok(html.includes("<del>删除线</del>"));
    assert.ok(html.includes("<strong>粗体</strong>"));
    assert.ok(html.includes("<table>"));
    assert.ok(html.includes('<input type="checkbox" disabled checked>'));
    assert.ok(html.includes('<input type="checkbox" disabled>'));
  });

  it("allows remote http(s) images with safe attributes and blocks unsafe URL schemes", () => {
    const html = renderCommentContent(
      "![ok](https://img.example.com/a.png) ![bad](data:image/svg+xml,<svg/>) [xss](javascript:alert(1))",
      "gfm",
    );
    assert.ok(html.includes('src="https://img.example.com/a.png"'));
    assert.ok(html.includes('loading="lazy"'));
    assert.ok(html.includes('referrerpolicy="no-referrer"'));
    assert.ok(html.includes('class="cc-img"'));
    assert.ok(!html.includes("data:image"));
    assert.ok(!html.includes("javascript:"));
  });

  it("strips raw HTML and XSS payloads via official rehype-sanitize", () => {
    const html = renderCommentContent(
      '<script>alert(1)</script><img src="https://img.example.com/x.png" onerror="alert(1)"><iframe src="https://evil.test"></iframe>',
      "gfm",
    );
    assert.ok(!html.includes("<script"));
    assert.ok(!html.includes("<iframe"));
    assert.ok(!html.includes("onerror"));
    assert.ok(!html.includes("alert(1)"));
  });

  it("does not parse MFM syntax in GFM mode", () => {
    const html = renderCommentContent("$[blur 原样保留] :blobcat:", "gfm");
    assert.ok(!html.includes("mfm-blur"));
    assert.ok(!html.includes("mfm-emoji"));
    assert.ok(html.includes("$[blur 原样保留]"));
  });
});

describe("Official MFM Pipeline (mfm-js + rehype-sanitize)", () => {
  it("renders allowlisted MFM functions, spin modifiers, position, ruby, and unixtime", () => {
    const html = renderCommentContent(
      "$[blur **黑幕**] $[fg.color=ff5588 粉色] $[spin.x,left,alternate,speed=0.1s,delay=99s 转] $[position.x=2,y=-1.5 偏移] $[ruby 漢字 かんじ] $[unixtime 1701356400]",
      "mfm",
    );
    assert.ok(
      html.includes('<span class="mfm-blur"><strong>黑幕</strong></span>'),
    );
    assert.ok(
      html.includes('<span class="mfm-fg" style="color:#ff5588">粉色</span>'),
    );
    assert.ok(
      html.includes(
        '<span class="mfm-anim mfm-spin mfm-spin-x mfm-spin-left mfm-spin-alternate" style="--mfm-speed:0.4s;--mfm-delay:5s">转</span>',
      ),
    );
    assert.ok(
      html.includes(
        '<span class="mfm-position" style="--mfm-px:2em;--mfm-py:-1.5em">偏移</span>',
      ),
    );
    assert.ok(
      html.includes('<ruby class="mfm-ruby">漢字<rt>かんじ</rt></ruby>'),
    );
    assert.ok(
      html.includes(
        '<time class="mfm-unixtime" datetime="2023-11-30T15:00:00.000Z" data-unixtime="1701356400">',
      ),
    );
  });

  it("allows x2, x3, x4 while preventing nested magnification", () => {
    const html = renderCommentContent("$[x3 三倍] $[x4 $[x4 不叠加]]", "mfm");
    assert.ok(html.includes('<span class="mfm-size mfm-x3">三倍</span>'));
    assert.ok(html.includes('<span class="mfm-size mfm-x4">不叠加</span>'));
    // Inner x4 must NOT wrap a second .mfm-size span
    assert.equal(html.match(/mfm-x4/g)?.length, 1);
  });

  it("does not render search forms or KaTeX, and keeps pure mfm-js syntax (no Markdown images)", () => {
    const html = renderCommentContent(
      "misskey Search\n\\(a^2 + b^2 = c^2\\)\n![img](https://img.example.com/a.png)\n<plain>$[blur raw]</plain>",
      "mfm",
    );
    assert.ok(!html.includes("<form"));
    assert.ok(!html.includes("<input"));
    assert.ok(html.includes("misskey Search"));
    assert.ok(
      html.includes('<code class="mfm-math-inline">a^2 + b^2 = c^2</code>'),
    );
    assert.ok(
      !html.includes("<img"),
      "Pure MFM mode must not emit <img> for ![]()",
    );
    assert.ok(!html.includes("mfm-blur"));
    assert.ok(html.includes("$[blur raw]"));
  });

  it("resolves Misskey instance context only when misskeyInstanceUrl is configured", () => {
    const src = "Hi @alice @bob@remote.example #daily :blobcat:";

    const withoutInstance = renderCommentContent(src, "mfm", {
      misskeyInstanceUrl: null,
    });
    assert.ok(!withoutInstance.includes("<a "));
    assert.ok(!withoutInstance.includes("data-emoji"));
    assert.ok(withoutInstance.includes("@alice"));
    assert.ok(withoutInstance.includes("#daily"));
    assert.ok(withoutInstance.includes(":blobcat:"));

    const withInstance = renderCommentContent(src, "mfm", {
      misskeyInstanceUrl: "https://misskey.example.com",
    });
    assert.ok(
      withInstance.includes('href="https://misskey.example.com/@alice"'),
    );
    assert.ok(
      withInstance.includes(
        'href="https://misskey.example.com/@bob@remote.example"',
      ),
    );
    assert.ok(
      withInstance.includes('href="https://misskey.example.com/tags/daily"'),
    );
    assert.ok(
      withInstance.includes(
        '<span class="mfm-emoji" data-emoji="blobcat">:blobcat:</span>',
      ),
    );
  });
});
