import type {
  CommentThread,
  CommentThreadPage,
  CreateCommentRequest,
  CreateCommentResponse,
  PublicComment,
  PublicConfig,
  ReplyPage,
} from "../shared/types.ts";
import { type Api, ApiError, createApi, errorMessage, httpUrl } from "./api.ts";
import { renderAvatar } from "./avatar.ts";
import {
  button,
  element,
  formatCommentTime,
  formatTime,
  renderContent,
} from "./content.ts";
import { field, syntaxPicker, syntaxValue, textInput } from "./editor.ts";
import { createEmojiResolver } from "./emoji.ts";
import { labelsFor } from "./labels.ts";
import { arrangeReplies, hasMoreReplies, mergeById } from "./threads.ts";
import { loadTurnstile } from "./turnstile.ts";

const tagName = "cf-comments";
const syntaxDocs = {
  gfm: "https://github.github.com/gfm/",
  mfm: "https://misskey-hub.net/en/docs/for-users/features/mfm/",
};

let previewModule: Promise<typeof import("./preview.ts")> | undefined;

function loadPreview(): Promise<typeof import("./preview.ts")> {
  previewModule ??= import(new URL("./preview.js", import.meta.url).href);
  return previewModule;
}

class Widget {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  readonly locale: string;
  readonly text: ReturnType<typeof labelsFor>;
  readonly panel = element("section", "cc-widget");
  readonly list = element("ol", "cc-threads");
  readonly status = element("p", "cc-status");
  readonly count = element("span", "cc-comment-count");
  readonly next = button("");
  readonly form = element("form", "cc-form cc-surface");
  readonly input = element("textarea");
  readonly target = element("p", "cc-reply-target");
  readonly cancel = button("");
  readonly notice = element("p", "cc-status");
  readonly threads = new Map<
    string,
    {
      thread: CommentThread;
      loaded: boolean;
      appendReply: (row: PublicComment) => void;
    }
  >();
  readonly initialReplies: number;
  emoji?: ReturnType<typeof createEmojiResolver>;
  config?: PublicConfig;
  parent: PublicComment | null = null;
  captchaToken: string | null = null;
  resetCaptcha?: () => void;
  cursor: string | null = null;
  total = 0;

  constructor(
    readonly host: HTMLElement,
    readonly api: Api,
    readonly path: string,
    readonly shadow: ShadowRoot,
  ) {
    this.locale =
      host.closest("[lang]")?.getAttribute("lang") ||
      document.documentElement.lang ||
      navigator.language;
    this.text = labelsFor(this.locale);
    const configuredLimit = host.getAttribute("reply-limit");
    this.initialReplies =
      configuredLimit && /^(?:[0-9]|1[0-9]|20)$/.test(configuredLimit)
        ? Number(configuredLimit)
        : 5;
    this.panel.setAttribute("aria-label", this.text.title);
    this.status.setAttribute("role", "status");
    this.notice.setAttribute("role", "status");
    this.notice.setAttribute("aria-atomic", "true");
    this.count.hidden = true;
    this.next.hidden = true;
    this.next.textContent = this.text.more;
    this.next.addEventListener("click", () => void this.load(this.cursor));
    this.cancel.textContent = this.text.cancel;
    this.cancel.addEventListener("click", () => {
      this.setParent(null);
      this.input.focus();
    });
    const header = element("header", "cc-heading");
    header.append(element("h2", "", this.text.title), this.count);
    this.panel.append(header, this.form, this.status, this.list, this.next);
    this.form.hidden = true;
    const style = element("link");
    style.rel = "stylesheet";
    style.href = new URL("./comments.css", import.meta.url).href;
    shadow.replaceChildren(style, this.panel);
  }

