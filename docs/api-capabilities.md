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
`share:create`、`share:read`、`share:update`、`share:publish`；T12 阶段
可用并可分配的只有 `create` 与 `read`（`update`/`publish` 的操作面随
各自后续票落地，后台不显示不存在的操作开关）。`update` 已随 T13 启用
（见下 T13 一节），`publish` 已随 T15 启用（见文末 T15 一节）——至此
四个范围全部可分配，集合外仍只有未知范围会被拒绝。

- **迁移**：迁移 010 给已有托管 Key 规范化为 create-only；
  `auto_grant_new_share_edit`（「新创建 Share 自动给可编辑授权」）以字段
  形式引入、默认 `false`，T12 阶段仅存储，其行为与后台开关已随 T13
  启用（见文末 T13 一节）。旧版单 Key 恒为 create-only，永远不能持有
  管理范围或授权。
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
  `share.list` / `share.content.read` / `share.state.read`（T14 起读
  族另含 `share.history.read` / `share.revision.read`，见下节），并在
  出现读操作时附带 `conditionalReads`（两套 ETag 语义）与
  `managementAuthorization`（401/403/404 契约）说明。create-only 凭据的
  能力输出与 T05/T08 时完全一致。
- **备份覆盖**：范围与授权随备份走——摘要比对逐 Key 的 `scopes` 原文与
  逐条授权，恢复侧缺失/漂移会指名判失败。恢复早于某次授权撤销的旧
  备份会把该授权带回来，恢复后须由所有者人工核对授权清单（见
  [备份与恢复手册](backup-restore.md)）。

## 授权更新与自动编辑授权（T13）

T13 启用 `share:update` 范围与 grant 的 `update` 权限：后台「API 管理」
页现在可分配 `share:update` 范围、可授予**编辑授权**（read+update）。
`share:publish` 当时仍不在可分配集合内（其操作面尚未落地），已随
T15 启用（见文末 T15 一节）。

### `PUT /api/v1/shares/:id/content`

更新原 Share 的当前内容，与后台保存共用同一个仓库事务（操作台账、
内容 CAS、无操作判定、审计），不另立规则：

- **前提**：凭据须同时持有 `share:read` 与 `share:update` 范围
  （update 蕴含 read 是 grant 侧的规则，范围侧两者都要），且对目标
  Share 持有 update 授权。判定违例：缺范围 403 `insufficient_scope`；
  无授权/Share 不存在 404 `share_not_found`。事务内部还会以 Key 行锁
  复核凭据版本与授权行（先提交的轮换/撤销先行生效），且复核在回放
  判定之前——已撤销或已轮换的凭据不能凭旧请求标识回放。
- **请求体（严格）**：完整四字段快照 `htmlContent`（非空、原文逐字
  存储）、`title`、`description`、`markdownTheme` 均为必填；
  `codeType` 可提交但必须与当前一致（固定不可改）；任何其他字段——
  包括访问策略、收藏、计数、下架状态类字段——以 400 `invalid_field`
  拒绝并指名字段；缺字段 400 `missing_field`。Markdown Share 的主题
  必须是已知 Preset ID（未知 400 `invalid_markdown_theme`，不静默
  替换）；非 Markdown Share 的主题必须为 `null`。
- **强制条件头**：`If-Match` 必须是当前内容 Revision 的强标签
  `"content:<Share ID>:<Revision>"`（缺失 428；过期/弱标签/通配/访问
  家族标签 412 `content_conflict`，响应附 `current` 当前快照供合并）；
  `Idempotency-Key` 必填（缺失/格式非法 400
  `invalid_idempotency_key`）。同一 Key 命名空间内同标识同输入重放
  原始结果，同标识换输入或换基线 409 `idempotency_conflict`，结果不
  可用 410；维护暂停时（连同重放）503 `maintenance`。写完后可经
  `GET /api/v1/operations/:requestId` 在本 Key 命名空间内确认结果
  （其他 Key 的命名空间返回 404）。
- **语义**：真实变更写一条新 Revision（`source: "api-update"`、主体
  类型 `api_key`）与审计 `page.content.update`，访问 Revision 不受
  影响；候选与当前完全一致时是无操作成功（不写 Revision），响应
  `contentChanged: false`。响应回执含原 Share URL、内容 Revision 与
  强 ETag、访问 Revision 与本次应用的快照；任何响应与错误都不含
  密码材料。
- **与可见性解耦**：管理授权不等于公开可见——已下架、已过期的
  Share 在授权下仍可更新（公开面不变），此操作不恢复任何旧访问
  Cookie。
- **能力**：`GET /api/v1/capabilities` 仅当当前凭据为托管 Key 且同
  时持有 read+update 范围时才列 `share.content.update` 并在
  `conditionalWrites` 附其 `If-Match` + 幂等键规则；只持其一或 legacy
  凭据不列。

### 自动编辑授权（`auto_grant_new_share_edit`）

每把托管 Key 一个布尔开关（后台「Share 授权」面板内，PUT
`/admin/apis/keys/:id/auto-grant`，审计 `api_key.auto_grant`）：

