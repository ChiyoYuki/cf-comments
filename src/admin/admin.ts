import { ApiError, createApi, errorMessage } from "../client/api.ts";
import {
  button,
  element,
  formatTime,
  renderContent,
} from "../client/content.ts";
import { field, syntaxPicker, syntaxValue } from "../client/editor.ts";
import { createEmojiResolver } from "../client/emoji.ts";
import type {
  AdminComment,
  AdminCommentCounts,
  AdminCommentPage,
  AdminCreateCommentRequest,
  CommentStatus,
  ImportReport,
  PublicConfig,
} from "../shared/types.ts";

function select<NodeType extends HTMLElement>(id: string): NodeType {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing admin control: ${id}`);
  return node as NodeType;
}

const api = createApi(new URL(location.origin));
const login = select("login");
const loginForm = select<HTMLFormElement>("login-form");
const tokenInput = select<HTMLInputElement>("token");
const panel = select("console");
const notice = select("notice");
const listStatus = select("list-status");
const list = select("comments");
const filterForm = select<HTMLFormElement>("filters");
const next = select<HTMLButtonElement>("next");
const media = select<HTMLInputElement>("media");
const privateExport = select<HTMLInputElement>("private");
const importForm = select<HTMLFormElement>("import-form");
const applyImport = select<HTMLButtonElement>("apply");
const reportView = select("report");
const dataStatus = select("data-status");
const path = "/v1/admin/comments";
const statuses: Record<CommentStatus, string> = {
  pending: "待审核",
  approved: "已通过",
  hidden: "已隐藏",
  spam: "垃圾评论",
  deleted: "已删除",
};

type Session = {
  token: string;
  controller: AbortController;
  listRequest?: AbortController;
  mediaRequest?: AbortController;
  emoji?: ReturnType<typeof createEmojiResolver>;
  config?: Promise<PublicConfig>;
  rows: Map<string, AdminComment>;
  filters: Record<string, string | null>;
  cursor: string | null;
  dryRun?: { payload: unknown };
  importBusy: boolean;
};
let session: Session | undefined;

function lock(message = "", focus = true): void {
  if (session) {
    session.token = "";
    session.controller.abort();
  }
  session = undefined;
  panel.hidden = true;
  login.hidden = false;
  list.replaceChildren();
  listStatus.textContent = "";
  select("counts").textContent = "";
  importForm.reset();
  clearReport();
  privateExport.checked = false;
  dataStatus.textContent = "";
  media.checked = false;
  loginForm.reset();
  notice.textContent = message;
  if (focus) tokenInput.focus();
}

function handleError(
  sessionForRequest: Session,
  error: unknown,
  output: HTMLElement = notice,
): void {
  if (session !== sessionForRequest) return;
  if (error instanceof ApiError && [401, 403].includes(error.status)) {
    lock("管理令牌无效或访问被拒绝，请重新解锁。");
  } else {
    output.textContent = errorMessage(error, "请求失败，请重试。");
  }
}

function readFilters(): Record<string, string | null> {
  const inputs = new FormData(filterForm);
  return Object.fromEntries(
    ["status", "q", "path"].map((name) => [
      name,
      String(inputs.get(name) ?? "").trim() || null,
    ]),
  );
}

function applyPage(
  current: Session,
  page: AdminCommentPage,
  append: boolean,
): void {
  if (!append) current.rows.clear();
  for (const row of page.items) current.rows.set(row.id, row);
  current.cursor = page.next_cursor;
  select("counts").textContent = (
    Object.keys(statuses) as (keyof AdminCommentCounts)[]
  )
    .map((status) => `${statuses[status]} ${page.counts[status]}`)
    .join(" · ");
  renderList(current);
  listStatus.textContent = current.rows.size ? "" : "没有符合条件的评论。";
  next.hidden = current.cursor === null;
}

async function refresh(current: Session, append = false): Promise<void> {
  current.listRequest?.abort();
  const operation = new AbortController();
  current.listRequest = operation;
  const signal = AbortSignal.any([operation.signal, current.controller.signal]);
  listStatus.textContent = "正在加载评论…";
  next.disabled = true;
  try {
    const page = await api.json<AdminCommentPage>(path, {
      token: current.token,
      signal,
      query: { ...current.filters, cursor: append ? current.cursor : null },
    });
    if (!signal.aborted) {
      applyPage(current, page, append);
      if (append && next.hidden)
        list.querySelector<HTMLElement>("li:last-child")?.focus();
    }
  } catch (error) {
    if (!signal.aborted) handleError(current, error, listStatus);
  } finally {
    if (current.listRequest === operation) next.disabled = false;
  }
}

function renderList(current: Session): void {
  list.replaceChildren(
    ...Array.from(current.rows.values(), (row) => buildCard(current, row)),
  );
}

function buildCard(current: Session, row: AdminComment): HTMLLIElement {
  const card = element("li", "cc-surface admin-section");
  card.tabIndex = -1;
  const header = element("div", "cc-row");
  header.append(
    element("h3", "admin-meta", row.author_name || "匿名"),
    element("span", "cc-badge", statuses[row.status]),
  );
  if (row.is_admin) header.append(element("span", "cc-badge", "站长"));
  const time = element(
    "time",
    "cc-muted",
    formatTime(row.created_at, "zh-CN") ?? "",
  );
  time.dateTime = row.created_at;
  card.append(
    header,
    time,
    element(
      "p",
      "cc-muted admin-meta",
      [row.path, row.syntax.toUpperCase(), row.author_email, row.author_url]
        .filter(Boolean)
        .join(" · "),
    ),
  );
  if (row.parent_id)
    card.append(
      element("p", "cc-muted admin-meta", `回复对象：${row.parent_id}`),
    );
  if (row.content_html) {
    const body = element("div", "cc-md");
    const mediaSignal = current.mediaRequest?.signal;
    const signal = mediaSignal
      ? AbortSignal.any([current.controller.signal, mediaSignal])
      : current.controller.signal;
    renderContent(body, row.content_html, {
      signal,
      locale: "zh-CN",
      images: media.checked,
      emoji: current.emoji,
      imageBlocked: "未加载外链图片",
      reveal: "显示隐藏文字",
    });
    card.append(body);
  }
  const controls = element("div", "cc-row");
  const actionStatus = element("p", "cc-status");
  actionStatus.setAttribute("role", "status");
  const setStatus = (
    label: string,
    status: CommentStatus,
    hardDelete = false,
  ) => {
    const action = button(
      label,
      status === "deleted" ? "cc-button cc-danger" : "cc-button cc-outlined",
    );
    action.addEventListener("click", async () => {
      if (
        status === "deleted" &&
        !window.confirm(
          hardDelete
            ? "永久删除这条记录？只有没有回复的记录才能硬删除。"
            : "删除后会清空正文和作者信息，不能恢复。继续吗？",
        )
      )
        return;
      const actions = controls.querySelectorAll("button");
      for (const control of actions) control.disabled = true;
      actionStatus.textContent = "正在更新…";
      try {
        const options = {
          method: "PATCH" as const,
          token: current.token,
          signal: current.controller.signal,
          body: { status, hard_delete: hardDelete },
        };
        const endpoint = `${path}/${encodeURIComponent(row.id)}`;
        if (hardDelete) await api.empty(endpoint, options);
        else await api.json<{ comment: AdminComment }>(endpoint, options);
        if (current.controller.signal.aborted) return;
        notice.textContent = hardDelete
          ? "记录已永久删除。"
          : `评论已更新：${statuses[status]}。`;
        await refresh(current);
        notice.tabIndex = -1;
        if (session === current) notice.focus();
      } catch (error) {
        if (session !== current) return;
        if (error instanceof ApiError && error.status === 409) {
          actionStatus.textContent =
            error.code === "HAS_CHILD_COMMENTS"
              ? "仍有子回复，无法永久删除；可以保留已删除占位。"
              : "这条评论的状态已更改，请重新筛选后再操作。";
        } else handleError(current, error, actionStatus);
      } finally {
        for (const control of actions) control.disabled = false;
      }
    });
    controls.append(action);
  };
  if (row.status === "deleted") {
    setStatus("永久删除", "deleted", true);
  } else {
    if (row.status !== "approved") setStatus("通过", "approved");
    if (row.status !== "hidden") setStatus("隐藏", "hidden");
    if (row.status !== "spam") setStatus("标记垃圾", "spam");
    setStatus("删除", "deleted");
    if (row.status === "approved") {
      const open = button("站长回复", "cc-button cc-outlined");
      open.setAttribute("aria-expanded", "false");
      const form = replyForm(current, row);
      form.hidden = true;
      open.addEventListener("click", () => {
        form.hidden = !form.hidden;
        open.setAttribute("aria-expanded", String(!form.hidden));
        if (!form.hidden) form.querySelector("textarea")?.focus();
      });
      controls.append(open);
      card.append(controls, actionStatus, form);
      return card;
    }
  }
  card.append(controls, actionStatus);
  return card;
}

function replyForm(current: Session, row: AdminComment): HTMLFormElement {
  const form = element("form", "admin-section admin-reply");
  const input = element("textarea");
  input.name = "content";
  input.required = true;
  input.maxLength = 10000;
  input.rows = 3;
  const send = button("发送站长回复", "cc-button cc-filled");
  send.type = "submit";
  const result = element("p", "cc-status");
  result.setAttribute("role", "status");
  form.append(field("回复正文", input), syntaxPicker("回复语法"), send, result);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (send.disabled || !input.value.trim()) return;
    const body: AdminCreateCommentRequest = {
      path: row.path,
      parent_id: row.id,
      content: input.value,
      syntax: syntaxValue(new FormData(form)),
    };
    send.disabled = true;
    input.readOnly = true;
    result.textContent = "正在发送…";
    try {
      await api.json<{ comment: AdminComment }>(path, {
        method: "POST",
        token: current.token,
        signal: current.controller.signal,
        body,
      });
      if (session !== current) return;
      form.reset();
      notice.textContent = "站长回复已发布。";
      await refresh(current);
      notice.tabIndex = -1;
      if (session === current) notice.focus();
    } catch (error) {
      handleError(current, error, result);
    } finally {
      send.disabled = false;
      input.readOnly = false;
    }
  });
  return form;
}

function clearReport(): void {
  if (session) session.dryRun = undefined;
  reportView.replaceChildren();
  reportView.hidden = true;
  applyImport.disabled = true;
}

function showReport(response: ImportReport): void {
  reportView.textContent = [
    response.dry_run ? "试跑结果" : "导入结果",
    `总数：${response.total} · ${response.dry_run ? "拟导入" : "已导入"}：${response.inserted} · 已存在：${response.skipped_existing}`,
    ...response.warnings.map((warning) => `警告：${warning}`),
    ...response.errors.map((error) => `错误：${error}`),
  ].join("\n");
  reportView.hidden = false;
}

async function runImport(current: Session, dryRun: boolean): Promise<void> {
  if (current.importBusy) return;
  const resolved = current.dryRun;
  if (!dryRun && !resolved) return;
  clearReport();
  current.importBusy = true;
  dataStatus.textContent = dryRun ? "正在试跑…" : "正在导入…";
  const input = importForm.querySelector<HTMLInputElement>("input[type=file]");
  const submit = importForm.querySelector<HTMLButtonElement>(
    "button[type=submit]",
  );
  if (input) input.disabled = true;
  if (submit) submit.disabled = true;
  try {
    let payload = resolved?.payload;
    if (dryRun) {
      const file = input?.files?.item(0);
      if (!file || file.size > 5 * 1024 * 1024) {
        dataStatus.textContent = "请选择不超过 5 MiB 的标准 JSON 文件。";
        return;
      }
      try {
        payload = JSON.parse(await file.text());
      } catch {
        if (session === current)
          dataStatus.textContent = "文件不是有效的 JSON。";
        return;
      }
    }
    if (session !== current) return;
    const response = await api.json<ImportReport>("/v1/admin/import", {
      method: "POST",
      body: payload,
      query: { dry_run: dryRun },
      token: current.token,
      signal: current.controller.signal,
    });
    if (session !== current) return;
    showReport(response);
    dataStatus.textContent = "";
    if (dryRun && response.errors.length === 0) {
      current.dryRun = { payload };
      applyImport.disabled = false;
    } else if (!dryRun) await refresh(current);
  } catch (error) {
    handleError(current, error, dataStatus);
  } finally {
    current.importBusy = false;
    if (!session || session === current) {
      if (input) input.disabled = false;
      if (submit) submit.disabled = false;
    }
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = tokenInput.value.trim();
  loginForm.reset();
  if (!token || session) return;
  const submit = loginForm.querySelector<HTMLButtonElement>(
    "button[type=submit]",
  );
  if (submit) submit.disabled = true;
  const current: Session = {
    token,
    controller: new AbortController(),
    rows: new Map(),
    filters: readFilters(),
    cursor: null,
    importBusy: false,
  };
  session = current;
  notice.textContent = "正在验证…";
  try {
    const page = await api.json<AdminCommentPage>(path, {
      token,
      signal: current.controller.signal,
      query: current.filters,
    });
    if (session !== current) return;
    login.hidden = true;
    panel.hidden = false;
    notice.textContent = "";
    applyPage(current, page, false);
    select("lock").focus();
  } catch (error) {
    if (session === current) lock(errorMessage(error, "无法解锁，请重试。"));
  } finally {
    if (submit) submit.disabled = false;
  }
});

select("lock").addEventListener("click", () => lock("审核台已锁定。"));
window.addEventListener("pagehide", () => lock("", false));
filterForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!session) return;
  session.filters = readFilters();
  void refresh(session);
});
next.addEventListener("click", () => {
  if (session?.cursor) void refresh(session, true);
});
media.addEventListener("change", async () => {
  const current = session;
  if (!current) return;
  current.mediaRequest?.abort();
  current.emoji = undefined;
  const controller = new AbortController();
  current.mediaRequest = controller;
  renderList(current);
  if (!media.checked) return;
  try {
    current.config ??= api.json<PublicConfig>("/v1/config", {
      signal: current.controller.signal,
    });
    const config = await current.config;
    if (controller.signal.aborted || session !== current) return;
    current.emoji = createEmojiResolver(
      config.misskey_instance_url,
      AbortSignal.any([current.controller.signal, controller.signal]),
    );
    renderList(current);
  } catch {
    current.config = undefined;
  }
});

const exportButton = select<HTMLButtonElement>("export");
exportButton.addEventListener("click", async () => {
  const current = session;
  if (!current || exportButton.disabled) return;
  exportButton.disabled = true;
  try {
    const data = await api.json<unknown>("/v1/admin/export", {
      token: current.token,
      signal: current.controller.signal,
      query: { include_private: privateExport.checked },
    });
    if (session !== current) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    );
    const anchor = element("a");
    anchor.href = url;
    anchor.download = `cf-comments-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    dataStatus.textContent = "管理备份已生成。";
  } catch (error) {
    handleError(current, error, dataStatus);
  } finally {
    exportButton.disabled = false;
  }
});

importForm.addEventListener("change", () => {
  clearReport();
  dataStatus.textContent = "";
});
importForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (session) void runImport(session, true);
});
applyImport.addEventListener("click", () => {
  if (session?.dryRun && window.confirm("将试跑通过的评论写入当前数据库？"))
    void runImport(session, false);
});
const unlock = loginForm.querySelector<HTMLButtonElement>(
  "button[type=submit]",
);
if (unlock) unlock.disabled = false;
