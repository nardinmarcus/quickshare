# 发布操作：幂等创建与结果确认（T08）

创建 Share 的响应可能丢失（网络中断、超时、客户端崩溃）。在没有请求
标识的世界里，客户端无法区分「请求没到」与「已创建但响应丢了」：重试
可能造出两个 Share，不重试可能丢掉已经生成的一次性密码。本手册描述
QuickShare 的处理方式：带请求标识的创建可确认、可安全重试；真正新的
发布意图——哪怕正文完全相同——仍然创建新的 Share。

## 请求标识与命名空间

- 客户端为每次发布意图生成一个请求标识：UUID v4。服务端接受
  16–128 个字符、字符集 `[A-Za-z0-9_-]`；其他格式返回 400
  `invalid_idempotency_key`。
- 标识只在**凭据命名空间**内唯一。服务端按调用方派生命名空间，客户
  端不能自选：
  - 托管 Key：`key:managed:<Key ID>`（逻辑身份，与 secret 无关——轮换
    后新 secret 仍能确认轮换前提交的操作；Key 被撤销/删除后不能再
    重放其操作）；
  - 旧版环境 Key：`key:legacy:<凭据指纹>`；
  - 后台会话（克隆）：`session:dashboard-owner`；
  - 首页已登录所有者：`session:browser-owner`；
  - 首页匿名发布：`session:publish:<发布会话指纹>`。发布会话是服务端
    签发的签名 Cookie（24 小时），页面只暴露其命名空间的短指纹 tag，
    不暴露会话值本身。
- 请求标识本身不是凭据：它不能读取 Share 密码、不能管理 Share、
  不能代替任何 Key 或会话授权。匿名发布会话同样只提供去重作用域，
  不授予任何管理或 Key-only 权限。

## 请求摘要与固定处理顺序

服务端对每次带标识的创建计算请求摘要：用应用 secret 对
`{动作, 目标, 字段存在性, 规范化输入}` 做 HMAC。摘要在随机 Share
ID、自动生成密码、自动标题的时间部分等派生值产生**之前**计算，因
此重试必然得到相同摘要。摘要输入不落库明文；正文与密码从不写入
操作记录（密码只作为 HMAC 输入）。

处理顺序固定：

1. 请求标识与正文的**纯格式校验**（不查数据库）；
2. 身份与权限校验（含写事务内的凭据版本复核）；
3. 写维护闸（T04）；
4. 凭据命名空间内的同标识**结果查询**：
   - 命中且摘要一致 → 直接返回已提交结果，不再做有效期、`If-Match`
     等时效校验——已过期 Share 的创建操作仍然可以确认；
   - 命中但摘要不同 → 409 `idempotency_conflict`，不创建、不返回旧
     结果的敏感字段；
   - 结果已删除/不可用 → 410 `operation_result_unavailable`，且不会
     借重试复活或另建 Share；
   - 未命中 → 才执行版本/时效校验与实际创建。内容无变化的成功同样
     记录结果；
5. 创建、内容 Revision 1 快照、`page.create` 审计与操作记录在**同一
   事务**内提交；不落任何长期 `running` 状态——崩溃只会留下「没有记
   录」，不会留下假 pending。

唯一性最终由数据库主键 `(actor_namespace, request_id)` 保证；同一
标识的并发提交由事务级咨询锁串行化（内存 Adapter 用等价的
per-标识互斥），两个并发的相同创建只产生一个 Share。锁顺序固定为
维护闸 → 托管 Key → 请求标识 → Share（克隆时源行 `FOR UPDATE`）。

## 原始结果回放与敏感字段

操作记录保存一份**受保护回执**：创建响应字段（Share ID、生成的密
码、保护状态、类型、标题、描述、有效期、主题、内容 Revision 与
ETag），用既有 secret 加密机制（`secret-v1`）整体加密，不存正文。

重放返回的是**原始回执**，不是 Share 的当前状态——所有者后来改过的
标题/描述不会串进重放响应。重放前复核当前状态：

- 结果 Share 已删除 → 记录在同一删除事务里转为墓碑（回执清空、
  状态 `result_unavailable`），重放与确认只会得到「操作发生过、结果
  不可用」，绝不复活；
- 该版本的内容快照已不存在（历史被单独清理）→ 不再返回该版本的标
  题、描述与密码，只返回标识信息；
- 访问策略已变更（密码被改、保护被关、访问 Revision 已推进）→ 生
  成密码**不再回显**；策略未动过才按原样返回。
- 已提交记录没有保留期限，不做自动清理；删除后的墓碑是无正文的
  去重记录，长期保留。

## 操作状态确认

- `GET /api/v1/operations/:requestId`（需 Key）：只查调用方自己的凭
  据命名空间，返回 `status`（`committed` / `result_unavailable`）、
  Share ID、内容 Revision、访问 Revision 与时间。永不返回密码、标
  题、描述或正文。该接口是读操作，写维护暂停期间仍可确认；它属于
  create 能力，不是 Share 管理授权。查不到返回 404
  `operation_not_found`，标识格式非法返回 400 `invalid_request_id`。
