# API 身份与能力发现（T05）

Agent 接入 QuickShare 后，不应靠猜测判断自己是谁、能做什么。v1 API 提供两个
只读的连接检查接口；它们与实际路由行为共用同一份定义
（`utils/apiCapabilities.js`：创建路由的内容类型集合、体积限制都直接取自
该模块），因此文档、能力响应与真实 HTTP 行为不会互相漂移。

两个接口都要求有效的 `X-API-Key`（托管 Key 或旧版环境变量 Key），缺失或
无效凭据返回 401。它们都是读操作：**写维护暂停期间仍可调用**，以便在维护
窗口内检查连接（见 [写维护手册](maintenance.md)）。

## `GET /api/v1/me`

返回实例规范 origin 与本次请求实际验证的凭据身份，不含任何 secret/hash：

```json
{
  "success": true,
  "origin": "https://share.example.com",
  "credential": {
    "type": "managed",
    "keyId": "Ab3dEf7Gh9Jk",
    "name": "Namoo QuickShare skill",
    "credentialVersion": "2",
    "scopes": ["share:create"]
  }
}
```

- `type` 为 `managed`（后台托管 Key）或 `legacy`（环境变量
  `SHARE_API_KEY`）。legacy 凭据没有逻辑 Key 身份，`keyId`、`name`、
  `credentialVersion` 均为 `null`。
- `credentialVersion` 是十进制字符串（数据库为 BIGINT）：创建时为 `"1"`，
  每次轮换加一。它同时是写事务复核的版本（见下）。

## `GET /api/v1/capabilities`

返回协议版本、当前凭据的可用操作、真实内容类型、Markdown Theme Preset
ID、体积限制与条件写规则。T05 阶段两类凭据均为 **create-only**：唯一写
操作是 `POST /api/v1/share` 创建 Share；能力响应只列这一个写操作，不会
提前宣称尚未实现的管理操作。T12 起托管 Key 可以持有 `share:read` 范围
并获得逐 Share 只读授权，能力响应随之如实扩展（见文末 T12 一节）；
旧版单 Key 仍然恒为 create-only。

要点：

- `contentTypes`：`html`、`markdown`、`svg`、`mermaid`，与创建路由接受
  的集合逐字一致。
- `markdownThemePresets`：实例真实存在的 12 个 Preset ID。
- `limits.shareRequestBodyBytes`：由实例配置 `SHARE_BODY_LIMIT` 换算的
  真实字节上限（默认 `2mb` = 2097152）。
- `conditionalWrites`：创建目前不要求 `If-Match` 或幂等键；但写操作经过
  写维护闸（暂停时 503 `maintenance`），且托管 Key 写会在事务内复核凭据
  版本（见下）。
- T06 起，创建响应附带新 Share 的基线内容版本 `contentRevision: "1"` 与
  其强 ETag `contentEtag`（格式 `"content:<Share ID>:<Revision>"`)。
  v1 API 仍是 create-only：不存在经 API 修改内容的写操作，因此能力响应
  不宣称任何内容条件写；内容修订与 `If-Match` 前置条件只存在于后台编辑
  入口（见 [内容 Revision 上线说明](content-revision-rollout.md)）。

## Key 轮换与凭据版本复核

所有者在后台「API 管理」页对托管 Key 执行轮换（`POST
/admin/apis/keys/:id/rotate`，需后台会话 + CSRF）：

- 逻辑 Key ID、名称、创建时间保持不变；secret/hash 被替换，
  `credential_version` 原子加一。
- 新 secret 只在轮换成功回执中显示一次，页面与列表永不回显旧 secret。
- 旧 secret 立即失效：不仅新请求会被拒绝，**已经通过第一次验证、但写
  事务尚未提交**的请求也会在事务内锁定 Key 行复核版本时被拒绝
  （401 `api_key_credential_changed`），不会在所有者撤销后继续写入。
  删除 Key 同理：写事务发现 Key 行不存在即拒绝。
- 轮换与创建、删除一样经过写维护闸：维护暂停时轮换返回 503
  `maintenance`，不产生半成品状态。
- Key 只是调用凭据，不是 Share 所有者：轮换不改变任何 Share 的内容、
  访问策略或归属。

完整备份/恢复核对覆盖 `api_keys.credential_version`（见
[备份与恢复手册](backup-restore.md)）：恢复后逐 Key 比对精确版本，只改
恢复库中的版本号会被核对拒绝。

## 幂等创建与操作确认（T08）

`POST /api/v1/share` 可选地接受 `Idempotency-Key` 请求头：

- 带头时，创建按凭据命名空间幂等：同一 Key + 相同输入重放原始结果
  （响应多 `requestId`，重放时另有 `replayed: true`）；同一 Key + 不同
  输入返回 409 `idempotency_conflict`；结果已不可用时返回 410
  `operation_result_unavailable`；请求头格式非法返回 400
  `invalid_idempotency_key`。客户端应生成 UUID v4 作为请求标识。
- 不带头时行为与以往完全一致（HTTP 200 与原有响应字段），且**不是**
  幂等创建，文档与能力响应都不这样宣称。
- 响应丢失后，用 `GET /api/v1/operations/:requestId` 按请求标识确认
  结果：只返回状态与资源/版本标识（Share ID、内容 Revision、访问
  Revision），永不返回密码、标题、描述或正文。该确认属于 create 能力
  本身，不是 Share 管理授权；旧版 Key 只能确认自己命名空间内的创建。
  生成密码只能通过重放原始创建请求、且当前访问策略未变更时取回。

