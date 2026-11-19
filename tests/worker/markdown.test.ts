import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderMarkdown } from "../../src/markdown/index.ts";
import { sanitizeHtml } from "../../src/markdown/sanitize.ts";

describe("GFM + MFM Markdown Renderer & Sanitizer", () => {
  it("renders GFM features without wrapping in .cc-md", () => {
    const html = renderMarkdown(
      "## 标题\n\n~~删除线~~ 与 **粗体**\n\n- [x] 完成\n- [ ] 待办",
    );
    assert.ok(!html.includes("cc-md"), "A-side must not add .cc-md wrapper");
    assert.ok(html.includes("<h2>标题</h2>"));
    assert.ok(html.includes("<del>删除线</del>"));
    assert.ok(html.includes("<strong>粗体</strong>"));
    assert.ok(html.includes('<input type="checkbox" disabled checked>'));
    assert.ok(html.includes('<input type="checkbox" disabled>'));
  });

  it("allows remote http(s) images with safe attributes and blocks data/javascript schemes", () => {
    const html = renderMarkdown(
      "![ok](https://img.example.com/a.png) ![bad](data:image/svg+xml,<svg/>) [xss](javascript:alert(1))",
    );
    assert.ok(
      html.includes(
        '<img src="https://img.example.com/a.png" alt="ok" loading="lazy" decoding="async" referrerpolicy="no-referrer" class="cc-img">',
      ),
    );
    assert.ok(!html.includes("data:image"));
    assert.ok(!html.includes("javascript:"));
  });

  it("escapes raw HTML in Markdown and strips dangerous tags/attributes in sanitizer", () => {
    const html = renderMarkdown(
      '<script>alert(1)</script><img src=x onerror=alert(1)><iframe src="https://evil.test"></iframe>',
    );
    assert.ok(!html.includes("<script"));
    assert.ok(!html.includes("<img"));
    assert.ok(!html.includes("<iframe"));
    assert.ok(html.includes("&lt;script&gt;"));

    const sanitized = sanitizeHtml(
      '<script>alert(1)</script><img src="https://img.example.com/a.png" onerror="alert(1)" style="width:9999px"><a href="javascript:alert(1)">click</a>',
    );
    assert.ok(!sanitized.includes("<script"));
    assert.ok(!sanitized.includes("alert(1)"));
    assert.ok(!sanitized.includes("onerror"));
    assert.ok(!sanitized.includes("javascript:"));
    assert.ok(sanitized.includes('src="https://img.example.com/a.png"'));
  });

  it("renders allowlisted MFM functions with clamped parameters and spin modifiers", () => {
    const html = renderMarkdown(
      "$[blur **黑幕**] $[fg.color=ff5588 粉色] $[spin.x,left,alternate,speed=0.1s,delay=99s 转] $[scale.x=9,y=0.1 缩放] $[ruby 漢字 かんじ]",
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
        '<span class="mfm-scale" style="--mfm-sx:2;--mfm-sy:0.5">缩放</span>',
      ),
    );
    assert.ok(
      html.includes('<ruby class="mfm-ruby">漢字<rt>かんじ</rt></ruby>'),
    );
  });

  it("supports <small> and <center> MFM wrappers safely", () => {
    const html = renderMarkdown("<small>小字</small> <center>居中</center>");
    assert.ok(html.includes('<small class="mfm-small">小字</small>'));
    assert.ok(html.includes('<div class="mfm-center">居中</div>'));
  });

  it("leaves unknown or instance-dependent MFM syntax and code spans untouched", () => {
    const html = renderMarkdown(
      "代码 `$[blur raw]` 与 $[position.x=5 越界] 与 $[x4 超大] 与 $[unknown 未知]",
    );
    assert.ok(html.includes("<code>$[blur raw]</code>"));
    assert.ok(html.includes("$[position.x=5 越界]"));
    assert.ok(html.includes("$[x4 超大]"));
    assert.ok(html.includes("$[unknown 未知]"));
  });

  it("enforces MFM maximum nesting depth of 4", () => {
    const nested = "$[blur $[flip $[x2 $[fg.color=f00 $[shake deep]]]]]";
    const html = renderMarkdown(nested);
    assert.ok(html.includes("mfm-blur"));
    assert.ok(html.includes("mfm-fg"));
    assert.ok(
      !html.includes("mfm-shake"),
      "5th nested MFM level must remain literal text",
    );
    assert.ok(html.includes("$[shake deep]"));
  });
});