- `GET /admin/operations/:requestId`（需后台会话）：所有者跨命名空间
  按标识确认，只报告行为方**种类**与同样的受限标识字段。

## 各入口的行为

- **API 创建** `POST /api/v1/share`：带 `Idempotency-Key` 时按上文幂
  等；响应多 `requestId`，重放另有 `replayed: true`。**不带头时保持
  历史行为**（HTTP 200、原字段），且不是幂等创建。
- **首页创建** `POST /api/pages/create`：网页客户端为每次发布意图生
  成 UUID 并持久化一个待确认意图 `{requestId, draftKey, sessionTag}`
  （localStorage，只存指纹与标识，不存正文/密码）：
  - 同草稿 + 同发布会话 → 沿用同一标识重试；本地的到期时间校验不会
    抢先拦截重试（已提交但已过期的创建仍可确认）；
  - 草稿已改 → 在同会话内点「发布」即视为明确的新发布意图，轮换
    标识；
  - 发布会话已轮换（tag 不同）→ 待确认意图成为孤儿，页面给出明确
    二选一：放弃旧记录按新发布提交，或取消；绝不静默跨会话认领；
  - 服务端 409 → 客户端轮换标识并给出可见提示；成功（或「继续发
    布」重置表单）后清除待确认意图；其他失败保留意图以便安全重试。
- **后台克隆** `POST /admin/pages/:id/clone`：表单带持久化的
  per-target 请求标识（隐藏 `requestId` 字段或 `Idempotency-Key`
  头），未知结果时重提只回到同一个克隆；服务端在成功响应（含重放）
  时设置 `clone_intent_done` Cookie，客户端据此退役该意图（包括从
  浏览器前进/后退缓存恢复页面时）。

## 与既有机制的关系

- 写维护（T04）：带标识的创建仍是发布写，过闸执行；暂停时返回 503
  `maintenance`（可重试），不落任何 pending 记录，恢复后同一标识可
  继续。操作状态确认是读，不受闸影响。
- 凭据版本（T05）：托管 Key 的写事务复核在锁序中位于维护闸之后、
  请求标识锁之前；轮换不改变逻辑命名空间。
- 内容 Revision（T06）：创建的 Revision 1 基线与操作记录同事务提
  交；回执中的 `contentRevision` / `contentEtag` 与 T06 的强 ETag 家
  族一致，访问修订（T01）是另一个独立家族，回执单独记录
  `accessRevision`。
- 备份（T03）：`publish_operations` 纳入完整备份的快照与逐行摘要
  （回执密文按摘要处理，manifest 不含密文与明文），恢复核对逐行比
  对；演练覆盖其精确往返与墓碑翻转篡改拒绝。

## 后台内容保存与历史恢复（T09）

同一套操作账本在 T09 扩展到后台会话命名空间
（`session:dashboard-owner`）的两个新动作，复用 `publish_operations`
表与摘要/回执机制，不新增表：

- `share.content.update`：`PUT /admin/pages/:id` 带 `Idempotency-Key`
  头（UUID v4；16–128 字符，`[A-Za-z0-9_-]`，格式非法 400
  `invalid_idempotency_key`，绝不静默降级为普通保存）。无头时保持
  T01/T06 的既有行为不变。
- `share.restore`：`POST /admin/pages/:id/revisions/:revision/restore`
  （后台会话 + CSRF），标识可经 `Idempotency-Key` 头或请求体
  `requestId` 字段提供；版本条件经 `If-Match` 给出（缺失 428
  `content_precondition_required`，过期/不匹配 412
  `content_conflict` 并返回当前版本）。

**摘要**沿用 §8 规则：动作、目标 Share、双版本期望（内容
If-Match 与访问 `expectedAccessRevision`，含畸形 If-Match 的原始
字面值）、字段存在性与规范化输入值。摘要只由**请求本身**计算——不
依赖派生值（密码哈希、自动生成密码）与当前状态，因此重试必然同摘
要，且重试不会把「当前」的期望误当作原始期望。

**处理顺序**与创建一致：纯格式校验（标识、密码格式、期望版本格
式）→ 身份/权限 → 写维护闸（T04；暂停时 503 `maintenance`，连重放
也拒绝，结果经操作查询确认）→ **操作结果查询先于一切版本比较**：
命中且摘要一致直接返回已提交结果——哪怕当初的 If-Match 早已过
期，也不会被误报为 412；摘要不同 409 `idempotency_conflict`；结果
Share 已删除 410 `operation_result_unavailable`。未命中才在同一事
务内依次做：访问前置条件 → 内容前置条件 → 内容投影与快照 → 审计
→ 操作记录。**操作记录只在成功时写入**：首次尝试以
401/403/409/410/412/428 失败不占用标识，后续同标识重试按新请求执
行（已提交结果必先被命中这一前提只对成功成立）。内容无变化的成
功（含恢复到与当前相同的内容）同样记账，但不产生新 Revision。