  async load(cursor: string | null = null, focus = false): Promise<void> {
    if (this.next.disabled) return;
    this.next.disabled = true;
    this.status.textContent = this.text.loading;
    try {
      const [config, page] = await Promise.all([
        this.config ??
          this.api.json<PublicConfig>("/v1/config", { signal: this.signal }),
        this.api.json<CommentThreadPage>("/v1/comments", {
          signal: this.signal,
          query: { path: this.path, cursor, reply_limit: this.initialReplies },
        }),
      ]);
      if (this.signal.aborted) return;
      if (!this.config) {
        this.config = config;
        this.emoji = createEmojiResolver(
          config.misskey_instance_url,
          this.signal,
        );
        this.buildComposer(config);
      }
      if (!cursor) {
        this.threads.clear();
        this.list.replaceChildren();
      }
      this.cursor = page.next_cursor;
      this.total = page.total_approved;
      this.updateCount();
      const first = page.items
        .filter((thread) => !this.threads.has(thread.id))
        .map((thread) => this.addThread(thread));
      if (focus || cursor) first[0]?.focus();
      this.status.textContent = this.threads.size ? "" : this.text.empty;
      this.next.hidden = this.cursor === null;
    } catch (error) {
      if (this.signal.aborted) return;
      this.status.textContent = errorMessage(error, this.text.error);
      const retry = button(this.text.retry);
      retry.addEventListener("click", () => void this.load(cursor, true), {
        once: true,
      });
      this.status.append(" ", retry);
    } finally {
      this.next.disabled = false;
    }
  }

  updateCount(): void {
    this.count.hidden = false;
    this.count.textContent = `${this.total} ${this.text.count}`;
  }

  showContent(target: HTMLElement, html: string, signal = this.signal): void {
    renderContent(target, html, {
      signal,
      locale: this.locale,
      images: true,
      emoji: this.emoji,
      imageBlocked: this.text.blocked,
      reveal: this.text.reveal,
    });
  }

  addThread(thread: CommentThread, prepend = false): HTMLLIElement {
    const item = element("li", "cc-thread");
    item.tabIndex = -1;
    const replies = element("ol", "cc-replies");
    const more = button(this.text.moreReplies);
    const replyCount = element("span", "cc-muted");
    const tools = element("div", "cc-row cc-reply-tools");
    const replyStatus = element("p", "cc-status");
    replyStatus.setAttribute("role", "status");
    tools.append(replyCount, more);
    item.append(this.comment(thread), replies, tools, replyStatus);
    if (prepend) this.list.prepend(item);
    else this.list.append(item);
    const state = {
      thread,
      loaded: this.initialReplies !== 0,
      appendReply: (row: PublicComment) => {
        if (!thread.replies.some((reply) => reply.id === row.id)) {
          thread.reply_count++;
          thread.replies = mergeById(thread.replies, [row]);
          repaint();
        }
      },
    };
    this.threads.set(thread.id, state);
    const repaint = () => {
      const existing = new Map(
        Array.from(replies.children, (node) => [
          (node as HTMLElement).dataset.id,
          node as HTMLElement,
        ]),
      );
      const ordered = arrangeReplies(thread.id, thread.replies).map(
        ({ row, depth }) => {
          const child = existing.get(row.id) ?? element("li");
          if (!child.hasChildNodes()) child.append(this.comment(row));
          child.dataset.id = row.id;
          child.dataset.depth = String(depth);
          return child;
        },
      );
      replies.replaceChildren(...ordered);
      replyCount.textContent = `${thread.reply_count} ${this.text.replies}`;
      tools.hidden = !hasMoreReplies(
        thread.replies_next_cursor,
        state.loaded,
        thread.reply_count,
      );
    };
    repaint();
    more.addEventListener("click", async () => {
      more.disabled = true;
      replyStatus.textContent = this.text.loading;
      try {
        const page = await this.api.json<ReplyPage>(
          `/v1/comments/${encodeURIComponent(thread.id)}/replies`,
          {
            signal: this.signal,
            query: { cursor: thread.replies_next_cursor },
          },
        );
        if (this.signal.aborted || !item.isConnected) return;
        thread.replies = mergeById(thread.replies, page.items);
        thread.replies_next_cursor = page.next_cursor;
        state.loaded = true;
        repaint();
        replyStatus.textContent = "";
        if (more.hidden) item.focus();
      } catch (error) {
        if (!this.signal.aborted)
          replyStatus.textContent = errorMessage(error, this.text.error);
      } finally {
        more.disabled = false;
      }
    });
    return item;
  }

