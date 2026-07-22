# QuickShare Markdown Theme Catalog 正式规格

- 日期：2026-07-22
- 状态：正式规格，已批准进入实施拆票
- 范围：Markdown Share 的主题目录、呈现、创建与后台编辑选择体验；不改变 QuickShare 站点壳层主题
- 依据：领域词汇、ADR-0001、已通过浏览器验证的十二主题 Prototype findings
- 发布状态：已发布为 GitHub Issue #10，并拆分为原生子票据

## Problem Statement

QuickShare 目前允许创建者为 Markdown Share 选择 ByteDance、GitHub、Apple、Notion 或 Claude 主题，但主题能力仍以五套独立样式和多处重复选项存在。创建者只能通过普通下拉名称猜测视觉差异，无法在选择时快速比较主题；浏览器也不会记住上一次选择。现有主题对明暗模式、外层画布、代码、表格、Mermaid、移动端溢出和外部字体的处理并不一致，导致同一个 Markdown Share 在不同环境中可能出现阅读体验分裂。

用户希望把 Markdown Theme Catalog 扩充为十二套品牌灵感预设，包括 Raycast、Google、Tesla、Airbnb、Bugatti、Linear 和 PlayStation，同时保留现有五套的 Preset Visual Identity。这些预设必须适合长篇 Markdown 阅读，而不是复刻品牌官网或产品界面；必须在浅色和暗色下保持同一身份；必须通过一个紧凑 Theme Sampler 帮助选择；还必须避免把响应式、无障碍和资源修复复制十二次。

如果只是继续复制独立样式表和手写下拉选项，Catalog 每次扩充都会放大重复、漂移和视觉回归成本。QuickShare 需要把主题从“若干散落 CSS”提升为一个具备稳定 ID、统一目录、共享阅读基线、主题签名和可验证用户行为的产品能力。

## Solution

QuickShare 将提供一个内置、精选的十二项 Markdown Theme Catalog。每个 Markdown Theme Preset 具有稳定 ID、用户可见 Preset Label、浅色与暗色呈现元数据，以及建立在 Theme Reading Baseline 上的 Preset Visual Identity。

创建首页和后台编辑页继续使用紧凑选择器，但在 Markdown 内容场景中增加一个固定、只读的 Theme Sampler。用户切换主题时，Sampler 立即展示同一组标题、正文、链接、引用、代码、表格和图表示例，从而以一致基准比较主题；实际用户正文仍由现有完整安全预览负责。

所有 Preset 根据查看者系统偏好自动选择 Adaptive Theme Appearance，不向 Share 增加明暗字段或手动切换。浏览器只为新建 Markdown Share 记住最近一次选择；后台编辑始终以 Share 已存主题为准。缺失、非法或不可用的主题继续安全回退到 ByteDance 蓝绿。

十二套 Preset 共享响应式、可读性、溢出、焦点、图片、任务项、代码、表格和图表等基线行为；主题签名只负责可辨识的色板、字体栈、密度、圆角、标题、引用、代码与表面语言。全部主题使用系统字体和本地样式，保持静态克制，不增加品牌 Logo、专有字体、品牌图片、复制的产品界面或持续动画。

功能将按内部切片实施，但只有十二套主题、两种外观和创建/编辑/公开链路全部通过验收后才作为一个完整能力发布。

## User Stories