**回执**只含标识与版本信息：保存回执为动作种类、Share ID、是否变
更与结果内容/访问 Revision；恢复回执额外含来源 Revision 与恢复前
的当前 Revision。回执**从不**含正文、密码或任何秘密——重放因此直
接返回回执字段。`GET /admin/operations/:requestId` 可确认这两种新
动作（动作名与结果版本照常报告）；API Key 的 capabilities 不因此
扩张——保存/恢复是后台会话操作，不是 Key 的管理能力。

**恢复语义**：来源快照的内容字段（正文、类型、标题、描述、主题）
被写为一条**新的** Revision（`source: 'admin-restore'`，
`restored_from_revision` 记录来源），历史本身永不改写；来源快照不
存在返回 404 `revision_not_found`，内容已被清除（清除后的墓碑）返
回 410 `revision_unavailable` 且永不作为有效恢复来源。恢复在内容写
事务内完成（过维护闸、锁当前行、确保基线后读来源），与并发内容更
新竞争同一期望版本时只有一个成功，失败方得到 412 并看到当前版
本。恢复**不改变** URL、密码、有效期、`access_revision`、Key 授
权、发布状态、收藏与浏览量。后台页面为内容保存与恢复各保留一个
待确认意图（sessionStorage，只存标识与草稿指纹/期望版本，不存正
文）：同草稿同基线（恢复为同来源同基线）重试沿用同一标识；错误状
态永不自动重试、永不自动换基线；409 时清除意图并提示，成功后清
除。

## 下架与重新发布（T11）

后台下架/重新发布（`POST /admin/pages/:id/publish-state`，仅后台会
话 + CSRF）与保存/恢复同属后台命名空间的操作：动作名为
`share.unpublish` / `share.republish`，摘要绑定目标状态与
`expectedAccessRevision`，回执为 `{kind, shareId, published, changed,
accessRevision}`（无任何秘密材料）。真实翻转推进 `access_revision`
并与 `page.publish.update` 审计、操作记录同事务提交；把状态设为当
前值是不推进任何版本的 unchanged 成功，同样留记录与回执。响应丢
失时经 `GET /admin/operations/:requestId` 按原标识确认，或以同一标
识、同一前置条件重试直接重放回执——重放先于前置条件判定，因此重
试时版本已推进也不会误报 412。

## API 授权内容更新（T13）

`PUT /api/v1/shares/:id/content`（见
[API 身份与能力发现](api-capabilities.md) 的 T13 一节）不是第二套
编辑规则：它调用与后台保存同一个仓库操作
（`saveContentIdempotent`），动作名 `share.content.update`，命名空间
为凭据自己的 `key:managed:<Key ID>`，摘要绑定归一化后的四字段正文
候选与基线内容版本，回执为 `{kind, shareId, contentChanged,
contentRevision, accessRevision}`。因此无操作判定、Revision 写入、
`page.content.update` 审计与版本推进与后台完全一致，两个入口在同
一基线上并发时只有一个提交成功，另一个得到内容冲突。

与后台入口的差别只在授权复核的位置：API 调用在仓库事务内、操作
查找与前置条件判定**之前**，先以 Key 行锁复核凭据版本，再复核
grant 行仍持有 update 权限。于是先提交的轮换/撤销能拒绝在途写，
而已提交操作也不能被已撤销的凭据凭请求标识回放——这与父规格 #24
§8「回放前先复核凭据与授权」的顺序一致。凭据命名空间隔离照旧：
确认与重放都只认本 Key 命名空间内的记录。

同一票的自动编辑授权也走创建事务本身：Key 开启
`auto_grant_new_share_edit` 后，其新建 Share 的 read/update 授权在
创建事务内、快照写入之后插入（普通创建与幂等创建共用），与 Share
行、Revision 与操作记录同成同败；幂等重放不进入首次执行路径，因
此不产生重复授权。

## 历史清除与回执（T10）

所有者在后台永久清除某个非当前 Revision（见
[Content Revision 上线说明](content-revision-rollout.md) 的清除合
同）时，同一事务还会处理操作账本：**结果恰好是被清除版本的已提
交记录（任意凭据命名空间）的加密回执被一并清空**——回执正是能重
新吐出该版本标题、描述与生成密码的可恢复密文，留着它清除就没
有意义。记录本身保留为 `committed`：操作状态确认照常只报标识
（Share ID、结果版本、时间），而原始请求重放因回执缺失返回 410
`operation_result_unavailable`，绝不复活已清除内容。作为第二道防
线，重放时的版本存续判断只认仍带正文的快照行——墓碑行不算存
续，因此即使某条回执未被清掉（如人工干预后的数据），重放也只
会扣下该版本的标题、描述与密码。清除不写操作记录、不用幂等标
识：对同一版本重复清除是无副作用的成功（`alreadyPurged`）。
