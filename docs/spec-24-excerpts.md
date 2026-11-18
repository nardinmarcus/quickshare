# Parent Spec #24 关键语义摘录

> **来源**：GitHub Issue #24《[Spec] Share 持续管理：版本、授权与安全更新》
> https://github.com/nardinmarcus/quickshare/issues/24
> **摘录日期**：2026-11-18
> **声明**：本文件只是离线摘录，**原文为准**。规格更新以 Issue #24 为唯一真值；
> 若本文件与 Issue 不一致，以 Issue 为准并同步更新本文件。

代码注释反复引用 parent spec #24 的 §3–§8 与 §11（`app.js`、`models/` 中
的判错规则出处）。本文件摘录这七节的原文，供离线或无 GitHub 权限时查阅。
未摘录的部分（Problem Statement、User Stories、§1/§2/§9/§10/§12、
Testing Decisions、Out of Scope、Further Notes）请回 Issue 原文阅读。

章节索引：

- §3 数据模型与单一当前状态
- §4 内容版本与访问版本分别比较（If-Match / ETag 判错）
- §5 访问撤销与公开投影
- §6 权限矩阵与 Key 生命周期（scope 与 grant 合取）
- §7 API 合同（状态码语义）
- §8 请求幂等、状态确认与事务顺序（幂等与重放判错）
- §11 备份、迁移与安全回滚（发布门与写维护）

---

### 3. 数据模型与单一当前状态

新增数据语义如下；名称是规格约束，迁移编号按交付时已有序列递增。

| 对象 | 字段与约束 |
| --- | --- |
| Share 当前状态 | `current_revision` 为每个 Share 单调递增的正整数；`access_revision` 初始为 1；`published` 初始为 true。旧的正文与呈现字段保留为当前 Revision 的物化投影，不能作为第二套独立真相 |
| Share Revision | `(share_id, revision)` 唯一；正文、codeType、title、description、markdownTheme、snapshot hash、创建时间、操作身份/来源、可空恢复来源。快照不可修改，清除是显式例外 |
| Revision 墓碑 | 保留 Share ID、版本号、时间、动作身份、恢复来源和清除时间；移除正文、标题、简介、主题快照及可恢复的响应密文，不允许从墓碑恢复 |
| Managed Key | 保留现有 ID、hash、前缀和最近使用时间；新增 `credential_version`、scopes 和 `auto_grant_new_share_edit`，自动授权默认 false |
| Share Grant | `(api_key_id, share_id)` 唯一；read/update/publish 三种资源权限；update 必须包含 read，publish 不自动包含 read |
| 发布操作记录 | `(actor_namespace, request_id)` 唯一；动作、目标、规范化请求 HMAC、操作结果标识、结果 Revision、结果访问版本、时间及必要的受保护回执。无独立后台任务或长期 running 状态 |
| 写维护开关 | 复用站点设置存储 `publishing_writes_paused`，默认 false，由受控运维方式设置，不增加普通用户设置项 |

数字版本在 JSON 中以十进制字符串传输，避免长期增长超出 JavaScript 安全整数；数据库使用 BIGINT。创建初始化内容 Revision 1，访问 Revision 1。

当前内容、快照、审计和去重结果在同一事务中提交。公开正文正常读取当前物化投影，不扫描历史；列表不读取历史正文。旧 Share 的基线保持原 ID、原 URL 和原始正文，不从已有审计猜测或伪造更早历史。

Share 的 codeType 在本里程碑中创建后不转换，延续现有后台编辑能力；它进入快照与摘要，但新内容更新接口拒绝不一致的 codeType。新增跨类型转换不是本规格的隐含功能。

历史不自动按时间或数量删除。整份 Share 永久删除时清除关联内容、版本载荷和 grants，保留不含内容的操作/删除墓碑，防止延迟重试重建同一操作的结果。

---

### 4. 内容版本与访问版本分别比较

内容快照包括正文、标题、简介、codeType 和 Markdown Theme Preset。密码、有效期、发布状态、收藏、浏览量及 Key 授权均不属于正文快照。

内容 GET 返回强 ETag，格式为 `"content:<Share ID>:<Revision>"`。状态 GET 返回独立强 ETag，格式为 `"access:<Share ID>:<Access Revision>"`。对应响应只包含该标签覆盖的稳定字段，不把动态服务器时间、浏览量、临时请求 ID 混入有该强标签的正文。个性化管理响应使用 private/no-store，不建立共享正文缓存。

内容写入要求一个具体内容标签；访问状态写入要求一个具体访问标签。拒绝通配符标签和标签列表，不让 `If-Match: *` 绕过版本条件；弱标签不匹配。缺少前置条件 428，已过期前置条件 412。

