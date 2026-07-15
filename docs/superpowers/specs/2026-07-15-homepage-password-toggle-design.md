# QuickShare 首页密码动态开关设计

- 日期：2026-07-15
- 状态：等待书面规格复核
- 范围：首页访问与浏览器发布入口；不改变管理后台、Share API 或分享页密码

## 1. 目标

在管理后台增加一个持久化开关，让管理员无需修改环境变量或重新部署，即可随时切换以下两种首页模式：

- **需要密码**：保持当前行为，访问首页和使用浏览器发布接口前需要有效的 `admin_session`。
- **公开发布**：匿名访客可以进入首页，并通过浏览器创建或预览分享。

设置必须以数据库为唯一真值，在 Vercel 多实例环境中立即一致。运行时内存可以用于局部计算，但不得成为访问控制的判断来源。

## 2. 已确认的产品行为

1. 新迁移默认设置为“需要密码”，部署本身不会自动公开首页。
2. 管理员在生产验证完成后，从后台手动切换为“公开发布”。
3. 切换为公开发布前必须二次确认，明确提示任何访客都可以创建分享并写入数据库。
4. 切换回需要密码直接提交，不要求二次确认。
5. 切换回需要密码后，新的匿名请求立即受限；已经持有有效 `admin_session` 的设备继续使用该会话，直到当前 24 小时有效期结束。
6. 设置更新期间禁用控件；只有服务端确认成功后才更新界面，失败时恢复原状态。
7. 每次真实状态变化都写入审计日志；重复提交相同状态保持幂等，不产生多余审计记录。

## 3. 非目标

本次不包含：

- 用户账号、注册、内容归属或配额系统。
- CAPTCHA、BotID 或新的防滥用产品。
- 修改现有 Vercel Firewall 限流规则。
- 移除 `/login`、`ADMIN_PASSWORD_HASH` 或现有 `admin_session` 机制。
- 修改管理后台密码、Share API Key 或单个分享页的访问密码。
- 使用进程内缓存、运行时缓存或环境变量保存动态开关。

## 4. 数据模型

新增迁移 `002_site_settings.sql`，创建一个强类型单例表：

```sql
CREATE TABLE public.site_settings (
  id SMALLINT PRIMARY KEY,
  homepage_password_required BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at BIGINT NOT NULL,
  CONSTRAINT site_settings_singleton CHECK (id = 1)
);
```

迁移通过 `INSERT ... ON CONFLICT DO NOTHING` 插入 `id = 1`、`homepage_password_required = TRUE` 的初始记录。`updated_at` 使用与现有业务表一致的毫秒时间戳。

选择强类型单例表而不是通用键值或 JSON 配置表，原因是当前只有一个明确设置：数据库可以直接约束类型和单例关系，无需引入键名解析、JSON 校验或通用配置抽象。

如果单例行缺失或读取失败，应用必须进入失败关闭状态并返回服务不可用，不能把缺失值解释为公开发布。

## 5. Repository 边界

Postgres 与 Memory Repository 都增加相同行为：

- `getHomepagePasswordRequired()`：返回布尔值；单例行缺失时抛出错误。
- `setHomepagePasswordRequired({ passwordRequired, ip })`：返回最终状态以及是否发生变化。

Postgres 更新方法在一个事务中完成：

1. 锁定并读取单例设置行。
2. 如果目标值等于当前值，提交无变化结果，不写审计日志。
3. 更新设置值和 `updated_at`。
4. 插入审计日志。
5. 提交事务。

审计动作固定为 `settings.homepage_password_required.update`，`details` 保存 `from` 与 `to` 两个布尔值，`ip` 沿用现有管理操作的来源地址记录方式。任何设置更新或审计写入失败都会回滚整个事务。

Memory Repository 默认值同样为 `true`，并模拟幂等更新和审计行为，保证测试模式不产生另一套语义。

## 6. 有效访问模式

生产继续保持 `AUTH_ENABLED=true`。动态设置只控制首页发布入口，不取代全局认证配置。

有效判断为：

```text
AUTH_ENABLED=false                  -> 沿用现有开发/测试全局免认证行为
AUTH_ENABLED=true + 设置=true       -> 首页需要密码
AUTH_ENABLED=true + 设置=false      -> 首页公开发布
设置读取失败                         -> 失败关闭，返回 503
```

