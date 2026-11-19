# 部署 cf-comments

[English](deployment.md) · 简体中文

## 首次部署

1. 在仓库根目录运行 `pnpm install --frozen-lockfile`，用 `cf auth login` 登录 Cloudflare。新站点用 `cf d1 create --name cf-comments` 创建数据库，将名称和 UUID 分别填入 `cf-comments.config.json` 的 `d1DatabaseName`、`d1DatabaseId`。
2. 填写 `workerName`、`siteUrl`、`allowedOrigins` 和 `commentsDomain`。邮箱、头像等选项见[配置表](spec.md#9-configuration-matrix-public-vs-bindings-vs-secrets)。
3. 用 `cf d1 migrations apply <database-uuid>` 初始化**新库**。已有评论的数据库不要重建；先核对表结构和备份，再应用缺失的前向迁移。
4. 运行 `pnpm run build`，用 `cf deploy --prebuilt --dry-run` 核对构建，再用 `cf deploy --prebuilt --secrets-file <private-secrets-file>` 首次发布。密钥文件可从[模板](../.env.example)起步，只填必需密钥和已启用服务的密钥，不提交到 Git。
5. 访问 Worker 的 `/v1/config`，并用管理令牌解锁 `/admin/`。普通组件更新随 Worker 发布，不用重建嵌入该组件的站点。

## GitHub Actions 自动发布

适用于**已有 Worker、绑定现有 D1 且只有一个自定义域**的部署。先在 GitHub 的 `production` 环境限制仅 `main` 可发布，填入部署专用 Secret `CLOUDFLARE_API_TOKEN` 和[生产变量清单](deployment.md#one-time-setup)。业务密钥保留在 Cloudflare，后续发布继承既有绑定，不上传 `.dev.vars.prod`。

首次 CI 检查通过后，把仓库级变量 `CF_DEPLOY_ENABLED` 设为 `true`，从 `main` 手动运行一次 **Check and deploy comments**。此后 PR 只检查，推送 `main` 则在检查通过后核对现有域名和 D1 绑定并自动发布。设为 `false` 可暂停发布而保留 CI。工作流不会自动迁移 D1、导入评论或回填头像。