后台内容和访问设置分别保存。兼容旧后台组合更新路由时，若同时提交两类字段，须同时携带内容 If-Match 和 `expectedAccessRevision`，任一不符整笔拒绝。不得替旧缓存页面填入最新版本后保存；提示刷新且保留待提交稿。

相同快照返回 `changed:false`，不增加 Revision；状态和策略完全不变时同样不增加访问版本。显式提交密码设置按一次访问策略更新处理，不依赖比较随机盐 hash 判断密码是否真的相同。

---

### 5. 访问撤销与公开投影

访问 Cookie 继续使用现有签名和 24 小时 TTL，新增 Share ID＋accessRevision 绑定。旧无版本 Cookie 切换后不再接受。密码设置/更换/取消、有效期改变、主动撤销已解锁访问、下架和重新发布均推进访问版本；普通正文更新不推进。

密码验证基于读取到的保护 hash 和访问版本签发 Cookie；如果期间策略改变，该旧版本 Cookie 随后自然无效，不能在验证旧密码后另取最新版本签发。

公开入口按同一顺序判断：不存在/已删除/下架为 404；已发布但过期为 410；受保护但无有效访问凭证显示中性密码页或接口 403；有效访问才返回内容。下架/过期错误均无正文衍生元信息。撤销成功后的新请求必须使用新策略；已经在撤销前获得授权并开始返回的响应不宣称可以追回。

密码页、公开元信息、页面标题和 OG 使用统一保护判断；未解锁只展示“受保护内容”和站点通用图，不含真实标题、简介、正文片段或历史。公开 Share 的正常元信息不变。既有第三方缓存无法保证收回，但所有新响应必须遵守最新策略。

浏览事件用带 published、expiry 与 accessRevision 条件的数据库 UPDATE 判断并计数。正常成功路径不增加正文查询；拒绝路径仅可读取必要状态分类。GET 查看仍只读。

---

### 6. 权限矩阵与 Key 生命周期

操作权限使用 scopes：`share:create`、`share:read`、`share:update`、`share:publish`。管理指定 Share 还需对应资源 grant；不能仅凭全局 scope 读取任意 Share。`share:update` 需要 read scope 和 read/update grant，恢复按内容编辑处理。

| 身份/授权 | 创建 | 正文与历史 | 更新/恢复 | 下架/重新发布 | 密码/有效期后续管理 | 清除历史 |
| --- | --- | --- | --- | --- | --- | --- |
| 所有者后台＋CSRF | 现有流程 | 全部 | 全部 | 全部 | 全部 | 后台确认 |
| 前端发布会话 | 保留既有行为 | 不新增管理权 | 不新增 | 不新增 | 保留既有所有者入口，但纳入访问版本条件 | 不可 |
| legacy 环境变量 Key | 是 | 否 | 否 | 否 | 否 | 否 |
| 既有 managed Key | 原创建权 | 默认否 | 默认否 | 默认否 | 否 | 否 |
| managed read grant＋scope | 由 create scope 决定 | 指定 Share | 否 | 否 | 否 | 否 |
| managed edit grant＋scopes | 由 create scope 决定 | 指定 Share | 指定 Share | 除非另授 publish | 否 | 否 |
| managed publish grant＋scope | 由 create scope 决定 | 不因此获得 | 不因此获得 | 指定 Share | 否 | 否 |

只有发布状态权限时，可读取所授权 Share 的 ID、published、isProtected、expiresAt、accessRevision，不返回标题、简介、正文或历史。状态 GET 的稳定响应对所有获授权调用者一致。

既有 managed Key 迁移为 create-only。legacy Key 继续兼容创建，需要管理能力时由所有者使用 managed Key，不给环境变量 Key 配全局管理权。公开元信息和解锁 Cookie 都不授权源内容管理或历史读取。

所有者可在具名 Key 后台选择具体 Share 与权限。自动编辑新 Share 的选项要求 read/update scopes；创建事务同时添加该 Share 的 read/update grants，不添加 publish。选项仅影响启用后的新建，不追溯历史。

轮换保留逻辑 Key ID 与 grants，替换 secret/hash 并推进 credentialVersion。管理请求开始时记录验证过的版本，提交时在数据库锁内复核；旧 secret 即使在轮换前通过了第一次 hash 检查，也不能在轮换已先提交后继续写入。撤销/授权变更采用同一 Key 行锁纪律。