应用在每个相关请求中直接读取数据库设置，不使用进程内缓存作为判断依据。初始实现接受每个相关请求增加一次轻量 `SELECT`；只有生产测量证明该查询成为瓶颈后，才另行设计带一致性边界的优化。

## 7. 路由访问矩阵

| 路由 | 需要密码 | 公开发布 |
|---|---|---|
| `GET /` | 有效 `admin_session`；否则跳转 `/login` | 匿名返回首页 |
| `POST /api/pages/create` | 有效 `admin_session` + CSRF | 匿名可用，但必须同源 |
| `POST /api/pages/preview` | 有效 `admin_session` + CSRF | 匿名可用，但必须同源 |
| `GET /login`、`POST /login` | 保持现状 | 保留为兼容和回滚入口 |
| `/admin/*` | 独立后台认证 | 独立后台认证，不变 |
| `POST /api/v1/share` | API Key | API Key，不变 |
| `/api/pages/list/recent` | 现有首页会话鉴权 | 仍需现有首页会话，不公开 |
| `/api/pages/:id/protect` | 现有首页会话鉴权 + CSRF | 仍需现有首页会话 + CSRF，不公开 |
| `/view/:id` 及密码校验 | 按单个分享设置 | 按单个分享设置，不变 |

不能整体绕过 `requireApiAdmin`，因为它还保护近期列表和修改分享保护状态等非公开接口。实现应为首页、创建和预览建立范围明确的动态访问中间件。

## 8. 公开发布请求保护

公开模式下，`POST /api/pages/create` 与 `POST /api/pages/preview` 不再有基于会话的 CSRF token，因此改为强制同源 `Origin`：

- `Origin` 必须存在。
- 解析后的 origin 必须与当前请求的协议和 host 完全一致。
- 缺失、格式错误或不匹配时返回 `403` JSON。

这项检查用于阻止第三方网站借访客浏览器发起发布请求，不用于识别自动化客户端。自动化滥用仍由现有 Vercel Firewall IP 限流和应用的 `2mb` 请求上限共同约束。

`GET /` 始终发送 `Cache-Control: private, no-store`，避免切换回需要密码后仍向访问者提供陈旧的公开首页响应。创建和预览接口继续使用现有 `privateNoStore`。

## 9. 管理后台界面

开关放在 `/admin/stats` 顶部、统计指标之前，新增“首页访问控制”卡片：

- 当前状态文案：`需要密码` 或 `公开发布`。
- 开关标签：`进入首页需要密码`。
- 辅助说明：公开模式允许任何访客创建分享；管理后台仍受独立密码保护。
- 状态区域使用可访问的 live region 报告保存中、成功和失败。

统计页渲染时同时读取设置，并生成绑定 `dashboard_admin_session` 的 CSRF token。页面只加载一个专用的本地脚本，例如 `/js/admin-settings.js`；不添加内联可执行脚本，继续满足现有 CSP。

关闭密码时使用与现有管理界面一致的可访问确认弹层。确认后才发送请求；取消则恢复开关。重新开启密码不弹确认，直接发送请求。

请求期间禁用开关和确认控件。成功响应后更新状态文案；网络错误、非成功响应或响应格式错误时恢复原值并显示错误，不让界面暗示一个未被服务端确认的状态。

## 10. 设置接口

新增幂等接口：

```http
PUT /admin/settings/homepage-access
Content-Type: application/json
X-CSRF-Token: <dashboard csrf token>

{"passwordRequired": false}
```

安全边界：

- 必须有有效 `dashboard_admin_session`；缺失时返回 `401` JSON。
- 必须有有效 dashboard CSRF token；错误时返回 `403` JSON。
- `passwordRequired` 必须是布尔值；否则返回 `400` JSON。
- 成功返回 `200`，包括最终 `passwordRequired` 和 `changed`。
- 数据库读取或事务写入失败返回 `503` JSON。

该接口使用 JSON 专用的后台鉴权响应，避免 fetch 跟随登录重定向后把 HTML 误当作成功 JSON。现有其他管理接口不在本次范围内重构。

## 11. 失败处理