- 默认 `false`；开启要求该 Key 已具备 `share:read` + `share:update`
  范围，否则 400 `auto_grant_requires_scopes`。
- 开启后，仅对**该 Key 在开启之后新建**的 Share，在创建事务内原子
  写入 read+update 授权（不含 publish、不追溯既有 Share）；创建与
  授权同成同败——授权写入失败则整个创建回滚。幂等创建的重放不
  产生第二条授权。
- 轮换保留该开关（与范围、授权一起）；删除 Key 时授权随之清除。
- 备份覆盖：开关原样随备份走；恢复演练固件含开启开关的 Key、一条
  update 授权与一条 API 更新操作记录，并对 `can_update` 做篡改
  判失败（见 [备份与恢复手册](backup-restore.md)）。

## 授权历史读取与条件恢复（T14）

T14 把 T07 的历史面以**独立的、按授权收口的 API 表面**开放给合作
者：后台历史仍只属于所有者（仪表盘会话），公开可见性与解锁 Cookie
仍不构成任何历史权限。

### `GET /api/v1/shares/:id/revisions`

已授权 Share 的历史元信息分页：只返回版本、捕获时间、来源、主体
类型、恢复来源与清除状态——永不聚合正文。

- **前提**：`share:read` 范围 + 目标 Share 的 read 授权（编辑授权
  蕴含 read）。判定违例与 T12 同族：缺凭据 401；缺范围 403
  `insufficient_scope`；无授权/不存在 404 `share_not_found`（不可区
  分）；publish 授权不蕴含 read，publish-only 授权在此仍是 404。
- **分页**：`limit` 默认 20、上限 100（超限收敛；非整数或小于 1
  返回 400 `invalid_limit`）；`offset` 默认 0（负数或非整数 400
  `invalid_offset`）；按版本号倒序。响应含 `total` 与
  `currentRevision`，每条带 `current` 标记。指针与元信息在仓库层
  以**同一快照**读出（Postgres 为单条语句、内存 Adapter 为同一同
  步步），`current` 标记永不与同响应内的指针自相矛盾。
- **墓碑**：已清除版本仍以元信息列出（`purged: true` 与清除时间），
  响应不含其标题、简介或正文。

### `GET /api/v1/shares/:id/revisions/:revision`

指定版本的完整规范快照（正文、codeType、标题、简介、主题、来源与
恢复来源）：

- 前提同上（read 范围 + read 授权）。版本不存在 404
  `revision_not_found`；已清除返回 410 `revision_unavailable` 并附
  墓碑元信息，永不返回伪造或残缺的快照。
- 响应带该快照**自身**的强 ETag `"content:<Share ID>:<Revision>"`
  （内容家族按其覆盖的版本命名，当前与历史同规则），并支持
  `If-None-Match` 弱比较命中 304；`private, no-store`。

### `POST /api/v1/shares/:id/restore`

把指定版本恢复为当前内容，与后台恢复共用同一个仓库事务（操作台
账、回放先于前置条件判定、相同内容无操作、审计），不另立规则：

- **前提**：凭据须同时持有 `share:read` 与 `share:update` 范围，
  且对目标 Share 持有 update 授权——恢复按内容编辑处理。违例判
  定：缺范围 403；无授权/不存在 404（不可区分）。事务内部以 Key
  行锁复核凭据版本与授权行（先提交的轮换/撤销先行生效），复核在
  回放判定之前——已撤销或已轮换的凭据不能凭旧请求标识回放。
- **请求体（严格、小体积）**：经 16 KB 小请求解析器（超限
  413）；只接受一个字段 `revision`（十进制版本字符串），其他
  字段以 400 `invalid_field` 指名拒绝，缺失 400 `missing_field`。
- **强制条件头**：`If-Match` 必须是**当前**内容 Revision 的强标
  签（缺失 428；过期/弱标签/通配/访问家族标签 412
  `content_conflict`，响应附 `current` 当前快照）；
  `Idempotency-Key` 必填（缺失/格式非法 400）。同标识同输入重放
  原始结果，同标识换来源或换基线 409 `idempotency_conflict`；来
  源版本已清除 410 `revision_unavailable`；恢复结果版本事后被清
  除时，重放因其回执已被清除同事务抹除而返回 410
  `operation_result_unavailable`；维护暂停时（连同重放）503
  `maintenance`。写完后可经 `GET /api/v1/operations/:requestId`
  在本 Key 命名空间内确认（记录在 `key:managed:<Key ID>` 命名空
  间，绝不写入后台命名空间）。
- **语义**：真实恢复写一条新 Revision（`source: "api-restore"`、
  主体类型 `api_key`、`restored_from_revision` 记录来源）；来源与
  当前相同时是无操作成功（`contentChanged: false`），不写
  Revision 但照常记账。恢复**不改变** URL、密码、有效期、
  `access_revision`、Key 授权、发布状态、收藏与浏览量；已下架、
  已过期的 Share 在授权下仍可恢复与读历史（管理授权与公开可见
  性分别判断）。
