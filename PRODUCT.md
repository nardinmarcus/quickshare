# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users and jobs

- **站长（主要使用者）**：登录后把一段 HTML、Markdown、SVG 或 Mermaid 粘贴进来，发布成一个可分享的链接；之后在管理后台找到某个分享，复制链接、查看密码、上下架、克隆或删除，并查看历史版本、统计、API 密钥和审计日志。使用频率高，桌面为主，手机可用。
- **公开模式下的访客**：站点设置可以把首页切为公开，这时陌生人也能粘贴内容并发布。首页要让第一次来的人一眼看懂怎么用，但它是工具，不是营销页。
- **CLI 与 Skill**：通过 `/api/v1/*` 和 API Key 创建、读取、更新分享，不经过界面。

## Purpose

粘贴代码，一键分享。内容在沙箱 iframe 里渲染，和管理端同源隔离；分享可以设密码和有效期。

## Capabilities and constraints

- 内容类型只有 `html`、`markdown`、`svg`、`mermaid` 四种；Markdown 有多套内容主题，在沙箱内独立渲染。
- 两层登录：首页发布（可切公开）和管理后台，密码独立。
- 写操作带 CSRF；`GET /view/:id` 只读。
- 管理后台的所有时间按北京时间显示。
- 技术栈是 Express、EJS、原生 CSS 和 JS，部署在 Vercel；不引入前端框架。
- 界面语言是中文，内容中英混排。

## Voice

简短、直接、中性。状态用文字说清楚（公开、密码保护、已下架），错误信息说明发生了什么和怎么办。领域词汇见 `CONTEXT.md`（例如 Share、Favorite Share）。

## Open decisions

- 真实分享数量级未确认；后台列表目前提供宽松和紧凑两档行高。
- 手机端使用频率未确认。
