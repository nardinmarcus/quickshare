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
ID、体积限制与条件写规则。当前阶段两类凭据均为 **create-only**：唯一写
操作是 `POST /api/v1/share` 创建 Share；能力响应只列这一个写操作，不会
提前宣称尚未实现的管理操作。后续票加入 scopes/grants 与管理接口时，
在此定义上扩展。

要点：

- `contentTypes`：`html`、`markdown`、`svg`、`mermaid`，与创建路由接受
  的集合逐字一致。
- `markdownThemePresets`：实例真实存在的 12 个 Preset ID。
- `limits.shareRequestBodyBytes`：由实例配置 `SHARE_BODY_LIMIT` 换算的
  真实字节上限（默认 `2mb` = 2097152）。
- `conditionalWrites`：创建目前不要求 `If-Match` 或幂等键；但写操作经过
  写维护闸（暂停时 503 `maintenance`），且托管 Key 写会在事务内复核凭据
  版本（见下）。

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