- **没有 Key 清除入口**：清除历史不存在任何 API 路由，能力文档
  也永不列 purge 操作——清除仍是所有者在后台会话 + CSRF + 版本
  确认下的专属动作（T10）。
- **能力**：`GET /api/v1/capabilities` 在当前凭据持有 read 范围时
  列 `share.history.read` / `share.revision.read`（后者同时进入
  `conditionalReads`，ETag 家族为内容家族）；仅当托管 Key 同时
  持有 read+update 范围时才列 `share.restore` 并在
  `conditionalWrites` 附其 `If-Match` + 幂等键规则。
- **备份覆盖**：恢复操作记录与其它操作记录一样随备份逐行往返；
  恢复演练固件含第三条已提交记录——托管 Key 命名空间内的
  `share.restore`（回执为恢复形状，不含正文），断言精确往返（见
  [备份与恢复手册](backup-restore.md)）。

## 授权下架与重新发布（T15）

T15 启用 `share:publish` 范围与 grant 的 `publish` 权限：后台「API
管理」页现在可分配 `share:publish` 范围（「上下架已授权 Share」），
授权面板新增**上下架授权**选项。publish 是独立权限：编辑授权（read+
update）**不**自动包含它，自动编辑未来新建也永不授 publish；
publish-only 授权**不**蕴含 read——它只能读取受限状态、做条件上下
架，正文、历史与列表元信息都不因此扩权。

### `POST /api/v1/shares/:id/unpublish` 与 `POST /api/v1/shares/:id/republish`

改变指定 Share 的发布状态，与后台下架/重新发布共用同一个仓库事务
（操作台账、访问版本 CAS、无操作判定、审计 `page.publish.update`），
不另立规则：

- **前提**：凭据须持有 `share:publish` 范围，且对目标 Share 持有
  publish 授权。判定违例：缺范围 403 `insufficient_scope`——**编辑
  凭据（read+update 范围与编辑授权）在此同样是 403**，编辑权不蕴
  含上下架权；无 publish 授权/Share 不存在 404 `share_not_found`
  （不可区分）。事务内部以 Key 行锁复核凭据版本与授权行（先提交的
  轮换/撤销先行生效），复核在回放判定之前——已撤销或已轮换的凭据
  不能凭旧请求标识回放自己的旧结果。
- **请求体（严格、小体积）**：端点本身即目标状态，请求体必须为
  空对象（或不带体）；任何字段以 400 `invalid_field` 指名拒绝——
  不能借上下架顺带改密码、有效期或正文。
- **强制条件头**：`If-Match` 必须是当前**状态**表示的强标签
  `"access:<Share ID>:<Access Revision>"`——上下架比较的是状态表
  示，内容标签不能代替访问标签（两族标签不可互换）；缺失 428
  `access_precondition_required`；过期/弱标签/通配/列表/内容家族标
  签/他 Share 标签 412 `access_conflict`，428/412 响应都附当前
  `accessRevision` 与 `accessEtag` 供刷新重试。`Idempotency-Key`
  必填（缺失/格式非法 400 `invalid_idempotency_key`）。同标识同输
  入重放原始结果；同标识换动作（下架↔重新发布）或换基线 409
  `idempotency_conflict`；维护暂停时（连同重放）503 `maintenance`。
  写完后可经 `GET /api/v1/operations/:requestId` 在本 Key 命名空间
  内确认结果。
- **语义（与后台下架完全一致）**：真实切换翻转 `published` 并推进
  `access_revision`——下架与重新发布都使先前签发的解锁 Cookie 立
  即失效，重新发布不复活旧 Cookie；密码、有效期、内容 Revision、
  历史、收藏与原 URL 一概不变，已过期仍按原有效期过期（重新发布
  不延长）。已是目标状态时是无操作成功（`changed: false`，不推进
  访问版本、不写审计），但照常记账、可以重放与确认。状态操作记
  录的回执只含状态字段（published/changed/访问版本），不含任何正
  文派生数据，因此事后清除某内容版本**不会**抹除它——已提交的上
  下架结果在内容清除后仍可按请求标识确认。
- **publish-only 的可见面**：状态 GET（`GET /api/v1/shares/:id/state`）
  只返回 published、isProtected、expiresAt、accessRevision 四项，
  对所有获授权调用者响应一致；列表中 publish-only 条目的标题/描
  述/主题被中性化置空；正文、单版快照、历史列表全部 403/404，不
  因 publish 扩权。
- **能力**：`GET /api/v1/capabilities` 仅当当前凭据为托管 Key 且持
  有 `share:publish` 范围时才列 `share.unpublish` / `share.republish`
  并在 `conditionalWrites` 附其 `If-Match`（状态家族）+ 幂等键规
  则；只持有编辑范围的凭据不列，legacy 凭据不列。
- **备份覆盖**：授权摘要逐条覆盖 `can_publish`，状态操作记录与其
  它操作记录一样随备份逐行往返；恢复演练固件含 publish 授权与托
  管 Key 命名空间内的 `share.unpublish` 记录，并对 `can_publish`
  做篡改判失败（见 [备份与恢复手册](backup-restore.md)）。