缺失/无效凭据 401；缺少某类操作 scope 为 403；有操作 scope 但目标没有 grant 时统一 404，不用于探测实例资源。所有者和授权管理者可在过期/下架状态下读取获授权正文，管理访问与公开可见性分别判断。

---

### 7. API 合同

保留 `POST /api/v1/share` 的成功状态 200 与已有响应字段；旧创建客户端不强制传幂等标识，其行为不被宣称为自动去重。新客户端必须使用请求标识。现有首页创建与克隆也写入基线 Revision；升级后的浏览器创建操作采用相同去重规则。

新增管理接口如下，全部要求 managed Key 及相应权限；身份/能力查询也允许 legacy Key 查看自身的 create-only 能力。

| 接口 | 请求与结果 | 权限/前置条件 |
| --- | --- | --- |
| `GET /api/v1/me` | 实例规范 origin、凭据类型、Key ID/name、scopes；不返回 secret/hash | 有效 Key |
| `GET /api/v1/capabilities` | 协议版本、内容类型、Preset ID、真实体积限制、可用操作和条件写规则 | 有效 Key；不泄漏其他资源 |
| `GET /api/v1/shares` | 已授权资源分页清单，默认 20、最大 100；按创建时间与 ID 稳定游标排序 | 按 grants 过滤；无 read 时元信息中性化 |
| `GET /api/v1/shares/:id/content` | Share ID、Revision、htmlContent、codeType、title、description、markdownTheme；内容 ETag | read scope＋grant |
| `PUT /api/v1/shares/:id/content` | 完整快照替换；htmlContent、title、description、markdownTheme 四字段必填，codeType 可提交但必须不变；返回新版本/unchanged | read/update＋具体内容 If-Match＋请求标识 |
| `GET /api/v1/shares/:id/revisions` | 分页历史元信息，默认 20、最大 100；包含清除墓碑但不聚合正文 | read |
| `GET /api/v1/shares/:id/revisions/:revision` | 指定完整快照；已清除返回 410 | read |
| `POST /api/v1/shares/:id/restore` | revision 字段指定来源；产生新的当前 Revision，或相同快照时 unchanged | read/update＋当前内容 If-Match＋请求标识 |
| `GET /api/v1/shares/:id/state` | published、isProtected、expiresAt、accessRevision 及状态 ETag | 匹配的 read 或 publish 权限 |
| `POST /api/v1/shares/:id/unpublish` | 下架；返回状态、changed 与新访问版本 | publish＋当前状态 If-Match＋请求标识 |
| `POST /api/v1/shares/:id/republish` | 重新发布；不改密码/有效期 | publish＋当前状态 If-Match＋请求标识 |
| `GET /api/v1/operations/:requestId` | 当前凭据命名空间内的已提交操作状态和受限回执；不返回请求正文 | 当前有效凭据及原操作仍需的权限 |

restore 的 If-Match 明确比较该 Share 的当前内容表示；上下架比较该 Share 的状态表示。两个操作族的标签不可互换。PUT 内容不接受访问策略、收藏或浏览量字段，避免被忽略的敏感字段使调用者误以为设置成功。

正文保持原始字符，校验非空但不重排或修剪正文；元字段沿用既有规范化规则。新内容更新对未知 Markdown Preset 返回 400，不静默更换；非 Markdown 的 markdownTheme 为 null。创建接口原有自动识别和缺省行为保持。

有 read grant 的列表才显示标题/简介；不返回密码、加密密码、授权表或 Favorite Share。列表 cursor 不携带 secret，非法 cursor 返回 400，不接受 SQL 排序片段。

统一保留 success/error，同时新增稳定 code、requestId、retryable；错误不带未授权数据。400 为输入格式/字段错误，401 未认证，403 操作权限不足，404 无资源访问权/不存在，409 请求标识复用不同 payload 或不能清除当前版本，410 已清除或已删除结果，412 版本冲突，413 体积超限，428 缺前置条件，503 数据库/写维护暂不可用。

---

### 8. 请求幂等、状态确认与事务顺序

采用 `Idempotency-Key` 请求头，客户端生成 UUID v4。服务端接受 16–128 个允许的 ASCII 字母、数字、短横线或下划线，拒绝其他值。新管理写接口必须带该头；兼容创建允许不带，但新 CLI/网页必须发送。

同一明确动作使用同一 requestId；新的明确“发布”产生新 requestId。相同内容不是去重键；请求命名空间由身份类型和稳定凭据身份决定，不能在 Key 之间复用回执。后台基于签名会话命名空间；legacy Key 使用不可逆凭据指纹隔离轮换前后。