1. As a Markdown Share creator, I want to choose from twelve curated Presets, so that I can match the presentation to the tone of my content.
2. As a Markdown Share creator, I want every Preset to have a clear brand-inspired label, so that I can understand its direction without treating it as an official brand theme.
3. As a Markdown Share creator, I want the theme control to appear only when my content is Markdown, so that unrelated HTML, SVG, or standalone Mermaid publishing stays uncluttered.
4. As a Markdown Share creator, I want a compact Theme Sampler to update immediately when I select a Preset, so that I can compare themes before requesting a full preview.
5. As a Markdown Share creator, I want every Theme Sampler to use the same fixed representative content, so that visual differences are comparable rather than influenced by different source text.
6. As a Markdown Share creator, I want the Theme Sampler to remain separate from the full safe Share preview, so that a quick style comparison does not pretend to be a complete rendering of my content.
7. As a frequent Markdown Share creator, I want my browser to remember my most recently selected Preset, so that the next new Share starts with my usual choice.
8. As a first-time creator, I want ByteDance 蓝绿 to remain the initial fallback, so that the existing default experience does not change unexpectedly.
9. As a creator whose browser storage is blocked or corrupted, I want theme selection to remain usable with a safe fallback, so that publishing never depends on local preference storage.
10. As a creator, I want my selected stable Preset ID to be stored atomically with the Share, so that the public result matches what I chose.
11. As a creator, I want the full pre-publish preview to render the selected Preset through the existing sandbox, so that I can validate my actual Markdown before publishing.
12. As a keyboard user, I want the selector and Theme Sampler region to have explicit labels, logical focus order, and visible focus, so that I can choose a theme without a pointer.
13. As a mobile creator, I want the selector and Theme Sampler to stack at narrow widths, so that the sample remains readable without horizontal scrolling.
14. As a creator at desktop width, I want the selector and Theme Sampler to share one compact settings region, so that theme choice does not dominate the publishing workflow.
15. As an administrator editing a Markdown Share, I want to see the Share's stored Preset selected, so that I do not accidentally overwrite it with my browser's creation preference.
16. As an administrator, I want the same fixed Theme Sampler available while editing, so that create and edit flows explain Presets consistently.
17. As an administrator, I want saving a new theme to update the existing Share without changing its title, content, password, expiration, or Favorite Share state, so that theme editing remains surgical.
18. As an administrator editing non-Markdown content, I want theme controls hidden, so that the editor does not offer an inapplicable setting.
19. As a public Share viewer, I want the selected Preset to follow my system light or dark preference automatically, so that the page is comfortable in my environment.
20. As a public Share viewer, I want light and dark appearances to retain the same Preset identity, so that adaptive contrast does not turn one theme into a different theme.
21. As a public Share viewer, I want long text to use a bounded reading column and responsive padding, so that paragraphs remain readable on phones and large screens.
22. As a public Share viewer, I want wide tables, fenced code, and diagrams contained within their own regions, so that they never cause page-level horizontal scrolling.
23. As a public Share viewer, I want images to scale within the reading column without distortion, so that visual content does not break the layout.
24. As a public Share viewer, I want headings, links, muted text, quotations, code, tables, and diagram labels to meet accessible contrast, so that every Preset remains readable rather than merely decorative.
25. As a motion-sensitive viewer, I want Markdown themes to remain static and restrained, so that choosing a digital or gaming-inspired Preset does not introduce continuous motion or spectacle.
26. As a privacy-conscious viewer, I want theme identity to use local styling and system fonts, so that opening a themed Share does not add brand-font or image requests to third parties.
27. As a viewer of an existing ByteDance Share, I want its blue/teal hierarchy and heading signatures to remain recognizable after the migration, so that the Share is not silently redesigned.
28. As a viewer of an existing GitHub Share, I want its neutral README structure and restrained rules to remain recognizable after the migration, so that its familiar document character is preserved.
29. As a viewer of an existing Apple Share, I want its spacious, rounded, minimal presentation to remain recognizable after the migration, so that compatibility improvements do not erase its identity.
30. As a viewer of an existing Notion Share, I want its neutral knowledge surfaces, underlined links, and red inline code to remain recognizable, so that the current note-like identity is preserved.
31. As a viewer of an existing Claude Share, I want its warm editorial surfaces, serif headings, and terracotta accents to remain recognizable without downloading a remote font, so that identity and resource policy both hold.
32. As an API client, I want to submit any documented stable Preset ID through the existing Markdown theme field, so that automated publishing can use the expanded Catalog without a new API version.
33. As an API client, I want existing response fields and metadata shapes to remain unchanged, so that adding Presets does not break integrations.
34. As a viewer of a Share containing an unknown or legacy-invalid theme value, I want the page to remain readable using ByteDance fallback, so that bad metadata cannot break public rendering.
35. As a maintainer, I want one authoritative Markdown Theme Catalog to drive rendering and both selectors, so that labels, IDs, stylesheets, and fallback rules cannot drift across surfaces.
36. As a maintainer, I want responsive and accessibility fixes to live in the Theme Reading Baseline, so that one correction benefits every Preset.
37. As a maintainer, I want Preset signature rules to remain expressive above the shared baseline, so that twelve themes do not collapse into token-only clones.
38. As a maintainer, I want Mermaid and syntax highlighting to share rendering logic while consuming Preset-aware presentation tokens, so that technical content matches each theme without twelve runtime implementations.
39. As a maintainer, I want plain Markdown to continue avoiding Mermaid and syntax-highlight runtime assets when they are unnecessary, so that the expanded Catalog does not regress view performance.
40. As a release operator, I want all twelve Presets and both appearances accepted before exposure, so that users never encounter a half-migrated Catalog.
41. As a release operator, I want application rollback to leave stored stable IDs untouched and render unknown new IDs through the existing fallback, so that rollback remains safe without data reversal.
42. As a product owner, I want the seven new Presets to be distinguishable without logos, proprietary fonts, brand images, or copied product UI, so that the Catalog communicates inspiration without impersonation.