| 场景 | 行为 |
|---|---|
| 首页设置读取失败 | 返回 `503` 错误页，不公开首页 |
| 创建或预览前设置读取失败 | 返回 `503` JSON，不执行正文解析后的业务写入 |
| 后台统计页设置读取失败 | 返回 `503` 错误页，不显示未知开关状态 |
| 设置 payload 非布尔值 | 返回 `400`，数据库不变 |
| 后台会话无效 | 返回 `401` JSON，前端提示重新登录 |
| CSRF 无效 | 返回 `403` JSON，数据库不变 |
| 设置或审计写入失败 | 事务回滚并返回 `503`，前端恢复旧状态 |
| 重复提交当前状态 | 返回 `200`、`changed=false`，不写审计 |

错误日志不得包含密码、session token、CSRF token、数据库连接串或分享正文。

## 12. 测试设计

### 12.1 迁移与 Repository

- 空数据库依次应用 `001`、`002`，确认 `site_settings` 单例默认 `true`。
- 重复运行迁移全部跳过且设置值不被重置。
- 从旧 schema 升级时保留已有 pages、audit logs 和 API keys。
- Postgres Repository 读取、更新、幂等更新和事务审计行为正确。
- 人为制造审计写入失败时，设置更新一并回滚。
- Memory Repository 与 Postgres 行为一致。

### 12.2 路由边界

- 默认模式下匿名 `GET /` 跳转 `/login`。
- 默认模式下匿名创建与预览返回 `401`。
- 公开模式下匿名 `GET /` 返回 `200`。
- 公开模式下带正确同源 `Origin` 的创建与预览成功。
- 公开模式下缺失或跨源 `Origin` 的创建与预览返回 `403`。
- 切回需要密码后，新匿名请求立即受限。
- 切回需要密码后，已有有效 `admin_session` 仍可进入首页和发布。
- `/admin` 继续要求 dashboard session；普通首页 session 不能访问后台。
- `/api/v1/share` 无 API Key 仍返回 `401`。
- 近期列表、保护状态接口和单个分享密码语义不变。
- 首页响应为 `private, no-store`。
- 设置读取故障路径返回 `503`，且不会降级为公开。

### 12.3 后台交互

- 统计页展示真实数据库状态和 dashboard CSRF token。
- 关闭密码前出现风险确认；取消不发送更新。
- 开启密码直接提交。
- 请求期间控件禁用。
- 成功后状态与服务端响应一致。
- 失败时恢复旧值并在 live region 显示错误。
- 实际变化产生一条审计记录；幂等提交不产生记录。

### 12.4 验证命令与浏览器检查

1. 运行全量 `npm test`。
2. 使用本地 `_test` Postgres 运行 `npm run test:postgres`。
3. 在真实浏览器中完成公开、重新加锁、已有会话和确认弹层流程。
4. 在预览部署中检查首页、后台、创建、预览、API Key 与跨源拒绝。

## 13. 上线与回滚

上线顺序：

1. 在可信迁移环境执行 `002`，确认单例行为 `homepage_password_required=true`。
2. 立即再次执行迁移，确认 `001`、`002` 均 skipped。
3. 部署代码；此时生产访问方式仍保持需要密码。
4. 验证匿名首页、首页登录、管理后台、Share API 和现有分享页。
5. 从管理后台切换为公开发布。
6. 实测匿名首页、同源创建与预览、跨源拒绝、后台隔离和审计记录。
7. 复核现有 Vercel Firewall 规则仍覆盖 create/preview，并返回预期的 `429` 超限语义。

回滚顺序：

1. 如果后台仍可用，先把首页重新切换为需要密码。
2. 回滚到上一稳定部署；旧代码忽略新增表，并继续按原逻辑要求首页密码。
3. 保留 `site_settings` 和迁移记录，不做破坏性 schema 回退。

如果新代码不可用而无法操作后台，应通过可信数据库管理路径把单例值更新为 `TRUE`，再回滚部署。

## 14. 验收标准

功能只有在以下条件全部满足时才算完成：

- 管理员可以在后台无需重新部署地切换首页密码要求。
- 默认迁移不改变当前生产访问状态。
- 公开模式只开放首页、浏览器创建和浏览器预览三个明确边界。
- 管理后台、API Key、历史管理接口和单个分享密码保持原保护。
- 公开写请求强制同源，并继续受请求体上限与 Vercel Firewall 约束。
- 设置以数据库为唯一真值，读取失败时安全关闭。
- 设置变化与审计日志具有事务一致性。
- 重新加锁不撤销现有有效首页会话。
- 全量测试、Postgres 集成测试、浏览器流程和生产路由 smoke 全部通过。
