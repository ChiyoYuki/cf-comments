# 项目整体理解与交接说明（Antigravity 视角）

本文从项目整体出发，总结 `cf-comments`（`ChiyoYuki/cf-comments`）的设计理念、端到端架构、核心不变量以及本轮完成的工作，供继任 Agent 快速建立全局认知；分工与后续路线请结合具体任务与用户自行决定。另一位前任协作者的视角见 [agent-handoff-b.md](agent-handoff-b.md)。

## 1. 项目定位与整体架构
- **目标**：面向静态博客的轻量、自托管、通用评论系统。单个 Cloudflare Worker + 单个 D1 数据库即可承载全部 API、原生 Material Design 3 评论挂件（`<cf-comments>`）与同源 `/admin/` 审核台；宿主站点（如 Astro + Fuwari + Swup）保持独立托管，常规评论更新只发 Worker 即可生效。
- **端到端体验**：坚持原生 TypeScript + CSS（零前端框架运行时）、Shadow DOM 隔离与 MD3 表面层级（亮/暗模式与宿主色相变量联动）；支持匿名评论、楼中楼游标分页、相对时间与剩余字数提示（默认上限 `3000` 字，取自 Misskey 典故）。每条评论显式选择 `gfm` 或 `mfm`（官方 `unified/remark-gfm` 与 `mfm-js` 正交管线，经 `rehype-sanitize` 消毒），前端按需懒加载 `/assets/v1/preview.js` 复用同一 `src/markdown/` 实现零后端压力的本地实时预览，正式提交仍由服务端重算消毒。Misskey `:emoji:` 由浏览器直连解析、零服务端缓存；`$[blur]` 为行内平滑模糊交互。
- **数据、隐私与防垃圾**：`pending` 子树整棵隐藏不计入统计；`hidden`/`spam`/`deleted` 仅在存在公开后代时以占位返回（不泄露 `spam`）。软删不可逆并清空正文、作者信息、邮箱与 `avatar_hash`；硬删仅限叶节点（有子回复返回 `409`）。头像默认 OKLCH 首字；开启 `gravatarEnabled` 时仅对公开非占位评论返回固定 `https://gravatar.com/avatar/<sha256>?s=96&d=404&r=g`，绝不暴露明文邮箱或独立哈希字段。邮件采用站长 `cf_email_routing` + 访客回复 `resend`，经 RFC 9110 两步确认（48h 过期）和 D1 `email_outbox`（事务入队、租约锁、`waitUntil` + 5 分钟 Cron 重试、30 天清理）。防护包含 `32 KiB` 上限、蜜罐、基于临时 IP HMAC 的边缘限流与可选 Turnstile；`/admin/` 令牌仅留内存且默认不加载外链媒体。

## 2. 本轮完成的主要工作与线上状态
- 敲定并落地 v1 规范（`docs/spec.md`、`docs/openapi.yaml`、`schemas/export.schema.json`）、合并后的单文件建表 `migrations/0001_init.sql`、共享 GFM/MFM 渲染引擎、Worker API、邮件与事务发件箱、标准导入导出、Waline 迁移与纯哈希头像回填脚本，以及基于 `node:sqlite` 的端到端测试。
- 参与前端紧凑排版、MD3 视觉层级与 Misskey 细节评审，推动按需懒加载实时预览与后端去重重构。
- 完成生产 Worker `cf-comments`（域名 `comments.chiyo.uk`）与生产 D1 的部署上线、Waline 历史数据停写对账（跳过 `/` 保留 18 条，12 条公开有邮箱记录已完成纯哈希回填，未恢复邮箱与订阅）及预发布资源清理。**严禁重建生产 D1 或覆盖线上留言**。
- 核验 `cf@0.15.0` 的 `cf deploy --prebuilt` 密钥自动继承机制（不传 `--secrets-file` 自动以 `{ type: "inherit" }` 保留 Cloudflare 端既有 `ADMIN_TOKEN`/`TOKEN_SIGNING_SECRET`/`RESEND_API_KEY`），完成 GitHub `production` 环境 15 项变量配置并与唯一 Secret `CLOUDFLARE_API_TOKEN` 跑通首次自动发布。

## 3. 协作与发布红线
- **公开仓库零隐私硬编码**：追踪文件严禁出现真实邮箱、密钥、原始导出或本机绝对路径；私有配置仅存 gitignored 的 `cf-comments.config.json` 与 `.dev.vars.*`。
- **提交与迁移**：中文写 commit 标题与正文，仅附自己的 `Co-authored-by`；仓库不再维护 `docs/agent-worklog/`，变更与验证记在 commit 中。普通 push 不跑 D1 迁移；新增前向迁移须先备份生产 D1 并手工应用后再发布代码。
- **验证**：提交前跑通 `pnpm run lint`、`typecheck`、`test`、`build`；本机 Node 访问外网需 `--use-env-proxy`。推送 `main` 在 `CF_DEPLOY_ENABLED=true` 时会自动发布生产 Worker。