## Implementation Decisions

### 1. Domain and system boundary

- The feature uses the domain terms defined in the QuickShare Sharing Context: Markdown Theme Preset, Preset Visual Identity, Markdown Theme Catalog, Preset Label, Adaptive Theme Appearance, Theme Reading Baseline, Theme Asset Boundary, Theme Expression Boundary, Theme Sampler, and Creator Theme Preference.
- Markdown content theming remains separate from the QuickShare site-shell theme. No site-shell environment contract, login/admin theme, or global light/dark selector is expanded by this feature.
- ADR-0001 is authoritative: every Preset shares one responsive readability and accessibility baseline and supplies a separate visual signature. Fully independent theme implementations and token-only clones remain rejected.

### 2. Authoritative Catalog

- Introduce one server-owned Catalog as the authority for stable ID, Preset Label, ordering, local signature asset, and light/dark wrapper metadata.
- The renderer, homepage selector, admin editor selector, Theme Sampler, request validation, and fallback resolution consume this authority. Templates receive a safe projection of Catalog metadata rather than maintaining their own hard-coded option lists.
- Browser code uses only metadata projected from the trusted server Catalog. It must not construct stylesheet URLs from arbitrary request or storage strings.
- Stable IDs and Labels are:

| Stable ID | Preset Label |
| --- | --- |
| `bytedance` | ByteDance 蓝绿 |
| `github` | GitHub 经典 |
| `apple` | Apple 极简 |
| `notion` | Notion 笔记 |
| `claude` | Claude 暖调 |
| `raycast` | Raycast 专注 |
| `google` | Google Material |
| `tesla` | Tesla 黑白 |
| `airbnb` | Airbnb 暖居 |
| `bugatti` | Bugatti 蓝曜 |
| `linear` | Linear 精密 |
| `playstation` | PlayStation 蓝境 |

- Catalog order follows the table above. A future label change does not change the stable ID or rewrite existing Share data.
- Missing, empty, `random`, unknown, stale browser, or otherwise invalid values resolve to `bytedance`. New writes persist the resolved stable ID.

### 3. Data and API compatibility

- No database migration or new column is introduced. The existing text theme field remains the persisted source for each Share's Preset selection.
- Existing browser-create, preview, admin-update, Share API, metadata, and public-view contracts retain their current field names and response shapes.
- The expanded set of stable IDs is accepted anywhere the existing Markdown theme value is accepted. Theme selection remains applicable only when the content type is Markdown.
- No appearance value is stored. Light and dark are runtime presentations chosen from the viewer's system preference.
- Existing rows with null theme values continue to render through ByteDance fallback. Rendering a fallback must not silently rewrite stored data.
- Admin editing initializes from the Share's stored value after Catalog resolution. Creator Theme Preference never overrides an existing Share.

### 4. Shared reading baseline

- Load the Theme Reading Baseline independently from the selected Preset signature so that the document remains readable even if a signature asset fails to load.
- The baseline owns box sizing, `min-width` containment, safe text wrapping, bounded reading width, responsive padding, focus-visible treatment, image sizing, task-item normalization, and the containment behavior of tables, fenced code, and diagrams.
- Tables, code, and diagrams scroll or reflow inside their own containers; they never create page-level horizontal scrolling. Representative diagrams stack vertically at narrow mobile width.
- Baseline tokens cover at least canvas, primary text, muted text, accent/link, borders, quotations, tables, diagrams, code foreground/background, focus, and heading-on-accent foreground.
- The public Markdown wrapper derives page background, supported color scheme, and browser theme-color metadata from the resolved Preset's light/dark Catalog metadata instead of using one hard-coded wrapper palette.
- Shared baseline behavior applies equally to public Shares, full safe previews, and the fixed Theme Sampler, with context-specific scale permitted where needed.

