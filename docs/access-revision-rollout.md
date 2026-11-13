# Access Revision 上线与回滚说明（T01 / Issue #25）

## 机制

- 每个 Share 新增 `access_revision`（数据库 `BIGINT`，JSON 中为十进制字符串），初始为 `1`，由迁移 `004_page_access_revision.sql` 引入；存量 Share 回填为 `1`。
- 签名访问 Cookie（`page_access_<id>`，24 小时 TTL 不变）同时绑定 Share ID 与签发时的 `access_revision`。T01 上线前签发的无版本 Cookie 一律失效，访客重新输入密码即可。
- 以下操作会原子推进 `access_revision`，从而立即撤销此前签发的所有访问 Cookie：
  - 设置、更换或取消 Share 密码（含原有保护入口 `POST /api/pages/:id/protect`）；
  - 有效期改变（后台 `PUT /admin/pages/:id`）；
  - 后台主动撤销入口 `POST /admin/pages/:id/revoke-access`；
  - 下架与重新发布（T11，`POST /admin/pages/:id/publish-state`）：状态翻转与版本推进同写，两次翻转都撤销旧 Cookie，重新发布不会让下架前的 Cookie 复活。
- 正文与收藏变化不推进访问版本。把发布状态设为它已经所处的状态不改变任何策略，因此不推进访问版本（父规格 §4）。
- 后台保护设置与原有保护入口必须提交 `expectedAccessRevision`：缺失返回 `428`，与当前版本不一致返回 `412`，服务端不会自动填充最新版本。保存失败时后台表单保留输入。
- 密码校验使用与密码 hash 同次读取到的访问版本签发 Cookie；校验期间发生策略轮换时，签发的仍是旧版本 Cookie，随后自然失效。
- 浏览事件（`POST /view/:id/view-event`）以带 `access_revision` 条件的单条 UPDATE 计数，成功路径不额外读取正文；`GET /view/:id` 保持只读。

## 上线顺序

1. 备份数据库（遵循父规格的备份与写维护门槛；生产切换需要另行明确指令，本票不执行生产迁移或部署）。
2. 运行 `npm run db:migrate` 应用 `004`（可重复运行，已应用时跳过）。
3. 部署包含访问版本校验的代码。迁移与代码必须同批上线：旧代码忽略 `access_revision` 列可以运行，但不具备撤销语义。

## 发布状态与访问版本（T11 / Issue #35）

- `pages.published`（迁移 `007`，`BOOLEAN NOT NULL DEFAULT TRUE`）记录发布状态；T11 起后台可经 `POST /admin/pages/:id/publish-state` 下架与重新发布（仅后台会话 + CSRF，无 API Key 入口）。下架/重新发布不删除 Share、不动正文与历史版本、不自动移除密码、不延长有效期。
- 公开面判定顺序统一（父规格 §5）：不存在、已删除或已下架 → 404（下架先于有效期判定）；已发布但已过期 → 410；已发布未过期但未解锁 → 中性密码页或该接口的 403。下架对所有公开入口一致：正文页、元数据接口、密码校验与浏览计数全部按不存在处理，即使请求带有当前访问 Cookie 或原密码。
- 浏览事件的条件 UPDATE 同时校验 `published`：下架期间的浏览不计数，已有计数与近似统计口径保持不变。
- 所有者后台对已下架/已过期 Share 保持完整管理能力：查看、编辑、恢复历史版本、收藏与本状态操作本身都不受发布状态影响。
- 状态操作与 T08/T09 使用同一操作协议：请求标识（后台命名空间）+ 摘要 + 回执与状态变更、审计（`page.publish.update`）同事务提交；响应丢失可用同一请求标识经 `GET /admin/operations/:requestId` 确认或直接重试重放。把状态设为当前值返回 unchanged success 并留回执，但不推进访问版本、不写变更审计。
- 备份核对逐条记录 `published` 精确值：恢复侧翻转任何一条的发布状态会被核对以 `published drift` 明确判失败；`page.publish.update` 审计在核对报告中列为发布状态变更事件（它推进访问版本，属于撤销类事件）。

## 回滚红线

- **禁止回滚到忽略访问版本的旧代码。** 旧代码会重新接受已被撤销的访问 Cookie，等于撤销失效，与票据验收标准冲突。
- **禁止回滚到忽略 `published` 的旧代码。** 旧代码会把已下架 Share 重新公开，与下架语义冲突；回滚目标必须同时校验 `access_revision` 与 `published`。
- 如需回滚，只能回滚到另一个同样校验 `access_revision` 的版本；`access_revision` 列保留不删（删列会销毁撤销状态）。
- 回滚后已推进的访问版本保持单调递增，不重置为 `1`。
