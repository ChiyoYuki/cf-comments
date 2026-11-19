# cf-comments

[English](README.md) · 简体中文

面向博客和静态站点的轻量自托管评论系统。一个 Cloudflare Worker 和一个 D1 数据库提供 API、可嵌入的 Web Component 和审核台；博客可以继续留在现有托管平台。

- 支持匿名评论、楼中楼、游标分页和审核。
- 每条评论可选 GitHub Flavored Markdown（GFM）或 Misskey 标记语言（MFM），按需开启浏览器实时预览。GFM 支持远程图片，不支持上传。
- 无框架运行时的 Material 3 组件，支持亮暗主题和 SPA；可选 Gravatar 头像与 Misskey 自定义表情。
- 支持站长提醒、邮箱验证后的直接回复通知、JSON 备份和 Waline 迁移。

## 快速开始

使用 Node.js 24、`package.json` 中指定的 pnpm 和 Cloudflare `cf` CLI 0.15.0。按[中文部署指南](docs/deployment.zh-CN.md)创建并初始化 D1，或将现有 Worker 接入 GitHub Actions。将[站点配置模板](cf-comments.config.example.json)复制为 `cf-comments.config.json`、[密钥模板](.env.example)复制为 `.dev.vars`，两个本地文件都不应提交。

## 嵌入评论

```html
<script type="module" src="https://comments.example.com/assets/v1/comments.js"></script>
<cf-comments api-base="https://comments.example.com" path="/about/" lang="zh-CN"></cf-comments>
```

将嵌入页面的准确来源加入 `allowedOrigins`。使用以斜杠结尾的稳定站内 `path` 作为讨论串标识。SPA 只需在可替换区域外加载模块一次；设置 `reply-limit="0"` 可按需加载楼内回复。组件支持简体中文和英文，可用宿主上的 `--cc-accent`、`--cc-surface`、`--cc-page` 等变量适配站点主题。

## 审核与隐私

打开 Worker 域名下的 `/admin/`，用 `ADMIN_TOKEN` 解锁；令牌仅保存在内存中，审核台默认不加载远程媒体。Gravatar 默认关闭；启用后，公开头像链接包含可跨站比对的固定邮箱哈希。没有头像或加载失败时显示昵称首字。

## 开发

```sh
pnpm install --frozen-lockfile
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run build
```

- `src/client/`、`src/admin/`、`src/styles/`：读者评论组件、审核台和共用样式。
- `src/worker/`、`src/markdown/`、`src/email/`：API、共享渲染管线和邮件通知。
- `src/config/`、`src/importers/`、`src/shared/`：配置、迁移适配器和共用工具。
- `scripts/`、`migrations/`、`tests/`：构建和导入工具、D1 表结构及回归测试。

## 文档导航

- [部署与 GitHub Actions](docs/deployment.zh-CN.md)
- [备份与 Waline 迁移](docs/migration.md)
- [运行规范与配置](docs/spec.md) · [OpenAPI 3.1](docs/openapi.yaml) · [导出 JSON Schema](schemas/export.schema.json)
- [维护交接提示](docs/agent-handoff.md)