### 5. Adaptive appearance

- Every Preset provides coherent light and dark token sets. The browser selects between them using system color-scheme preference.
- Adaptive Theme Appearance does not add a creator control, Share setting, URL parameter, cookie, API field, or database value.
- The prototype's explicit appearance override was a disposable inspection tool and is not a production feature.
- A Preset's hue emphasis, radius language, heading construction, surface depth, and density remain paired across light and dark even when contrast polarity changes.
- Gradient or accent headings must declare a contrast-safe foreground for each appearance; a light-mode accent color cannot be reused blindly in dark appearance.

### 6. Preset signatures

- Existing Presets retain these identities while adopting the shared baseline and adaptive appearance:
  - **ByteDance 蓝绿:** contrast-safe blue/teal hierarchy, gradient second-level heading, bordered third-level heading, quotation accent, and code-top accent; malformed decorative characters and broad blur glow are removed.
  - **GitHub 经典:** neutral canvas, fine rules, compact document rhythm, restrained blue links, small-radius surfaces, and no decorative gradient or shadow.
  - **Apple 极简:** relaxed 17 px body rhythm, narrower reading column, generous spacing, soft 12–16 px surfaces, plain headings, and minimal borders.
  - **Notion 笔记:** warm-neutral canvas, small corners, structured gray surfaces, underlined body-color links, red inline code, and explicit task state.
  - **Claude 暖调:** warm paper/dark-brown surfaces, system-serif headings, terracotta links and quotations, and system monospace only.
- New Presets use these approved directions:
  - **Raycast 专注:** graphite/plum base, restrained violet/magenta tonal depth, tool-like 12 px surfaces, and inset highlights; no animated glow or floating-glass spectacle.
  - **Google Material:** tonal surfaces, expressive asymmetric corner language, blue primary with a controlled secondary marker, and a clear type scale; not a multicolor brand collage.
  - **Tesla 黑白:** hard black/white hierarchy, bold uppercase long-form first-level heading, thin specification rules, and minimal ornament; its Theme Sampler scale is smaller than its long-form display scale.
  - **Airbnb 暖居:** cream/warm-neutral canvas, dark terracotta accent, friendly 18 px surfaces, a metadata pill, and shallow shadow; no copied Airbnb search/home interface or prominent Rausch-pink imitation.
  - **Bugatti 蓝曜:** ice-white/carbon-black polarity, vivid blue focus, fine metallic separators, and a restrained angular facet; no vehicle imagery, badge, texture asset, or intense shine.
  - **Linear 精密:** calm 15 px density, cool-gray canvas, violet/blue hairlines, precise 7 px surfaces, and minimal depth; flatter and less saturated than Raycast.
  - **PlayStation 蓝境:** pale/deep-blue polarity, static geometric facet, blue gradient heading, and bright focus; dark appearance uses a contrast-safe foreground on the bright gradient and contains no neon bloom, particles, or entertainment artwork.
- Preset signatures may style typography, color, headings, quotations, code, tables, diagrams, links, and related surfaces, but cannot override baseline containment, accessibility, or responsive contracts.

### 7. Theme Asset and Expression Boundaries

- Presets use system font stacks and local CSS only. Remove the existing theme-specific remote font import rather than extending that pattern.
- Do not add logos, brand images, copied application screens, vehicle/property/game imagery, proprietary fonts, or theme-specific third-party assets.
- Existing conditional Mermaid and syntax-highlight runtimes remain outside the Theme Asset Boundary. Their presentation becomes Catalog-aware through shared local styles and Preset tokens; do not add separate runtime implementations or per-Preset CDN assets.
- Plain Markdown continues to omit Mermaid and syntax-highlight runtimes when the content does not require them.
- Presets contain no continuous animation, particles, large decorative images, intense glow, or immersive landing-page behavior. Static gradients, subtle shadows, inset highlights, and restrained geometric facets are allowed.

### 8. Theme Sampler

