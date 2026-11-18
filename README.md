# QuickShare

自托管的内容分享服务：把 HTML、Markdown、SVG、Mermaid 内容生成可控的分享链接，带密码保护、内容修订历史和按 Share 粒度的 API 授权。基于 Express + EJS，生产部署在 Vercel + Postgres（Neon）。

**在线演示**：https://quickshare.namooca.com

## 主要功能

- **四种内容类型**：HTML、Markdown、SVG、Mermaid，类型自动检测；分享内容通过 sandbox iframe 渲染，与管理端同源隔离。
- **密码保护与即时撤销**：分享可设密码（自定义 4–12 字符或自动生成）；访问 Cookie 绑定 Share ID + 访问版本，改密码、改有效期、下架或主动撤销都会推进访问版本，旧 Cookie 立即失效。
- **内容修订**：每次内容更新生成不可变快照（单调递增 Revision），可浏览历史、恢复任意版本（恢复产生新 Revision）、显式清除历史（留墓碑，不可恢复）。
- **API Key 授权**：托管 Key 带 scope（`share:create/read/update/publish`）与按 Share 的 grant（read/update/publish），两者合取才放行；有 scope 无 grant 统一返回 404，不泄漏资源存在性。Key 轮换保留 ID 与 grants，旧 secret 立即失效。另有兼容用的环境变量 Key（仅创建）。
- **幂等创建**：创建与内容写入支持请求标识去重，重放按规格判错，不会重复建 Share 或重复推进版本（见 spec #24 §8）。
- **条件写入**：内容与访问状态各有独立强 ETag 与 If-Match 校验，版本不符返回 412、缺前置条件返回 428，杜绝旧缓存覆盖新内容。
- **备份与安全恢复**：`pg_dump` 一致性备份 + 带 SHA-256 摘要的清单（`manifest.json`）；恢复只进隔离数据库，恢复库保持写维护（`safeToServe: false`），核对通过才允许上线。
- **主题系统**：Markdown 主题预设共享阅读基线、各自保留视觉签名（ADR 0001）；UI 主题四套（default / hacker / cyberpunk / popart）。

## 架构与关键决策

- **双 Repository**：数据层接口在 `models/pageRepository.js` 之后有两套实现——内存版供本地开发与测试秒级运行，Postgres 版供生产；接口面由专门的一致性测试锁定，两边方法与签名漂移会直接测试失败。生产缺 `DATABASE_URL` 时启动直接失败，绝不退回内存。
- **凭证撤销设计**：内容版本（Revision）与访问版本（Access Revision）分开计数。普通正文更新只推进前者；任何访问策略变化推进后者，绑旧版本的 Cookie 自然失效——不需要维护撤销名单（spec #24 §4、§5）。
- **公开投影纪律**：不存在/已删除/下架统一 404，已发布但过期 410，未解锁只显示中性密码页，不泄漏真实标题、简介或正文片段。
- **判错规则有出处**：幂等、If-Match、scope+grant 合取、备份发布门等语义全部来自 parent spec #24，关键章节摘录在 `docs/spec-24-excerpts.md`，代码注释直接引用其条目。

## 里程碑

2026 年 11 月，项目按 parent spec [#24](https://github.com/nardinmarcus/quickshare/issues/24)《Share 持续管理：版本、授权与安全更新》完成一轮完整里程碑：T01–T19 共 19 张实施票按依赖顺序逐票实现、测试、合并（PR #44–#59），迁移 004–010 与存量数据回填后部署生产并通过在线冒烟；其后又完成密码静默截断修复（#60）与一轮审计驱动的死代码清理（#61）及审计收尾（Repository 一致性测试、规格摘录入仓）。上面「主要功能」中的修订、授权、幂等与备份语义都出自这一轮。

## 运行要求

- Node.js 20+
- npm
- 生产部署需要 Postgres，例如 Vercel Marketplace 的 Neon 集成。

## 本地开发

```bash
cp .env.example .env
npm install
npm run dev
```

默认访问 http://localhost:5678 。`.env` 中没有 `DATABASE_URL` 时本地使用内存仓库，重启后数据清空。

## 主要脚本

```bash
npm run dev            # 开发服务（nodemon）
npm start              # 生产方式启动
npm test               # 日常测试（内存仓库）
npm run test:postgres  # Postgres 集成测试
npm run db:migrate     # 执行 db/migrations/ 编号迁移
npm run db:backup      # 一致性备份（见 docs/backup-restore.md）
npm run db:restore     # 恢复到隔离数据库
npm run hash-password -- "your-admin-password"   # 生成管理员密码 hash
```

## 测试

两条线，按改动范围选：

- **日常**：`npm test`——内存仓库，秒级，覆盖内容渲染、安全与访问策略、Share API、Admin 路由与 Repository 行为。
- **动数据层必跑**：`npm run test:postgres`——真实 Postgres 集成（迁移、备份/恢复、授权、幂等、修订等 14 个套件）。需要本地测试库，数据库名必须以 `_test` 结尾，且只能指向 localhost：

```bash
POSTGRES_TEST_URL=postgresql://postgres:password@127.0.0.1:5432/quickshare_test?sslmode=disable \
  npm run test:postgres
```

## 安全边界

系统有两层独立认证，生产只接受 `npm run hash-password` 生成的 scrypt hash、拒绝明文：

- **前端登录**（`/login`，`ADMIN_PASSWORD_HASH`）：当后台开关为“需要密码”时，控制首页、浏览器创建和预览。
- **管理后台**（`/admin/login`，`ADMIN_DASHBOARD_PASSWORD_HASH`）：控制 pages 管理、统计面板和审计日志；写操作带 CSRF token。

`SESSION_SECRET` 签名所有认证 Cookie 与 CSRF token，生产必须为至少 32 bytes 的随机值。管理后台 `/admin/stats` 的“首页访问控制”开关以 Postgres 为唯一真值，读取失败返回 503，不降级为公开。schema 只通过 `npm run db:migrate` 变更，应用运行时不执行 DDL。

进一步隔离可把管理端与分享页拆成两个域名（`admin.example.com` / `share.example.com`）。

## Share API

`POST /api/v1/share` — 通过 API Key 鉴权创建分享页面，供 CLI 和 Agent Skill 调用：

```bash
curl -s -X POST "$QUICKSHARE_URL/api/v1/share" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $QUICKSHARE_API_KEY" \
  -d '{"htmlContent":"<h1>Hello</h1>"}'
```

`SHARE_API_KEY` 见 [docs/deployment.md](docs/deployment.md) 的环境变量表；托管 Key 的 scope/grant 管理接口见 spec #24 §6、§7。

## 部署

部署指南见 [docs/deployment.md](docs/deployment.md)，包含 Vercel（推荐）和 Docker 两种方式；备份恢复流程见 [docs/backup-restore.md](docs/backup-restore.md)。

## 关键目录

```text
api/              Vercel function 入口
app.js            Express app 工厂和全部路由
config.js         环境变量聚合
server.js         本地服务器入口
vercel-app.js     Vercel 构建时使用的 app 包装
models/           数据层（Repository 选择器 + Postgres / 内存实现）
db/migrations/    按编号执行的 Postgres schema 迁移
views/            EJS 模板（含 admin-* 管理后台页面）
public/           静态资源（css/ js/ icon/）
utils/            security.js, contentRenderer.js, codeDetector.js, pageTitle.js
scripts/          迁移、备份/恢复、密码 hash 与维护脚本
test/             Node test runner（含 integration/ Postgres 套件）
docs/             部署、备份、运维文档与 adr/
DESIGN.md         后台 UI 设计稿
```

## License

ISC