  comment(row: PublicComment): HTMLElement {
    const card = element("article", "cc-comment");
    if (row.is_placeholder) {
      card.classList.add("cc-placeholder");
      card.append(
        element(
          "p",
          "",
          row.placeholder_reason === "deleted"
            ? this.text.deleted
            : this.text.hidden,
        ),
      );
      return card;
    }
    const name = row.author_name || this.text.anonymous;
    const avatar = renderAvatar(name, row, this.signal);
    const author = element("div", "cc-author");
    const website = httpUrl(row.author_url);
    if (website) {
      const link = element("a", "cc-name", name);
      link.href = website.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer ugc nofollow";
      link.title = name;
      author.append(link);
    } else {
      const label = element("strong", "cc-name", name);
      label.title = name;
      author.append(label);
    }
    if (row.is_admin)
      author.append(element("span", "cc-badge", this.text.owner));
    if (row.reply_to_author) {
      const context = element("span", "cc-reply-context");
      const arrow = element("span", "", "▸");
      arrow.setAttribute("aria-hidden", "true");
      const recipient = element("span", "cc-recipient", row.reply_to_author);
      recipient.title = row.reply_to_author;
      context.append(
        arrow,
        element("span", "cc-sr-only", `${this.text.replyTo} `),
        recipient,
      );
      author.append(context);
    }
    const date = element(
      "time",
      "cc-comment-time",
      formatCommentTime(row.created_at, this.locale) ?? "",
    );
    date.dateTime = row.created_at;
    date.title = formatTime(row.created_at, this.locale) ?? "";
    author.append(date);
    const header = element("header", "cc-byline");
    const reply = button(this.text.reply, "cc-button cc-reply-action");
    reply.setAttribute("aria-label", `${this.text.replyTo} ${name}`);
    reply.addEventListener("click", () => {
      this.setParent(row);
      this.input.focus();
    });
    header.append(avatar, author, reply);
    card.append(header);
    const content = element("div", "cc-md cc-comment-content");
    this.showContent(content, row.content_html ?? "");
    card.append(content);
    return card;
  }

  setParent(row: PublicComment | null): void {
    this.parent = row;
    this.target.hidden = !row;
    this.target.replaceChildren();
    if (row)
      this.target.append(
        element(
          "span",
          "cc-reply-target-label",
          `${this.text.replyTo} ${row.author_name || this.text.anonymous}`,
        ),
        this.cancel,
      );
  }

  addCaptcha(sitekey: string): void {
    const region = element("div", "cc-captcha");
    const slot = element("slot");
    slot.name = "cf-comments-verification";
    const mount = element("div");
    mount.slot = slot.name;
    this.host.append(mount);
    this.signal.addEventListener("abort", () => mount.remove(), { once: true });
    const retry = button(this.text.retry);
    retry.hidden = true;
    const feedback = element("span", "cc-muted");
    region.append(slot, feedback, retry);
    this.form.append(region);
    const start = async () => {
      retry.hidden = true;
      feedback.textContent = "";
      try {
        const turnstile = await loadTurnstile();
        if (this.signal.aborted) return;
        const widget = turnstile.render(mount, {
          sitekey,
          size: "flexible",
          "response-field": false,
          callback: (token) => {
            this.captchaToken = token;
            feedback.textContent = "";
            retry.hidden = true;
          },
          "expired-callback": () => {
            this.captchaToken = null;
          },
          "error-callback": () => {
            this.captchaToken = null;
            feedback.textContent = this.text.verifyError;
            retry.hidden = false;
          },
        });
        this.resetCaptcha = () => {
          this.captchaToken = null;
          turnstile.reset(widget);
        };
        this.signal.addEventListener("abort", () => turnstile.remove(widget), {
          once: true,
        });
      } catch {
        if (this.signal.aborted) return;
        feedback.textContent = this.text.verifyError;
        retry.hidden = false;
      }
    };
    retry.addEventListener("click", () => {
      if (this.resetCaptcha) this.resetCaptcha();
      else void start();
    });
    void start();
  }