- Render one Theme Sampler with the selector in both the Markdown create flow and Markdown admin-edit flow.
- The Sampler uses one fixed, read-only representative sample covering heading hierarchy, body text, emphasis, link, list, quotation, inline code, fenced code, table, task state, keyboard hint, image treatment, divider, and a representative diagram surface.
- The Sampler does not inject or render the user's current Markdown and does not execute Mermaid or syntax-highlight runtimes. Actual content remains the responsibility of the full safe Share preview.
- The Sampler loads only trusted local baseline/signature presentation for the currently selected Catalog entry.
- Sampler typography uses a compact context-specific scale while preserving the selected Preset's weight, case, rules, color, radius, and surface signatures. Long-form display sizes must not be copied blindly into the compact sample.
- At 375 px the selector and Sampler stack vertically. At wider create/admin settings widths they may sit adjacent when the sample retains a useful reading width. The interaction must not introduce page-level overflow at 375, 768, or 1440 px.
- The selector has an explicit label; the Sampler has an accessible name describing the selected Preset and remains outside sequential focus unless it contains an intentionally interactive demonstration. Its fixed content is not announced as user content.
- Switching Presets updates the Sampler immediately without requesting the full preview endpoint or mutating Share content.

### 9. Creator Theme Preference

- Only the new-Share browser flow reads and writes Creator Theme Preference.
- Selecting a valid Preset remembers its stable ID in browser-local storage for the next new Markdown Share. Clearing editor content or leaving the page does not reset the preference.
- On a later homepage visit, a valid remembered ID is preselected when Markdown controls become applicable. Missing, invalid, removed, or inaccessible storage falls back to ByteDance without showing an error or blocking publishing.
- The browser preference is convenience state, not source of truth. The selected ID is still sent with preview/create requests and validated by the server Catalog.
- Admin editing neither reads nor writes Creator Theme Preference.

### 10. Mermaid and syntax highlighting

- One shared Mermaid configuration consumes resolved light/dark diagram tokens from the selected Catalog entry. Presets do not fork diagram rendering logic.
- One shared syntax presentation consumes code tokens from the selected Preset while retaining content-language highlighting behavior.
- The same resolved Preset and appearance govern Markdown text, code, tables, and embedded Mermaid so a Share does not mix unrelated palettes.
- Runtime loading remains conditional on content. Failures of optional Mermaid or syntax-highlight runtimes degrade safely without making the surrounding document unreadable.

### 11. Failure and compatibility behavior

| Scenario | Required behavior |
| --- | --- |
| Theme omitted or `random` | Resolve and persist ByteDance for new writes. |
| Unknown request value | Resolve to ByteDance; never construct an arbitrary asset URL. |
| Existing row contains null or unknown value | Render readable ByteDance fallback without rewriting the row during a read. |
| Browser preference is stale or malformed | Ignore it and preselect ByteDance. |
| Browser storage throws or is unavailable | Continue selection, preview, and publishing without persistence. |
| Preset signature asset fails | Shared baseline keeps the document readable and contained. |
| Optional Mermaid/highlight runtime fails | Technical content degrades safely; the document and selected Preset remain usable. |
| System appearance changes while viewing | The resolved Preset changes appearance without changing its stored ID or reloading Share data. |
| Application rolls back after new IDs were stored | Older code may display ByteDance fallback, but stored IDs remain intact for a later forward deployment. |

### 12. Delivery boundary

- Implement in reviewable internal slices, but do not expose a partially migrated Catalog as the completed feature.
- Release acceptance requires all twelve Presets, both appearances, create/admin Samplers, browser preference, preview/create/edit persistence, public rendering, and compatibility checks to pass together.
- The disposable Prototype is evidence only. Do not copy its production-shaped code into the implementation; retain only approved visual decisions and test constraints.
- No database migration, background job, data backfill, authentication change, deployment-platform migration, or public URL change is required.

## Testing Decisions

### 1. Testing philosophy and seams

- Tests assert external behavior: accepted Catalog IDs, rendered document semantics, selected/persisted values, resource requests, accessible interaction, computed contrast, responsive geometry, and fallback behavior. They do not require a particular number of stylesheets, exact selector text, or pixel-identical screenshots.
- Prefer three existing seams:
  1. **HTTP/render seam:** exercise homepage, preview, create, metadata, admin detail/update, and public view through the running Express application.
  2. **Browser seam:** exercise selection, Sampler, local preference, system appearance, real geometry, resource inventory, and public Share output in a real browser.
  3. **Content-renderer seam:** exercise Catalog resolution, conditional optional assets, wrapper metadata, Mermaid/highlight configuration, and readable fallback without involving persistence.