能力响应在 `conditionalWrites[0].idempotency` 中如实描述以上行为；
完整约定（命名空间、摘要、固定处理顺序、回放规则、网页端待确认
意图与克隆）见 [发布操作手册](publishing-operations.md)。

## 范围、逐 Share 授权与只读资源 API（T12）

托管 Key 持有**范围（scopes）**，站点所有者另行给 Key 逐条**授权
（grant）**到具体 Share。Share 不归 Key「所有」：Key 只是凭据，授权是
「哪把凭据能碰哪些资源」的单独关系。全部范围只有四个：
`share:create`、`share:read`、`share:update`、`share:publish`；本票可用
并可分配的只有 `create` 与 `read`（`update`/`publish` 的操作面随各自
后续票落地，后台不显示不存在的操作开关）。

- **迁移**：迁移 010 给已有托管 Key 规范化为 create-only；
  `auto_grant_new_share_edit`（「新创建 Share 自动给可编辑授权」）以字段
  形式引入、默认 `false`，仅存储——其行为随 update 能力在后续票启用，
  本票没有对应的后台开关（不展示无效开关）。旧版单 Key 恒为
  create-only，永远不能持有管理范围或授权。
- **轮换保留**：轮换保留逻辑 Key ID、范围与全部授权；删除 Key 在同一
  事务内撤销其全部授权。删除 Share 同理清除以它为目标的授权。
- **后台管理**（仅站点所有者的网页会话 + CSRF）：在「API 管理」页给
  托管 Key 勾选 `share:create` / `share:read` 范围并保存；逐 Key 的
  「Share 只读授权」面板授予/撤销单条 Share 的 read 授权。授权与撤销
  都是发布写，经过写维护闸（暂停时 503 `maintenance`）且立即生效，
  并各写一条审计（`api_key.grant` / `api_key.grant_revoke`，范围变更写
  `api_key.scopes`）。

### 只读端点

授权判定恒为**范围 ∧ 授权**的合取（权限细则：grant 的 `update` 蕴含
`read`；`publish` 不蕴含 `read`）：

| 端点 | 所需范围 | 所需授权 | 说明 |
|---|---|---|---|
| `GET /api/v1/shares` | read / update / publish 任一 | 每条结果按自身授权过滤 | 已授权 Share 列表，游标分页 |
| `GET /api/v1/shares/:id/content` | `share:read` | 该 Share 的 read（update 蕴含） | 当前内容快照，强 ETag |
| `GET /api/v1/shares/:id/state` | `share:read` 或 `share:publish` | 对应 read 或 publish | 受限状态投影，强 ETag |

- **错误矩阵**：无凭据/凭据无效 → 401；缺少操作所需范围 → 403
  `insufficient_scope`；有范围但对目标 Share 无授权（含 Share 不存在）
  → 404 `share_not_found`——未授权与不存在不可区分，不泄露资源存在性。
  仪表盘 Cookie、公开访问 Cookie、公开查看权都不构成管理授权。
- **列表**：`limit` 默认 20、最大 100（超限收敛到 100；非整数或小于 1
  返回 400 `invalid_limit`）；`cursor` 为不透明 base64url，按
  `(createdAt, ID)` 升序的稳定键集分页，同一比较同时用于排序与过滤
  （同时间戳混合大小写 ID 不丢不重）；游标非法返回 400
  `invalid_cursor`。没有 read 权限的条目把标题/描述/主题置空（仍列出
  ID 与生效权限），列表永不含密码、收藏或授权表内部字段。
- **内容**：只返回当前快照的字段（ID、内容 Revision、HTML、内容类型、
  标题、描述、Markdown 主题），永不含密码（明文或密文）。当前快照已
  被清除（T10 墓碑）时返回 410 `revision_unavailable`。
- **状态**：只返回 `published`、`isProtected`、`expiresAt`、
  `accessRevision` 四项——永不含标题、描述或正文。
- **可见性独立**：管理读取不复用公开可见性判断：已下架、已过期的
  Share 在授权下仍然可读（公开面仍是 404/410），发布状态从状态端点
  读真实值。
- **ETag 与条件读**：内容与状态使用两套独立的强 ETag——
  `"content:<Share ID>:<内容 Revision>"` 与
  `"access:<Share ID>:<访问 Revision>"`，互不通用（拿内容 ETag 问状态
  不会命中）。内容保存只推进内容 ETag；改密码/下架等推进访问版本只
  推进状态 ETag。两个 GET 都支持 `If-None-Match`：按 RFC 7232 对 GET
  使用**弱比较**（`W/` 前缀的弱标签同样匹配、`"*"` 匹配现存表示），
  命中返回 304 空体。所有管理响应都是 `Cache-Control: private,
  no-store`。
- **能力与身份**：`GET /api/v1/me` 的 `scopes` 如实报告当前凭据的范围；
  `GET /api/v1/capabilities` 只为当前凭据实际能做的操作列
  `share.list` / `share.content.read` / `share.state.read`，并在出现读
  操作时附带 `conditionalReads`（两套 ETag 语义）与
  `managementAuthorization`（401/403/404 契约）说明。create-only 凭据的
  能力输出与 T05/T08 时完全一致。
- **备份覆盖**：范围与授权随备份走——摘要比对逐 Key 的 `scopes` 原文与
  逐条授权，恢复侧缺失/漂移会指名判失败。恢复早于某次授权撤销的旧
  备份会把该授权带回来，恢复后须由所有者人工核对授权清单（见
  [备份与恢复手册](backup-restore.md)）。