  buildComposer(config: PublicConfig): void {
    this.input.name = "content";
    this.input.required = true;
    this.input.maxLength = config.max_content_length;
    this.input.rows = 3;
    const fields = element("div", "cc-fields");
    const name = textInput("author_name", "text", 80);
    name.setAttribute("autocomplete", "nickname");
    const mail = textInput("author_email", "email", 254);
    mail.autocomplete = "email";
    const site = textInput("author_url", "url", 512);
    site.setAttribute("autocomplete", "url");
    fields.append(
      field(this.text.name, name),
      field(this.text.email, mail),
      field(this.text.website, site),
    );
    const trap = textInput("honeypot", "text", 200);
    trap.autocomplete = "off";
    trap.tabIndex = -1;
    const honeypot = field("Leave this field empty", trap);
    honeypot.hidden = true;
    const consent = element("label", "cc-check");
    const notify = element("input");
    notify.type = "checkbox";
    notify.name = "notify_on_reply";
    consent.append(notify, this.text.optIn);
    consent.hidden = !config.reply_notify_enabled;
    notify.disabled = !config.reply_notify_enabled;
    const options = element("details", "cc-options");
    options.open = true;
    const summary = element("summary");
    const nickname = element("span", "cc-options-name");
    nickname.hidden = true;
    summary.append(
      element(
        "span",
        "",
        config.reply_notify_enabled
          ? this.text.notifyOptions
          : this.text.options,
      ),
      nickname,
    );
    const updateNickname = () => {
      const value = name.value.trim();
      nickname.hidden = !value;
      nickname.textContent = value;
    };
    name.addEventListener("input", updateNickname);
    options.addEventListener("toggle", updateNickname);
    const optionFields = element("div", "cc-option-fields");
    optionFields.append(fields, consent);
    options.append(summary, optionFields);
    options.addEventListener(
      "invalid",
      () => {
        options.open = true;
      },
      true,
    );
    const syntax = syntaxPicker(
      this.text.syntax,
      config.markdown.default_syntax,
      config.markdown.syntax_modes,
    );
    const toolbar = element("div", "cc-row cc-toolbar");
    const preview = button(this.text.preview, "cc-button cc-preview-toggle");
    preview.setAttribute("aria-pressed", "false");
    preview.setAttribute("aria-controls", "cc-live-preview");
    const post = button(this.text.post, "cc-button cc-filled");
    post.type = "submit";
    const remaining = element("span", "cc-remaining");
    const numbers = new Intl.NumberFormat(this.locale);
    const updateRemaining = () => {
      const length = this.input.value.length;
      const count = config.max_content_length - length;
      remaining.textContent = length
        ? this.text.remaining.replace("{count}", numbers.format(count))
        : "";
      remaining.dataset.level =
        count <= 50 ? "error" : count <= 300 ? "warning" : "normal";
    };
    const help = element("a", "cc-syntax-help");
    help.target = "_blank";
    help.rel = "noopener noreferrer";
    const tools = element("div", "cc-row cc-format-tools");
    tools.append(syntax, help);
    const actions = element("div", "cc-row cc-composer-actions");
    actions.append(preview, remaining, post);
    toolbar.append(tools, actions);
    const previewBox = element("div", "cc-md cc-preview");
    previewBox.id = "cc-live-preview";
    previewBox.hidden = true;
    previewBox.setAttribute("role", "region");
    previewBox.setAttribute("aria-label", this.text.preview);
    let previewTimer: ReturnType<typeof setTimeout> | undefined;
    let previewRender: AbortController | undefined;
    const cancelPreview = () => {
      clearTimeout(previewTimer);
      previewRender?.abort();
      previewRender = undefined;
    };
    this.signal.addEventListener("abort", cancelPreview, { once: true });
    const renderPreview = async (signal: AbortSignal) => {
      try {
        const { renderCommentContent } = await loadPreview();
        if (signal.aborted) return;
        const value = this.input.value;
        if (!value.trim()) {
          previewBox.textContent = this.text.previewEmpty;
          return;
        }
        const html = renderCommentContent(
          value,
          syntaxValue(new FormData(this.form)),
          { misskeyInstanceUrl: config.misskey_instance_url },
        );
        this.showContent(previewBox, html, signal);
      } catch {
        if (!signal.aborted) previewBox.textContent = this.text.previewError;
      }
    };
    const schedulePreview = (delay = 100) => {
      cancelPreview();
      if (previewBox.hidden) return;
      previewRender = new AbortController();
      const { signal } = previewRender;
      if (delay === 0) void renderPreview(signal);
      else previewTimer = setTimeout(() => void renderPreview(signal), delay);
    };
    preview.addEventListener("click", () => {
      const open = previewBox.hidden;
      previewBox.hidden = !open;
      preview.setAttribute("aria-pressed", String(open));
      previewBox.textContent = open ? this.text.previewLoading : "";
      schedulePreview(0);
    });
    this.input.addEventListener("input", () => {
      updateRemaining();
      schedulePreview();
    });
    const updateSyntaxHelp = () => {
      const mode = syntaxValue(new FormData(this.form));
      help.href =
        mode === "mfm" && /^zh(?:-|$)/i.test(this.locale)
          ? "https://misskey-hub.net/cn/docs/for-users/features/mfm/"
          : syntaxDocs[mode];
      help.textContent = this.text[mode];
    };
    syntax.addEventListener("change", () => {
      schedulePreview();
      updateSyntaxHelp();
    });
    this.form.append(
      this.target,
      field(this.text.write, this.input),
      options,
      honeypot,
    );
    if (config.turnstile_site_key) this.addCaptcha(config.turnstile_site_key);
    this.form.append(toolbar, previewBox, this.notice);
    this.setParent(null);
    updateSyntaxHelp();
    updateRemaining();
    this.form.hidden = false;
    this.form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (post.disabled) return;
      if (!this.input.value.trim()) {
        this.notice.textContent = this.text.write;
        this.input.focus();
        return;
      }
      if (notify.checked && !mail.value.trim()) {
        this.notice.textContent = this.text.emailNeeded;
        options.open = true;
        mail.focus();
        return;
      }
      if (config.turnstile_site_key && !this.captchaToken) {
        this.notice.textContent = this.text.verify;
        return;
      }
      const body: CreateCommentRequest = {
        path: this.path,
        parent_id: this.parent?.id ?? null,
        content: this.input.value,
        syntax: syntaxValue(new FormData(this.form)),
        author_name: name.value.trim() || null,
        author_email: mail.value.trim() || null,
        author_url: site.value.trim() || null,
        notify_on_reply: config.reply_notify_enabled && notify.checked,
        honeypot: trap.value,
        turnstile_token: this.captchaToken,
      };
      post.disabled = true;
      this.input.readOnly = true;
      this.notice.textContent = this.text.posting;
      try {
        const result = await this.api.json<CreateCommentResponse>(
          "/v1/comments",
          { method: "POST", signal: this.signal, body },
        );
        if (this.signal.aborted) return;
        this.input.value = "";
        updateRemaining();
        this.setParent(null);
        schedulePreview(0);
        this.notice.textContent = [
          result.status === "pending" ? this.text.pending : this.text.posted,
          result.verification_queued ? this.text.queued : "",
        ]
          .filter(Boolean)
          .join(" ");
        if (result.comment) {
          if (result.root_id)
            this.threads.get(result.root_id)?.appendReply(result.comment);
          else if (!this.threads.has(result.id))
            this.addThread(
              {
                ...result.comment,
                replies: [],
                reply_count: 0,
                replies_next_cursor: null,
              },
              true,
            );
          this.total++;
          this.updateCount();
          this.status.textContent = "";
        }
      } catch (error) {
        if (!this.signal.aborted)
          this.notice.textContent =
            error instanceof ApiError && error.code === "PARENT_NOT_FOUND"
              ? this.text.staleParent
              : errorMessage(error, this.text.postError);
      } finally {
        if (!this.signal.aborted) this.resetCaptcha?.();
        this.input.readOnly = false;
        post.disabled = false;
      }
    });
  }
}

class CommentsElement extends HTMLElement {
  static observedAttributes = ["api-base", "path", "reply-limit"];
  private widget?: Widget;

  connectedCallback(): void {
    const shadow = this.shadowRoot ?? this.attachShadow({ mode: "open" });
    const base = httpUrl(
      this.getAttribute("api-base") || new URL(import.meta.url).origin,
    );
    const path = this.getAttribute("path") || location.pathname;
    if (!base || !path.startsWith("/")) {
      shadow.textContent = "Comments: invalid API base or page path.";
      return;
    }
    this.widget = new Widget(this, createApi(base), path, shadow);
    void this.widget.load();
  }

  disconnectedCallback(): void {
    this.widget?.controller.abort();
    this.widget = undefined;
    this.shadowRoot?.replaceChildren();
  }

  attributeChangedCallback(
    _name: string,
    previous: string | null,
    next: string | null,
  ): void {
    if (previous !== next && this.isConnected && this.shadowRoot) {
      this.disconnectedCallback();
      this.connectedCallback();
    }
  }
}

if (!customElements.get(tagName))
  customElements.define(tagName, CommentsElement);