- No new database test seam is required because the persisted field and Repository behavior already exist. Existing Memory/Postgres theme persistence coverage remains part of the full regression suite.

### 2. Catalog and renderer contracts

- Table-drive all twelve stable IDs and Labels through Catalog resolution.
- Assert IDs are unique, labels are non-empty, projected assets are local trusted paths, both appearance metadata sets exist, and fallback is ByteDance.
- For each stable ID, render representative Markdown and verify the resolved document references the shared baseline plus the correct trusted signature and appearance metadata.
- Verify null, empty, `random`, unknown, and malformed values render ByteDance without reflecting arbitrary input into asset URLs.
- Verify plain Markdown requests no Mermaid or syntax-highlight runtime; code-only Markdown loads highlighting but not Mermaid; Mermaid Markdown loads Mermaid but not unrelated highlighting.
- Verify no rendered Preset introduces remote font, logo, image, or theme-specific CDN requests.
- Verify a missing or failed signature leaves baseline text, tables, code, images, and diagrams contained and readable.

### 3. Create, preview, API, and edit behavior

- Homepage HTML exposes all twelve options from the Catalog in the approved order and displays the control only for Markdown content.
- Preview each new stable ID through the existing preview endpoint and verify the sandboxed document uses that Preset without storing a Share.
- Create Markdown Shares through the browser endpoint and Share API using representative existing and new IDs; verify the resolved stable ID is persisted and returned through existing metadata fields.
- Submit unknown values through all write paths and verify ByteDance normalization rather than arbitrary persistence or asset loading.
- Render a persisted new ID through the public view and verify the same Preset identity appears in the public document.
- Admin detail initializes from the Share's stored Preset; updating only the Preset preserves content, title, description, password/protection, expiration, view data, and Favorite Share state.
- Non-Markdown create/edit flows omit inapplicable theme UI and do not gain a theme side effect.

### 4. Theme Sampler and Creator Theme Preference

- In a real browser, switching any of the twelve options updates one fixed Sampler immediately without calling the full preview endpoint or altering editor content.
- Verify the fixed sample contains the agreed representative roles and remains read-only.
- Verify the selector is keyboard-operable, visibly focused, explicitly labeled, and correctly associated with the Sampler's accessible name.
- Verify the Sampler uses context-specific scale: Tesla and other display-heavy themes remain compact while retaining their signature.
- Verify selecting a valid ID on the homepage is remembered and preselected on the next new Markdown session.
- Verify stale IDs, malformed storage, denied storage, and thrown storage access all fall back safely without blocking preview or publishing.
- Verify admin edit ignores and does not mutate Creator Theme Preference.

### 5. Production visual matrix

- Run a real-browser matrix covering twelve Presets × two appearances × 375, 768, and 1440 px: 72 full combinations for the Sampler and representative rendered Markdown.
- At every combination, assert zero page-level horizontal overflow and containment of tables, fenced code, images, task items, and diagrams.
- At 375 px assert selector/Sampler vertical stacking and vertically reflowed representative diagram behavior. At wider sizes assert the settings region remains compact and the reading column bounded.
- Test browser system-appearance changes and verify one stable Preset ID retains its visual identity while computed colors switch.
- Measure representative contrast roles. Normal body, link, quotation, muted, code, table, and diagram text must meet at least WCAG AA 4.5:1; qualifying large display text must meet at least 3:1. Focus indicators must remain visible in every appearance.
- Use computed style and signature assertions for durable visual contracts, supplemented by contact-sheet human review. Do not make a full-page pixel snapshot the sole source of truth.
- Repeat key creator/admin/public flows at 200% zoom to catch reflow and clipping beyond viewport-width checks.

### 6. Preset identity acceptance

- Existing five Presets retain their approved signature anchors after baseline migration.
- The seven new Presets remain distinguishable without their visible labels, logos, brand images, proprietary fonts, or motion.
- Raycast and Linear must remain distinct: Raycast uses deeper/inset tool surfaces and stronger plum tonal depth; Linear stays flatter, denser, and less saturated.
- Tesla long-form display hierarchy must not inflate the compact Sampler.
- Airbnb uses warm terracotta rather than copied Rausch-pink identity.
- Bugatti and PlayStation use distinct blue systems: Bugatti is metallic/ice-carbon restraint; PlayStation is geometric blue depth.
- ByteDance removes malformed decorative glyphs and broad blur while preserving blue/teal hierarchy.
- Claude preserves warm editorial identity after remote font removal.