请求摘要使用现有应用 secret 派生的 HMAC，对动作、目标、预期版本、字段存在性与规范化输入计算；不得存明文请求正文/密码。时间、随机 ID、自动密码和自动标题的时间部分在摘要后生成，避免一次操作重试被认为不同。

顺序固定：基本格式校验 → 当前身份/权限 → 事务锁与凭据复核 → 查找同请求结果。命中且摘要相同则返回已提交结果，不再用旧 If-Match 重做写入；未命中才比较版本、执行时效校验与变更。已成功请求的 expiresAt 如今已过期，不应被重新当成“从未成功”的创建请求。

同请求不同摘要为 409；无变化也记录成功操作结果但不制造新正文版本。事务提交时请求记录与结果一起可见，不提交长期 running 记录；因此进程崩溃不会留下需要后台猜测接管的发布任务。查询不到请求时，只能用原 requestId/原输入重试，不能据此换 requestId。

每个事务使用同一 node-postgres client。锁定顺序固定为维护闸、managed Key、请求标识对应的事务锁、按 ID 排序的 Share，再读写 Revision 与授权；授权/撤销操作同样先锁 Key 后锁 Share。只在确有多对象操作时排序，不增加全实例写锁。锁等待超时/死锁返回可恢复的 503；客户端仍用原 requestId 处理，不在服务端盲目循环重试。

请求唯一约束是最终去重依据。Share 物化投影、Revision、必要审计、自动 grant 与请求结果同事务提交；任何一步失败不得留下半提交状态。

回执仅包含对应动作返回所必需的字段，无正文；需要重放自动生成密码等敏感创建结果时使用现有加密能力。重放前重新确认权限、Share/Revision 存在性和相关访问版本。策略已改变时不回传旧密码；内容历史已清除时不回传该版本的标题/简介等敏感回执；删除后只返回操作已发生但结果已不可用的状态，不重建资源。

不含内容的去重墓碑保留，首版无自动清理任务。Key 轮换保留逻辑身份，可用新的有效 secret 核对旧操作；撤销或删除的 Key 不能依靠 requestId 重放，所有者可通过后台审计/操作查询核对结果。

---

### 11. 备份、迁移与安全回滚

完整备份包括正文、Revision、访问策略、Key/grants、操作记录、审计、站点设置和迁移台账。运行 secret 与密码回显所需加密材料单独保管，不混入公开导出。恢复到隔离库，核对摘要、ID、当前指针、历史、授权与保护状态。

恢复数据库快照不会自动恢复“继续服务”的许可。先维持私有/写维护状态，核对恢复点之后的凭据撤销、保护变更和历史清除；无法可靠核对时，恢复出的 Share 保持下架、managed Key 停用，由所有者逐项重新允许。不得把过期备份里的旧密钥和敏感历史直接恢复上线。

发布采用独立可验收切片：访问保护与备份 → 后台版本/历史/状态 → 明确 Key 授权与管理 API → 客户端联合验收。每片正常使用不依赖后一片；后台条件写入必须与后台提交版本一起交付，不能先合并会拒绝全部正常保存的半个协议。

基线切换流程固定：

1. 先执行向后兼容的扩展迁移；schema 只由既有显式迁移命令改变。
2. 先交付认识写维护闸的兼容应用，并验证所有写入口均会在暂停时拒绝写入，返回明确的 maintenance 503。已发布内容尽量保持只读访问，浏览事件在维护期间不计数。
3. 进入写维护并等待已进入的发布事务结束。闸的共享/排他事务锁使“设置暂停完成”意味着先前写事务已结束；未覆盖该协议的旧部署必须退出可写路径，不能把滚动部署等同于所有旧请求已结束。
4. 在受控迁移主机/CI 完成基线回填，验证当前正文与 Revision 一致、旧 ID 与 URL 保持。第二次运行应全部 skipped。
5. 部署新写入协议，完成隔离 Preview 和正式候选检查；确认没有旧写入者后恢复写入。
6. 管理 API 只对显式授予能力的 Key 生效，不在上线脚本中扩大旧 Key 权限。新客户端核验服务器能力，旧客户端仍可创建。

上线门槛包括旧写入者隔离的实测证据；若部署环境无法停止旧写入，保持维护状态而不继续回填/开放。这是发布动作的可验证前置条件，不要求业务请求执行 DDL，也不引入持续双写迁移框架。

**与当前部署规则的差异：**现有部署指南允许回滚上一稳定应用；本里程碑之后，忽略访问版本、下架或授权的旧版本不再是安全回滚候选。实施时同步该规则：保留新 schema 和安全语义，回滚到经过验证的兼容应用，否则维护状态下向前修复；不执行破坏性 down migration 删除历史。
