# Access Revision 上线与回滚说明（T01 / Issue #25）

## 机制

- 每个 Share 新增 `access_revision`（数据库 `BIGINT`，JSON 中为十进制字符串），初始为 `1`，由迁移 `004_page_access_revision.sql` 引入；存量 Share 回填为 `1`。
- 签名访问 Cookie（`page_access_<id>`，24 小时 TTL 不变）同时绑定 Share ID 与签发时的 `access_revision`。T01 上线前签发的无版本 Cookie 一律失效，访客重新输入密码即可。
- 以下操作会原子推进 `access_revision`，从而立即撤销此前签发的所有访问 Cookie：
  - 设置、更换或取消 Share 密码（含原有保护入口 `POST /api/pages/:id/protect`）；
  - 有效期改变（后台 `PUT /admin/pages/:id`）；
  - 后台主动撤销入口 `POST /admin/pages/:id/revoke-access`。
- 正文与收藏变化不推进访问版本。
- 后台保护设置与原有保护入口必须提交 `expectedAccessRevision`：缺失返回 `428`，与当前版本不一致返回 `412`，服务端不会自动填充最新版本。保存失败时后台表单保留输入。
- 密码校验使用与密码 hash 同次读取到的访问版本签发 Cookie；校验期间发生策略轮换时，签发的仍是旧版本 Cookie，随后自然失效。
- 浏览事件（`POST /view/:id/view-event`）以带 `access_revision` 条件的单条 UPDATE 计数，成功路径不额外读取正文；`GET /view/:id` 保持只读。

## 上线顺序

1. 备份数据库（遵循父规格的备份与写维护门槛；生产切换需要另行明确指令，本票不执行生产迁移或部署）。
2. 运行 `npm run db:migrate` 应用 `004`（可重复运行，已应用时跳过）。
3. 部署包含访问版本校验的代码。迁移与代码必须同批上线：旧代码忽略 `access_revision` 列可以运行，但不具备撤销语义。

## 回滚红线

- **禁止回滚到忽略访问版本的旧代码。** 旧代码会重新接受已被撤销的访问 Cookie，等于撤销失效，与票据验收标准冲突。
- 如需回滚，只能回滚到另一个同样校验 `access_revision` 的版本；`access_revision` 列保留不删（删列会销毁撤销状态）。
- 回滚后已推进的访问版本保持单调递增，不重置为 `1`。