### 7. Resource, performance, and regression checks

- Browser network inventory for every Preset contains no theme-specific remote font, image, stylesheet, or script request.
- Static and computed inspection finds no continuous animation or prohibited visual effects in theme presentation.
- Plain Markdown keeps the current optional-asset performance behavior; expanding the Catalog must not cause all twelve signatures or optional runtimes to download on every public view.
- Run the complete Node test suite and existing PostgreSQL integration suite even though no migration is added.
- Regress HTML, SVG, standalone Mermaid, safe preview sandboxing, password protection, expiration, view counts, public metadata, Share API compatibility, admin access, and Favorite Share lifecycle.
- Before release, verify the same reviewed revision in Preview and Production, including custom-domain public rendering and local-versus-deployed theme asset integrity.

### 8. Prior art

- Existing content-renderer tests already cover conditional Mermaid/highlight assets and plain-Markdown resource behavior.
- Existing publishing UX tests already exercise the homepage, sandboxed preview endpoint, and Markdown theme request.
- Existing access-policy tests already prove browser and Share API theme persistence through HTTP and Repository readback.
- Existing admin accessibility tests provide patterns for labeled controls, focus visibility, responsive layout, and busy/live states.
- Existing production acceptance practice provides browser matrices, asset-integrity checks, custom-domain smoke tests, and compatibility regression boundaries.

## Out of Scope

- User-authored themes, theme editor, custom CSS upload, marketplace, import/export, or third-party theme installation.
- Brand replication, official-looking themes, logos, badges, proprietary fonts, copied application interfaces, product screenshots, vehicles, properties, game art, or other brand imagery.
- Creator-selected or Share-stored light/dark appearance, manual appearance toggles, URL appearance parameters, or separate light/dark Catalog entries.
- Changes to QuickShare site-shell themes, `UI_THEME`, login/admin shell appearance, or global application color-mode behavior.
- Live rendering of user Markdown inside Theme Sampler; the existing full safe preview remains the only actual-content preview.
- Continuous animation, particles, animated glow, large decorative background imagery, or immersive landing-page behavior.
- Database migration, data backfill, new table/column, Repository redesign, or cache-backed theme source of truth.
- New authentication, authorization, CSRF, password, expiration, Favorite Share, analytics, or view-count behavior.
- New public routes, Share URL changes, API versioning, or response-shape changes.
- Replacing the existing Markdown, Mermaid, or syntax-highlight parser/runtime libraries solely for theme support.
- Treating the disposable Prototype Theme Lab as production code or shipping its manual appearance override.
- Implementing production code, pushing, or deploying as part of the specification and ticket-publication workflow.

## Further Notes

- The visual Prototype validated the architecture before this specification. Across 72 single-view combinations and a 24-card comparison, it found zero page-level overflow and zero table/code/diagram containment failures.
- Prototype contrast minima were body 7.10:1, heading 12.26:1, link 4.73:1, quotation 5.25:1, fenced code 11.35:1, muted text 4.51:1, diagram node 12.26:1, and table header 11.35:1. These values demonstrate viability but do not replace production WCAG verification.
- The prototype rejected an oversized Tesla Sampler heading. With a sampler-specific scale, all twelve light samplers measured 395–414 px tall at a 392 px rendered width and 387–406 px tall at a 318 px mobile width.
- Prototype inspection found no remote URL, font import, keyframe, animation declaration, or console error. Production must independently prove the same Theme Asset and Expression Boundaries.
- Official primary-source checks informed brand direction, but the implemented Presets remain QuickShare's own brand-inspired visual language. Future changes to brand websites do not create an obligation to track or reproduce them.
- The disposable Theme Lab should be removed only in a later authorized cleanup after this specification and its visual findings are safely carried into tickets. It is intentionally not modified or deleted by this specification-only task.
- Implementation proceeds through the independently verifiable child tickets attached to GitHub Issue #10. They are already agent-ready and must not be sent through triage.
