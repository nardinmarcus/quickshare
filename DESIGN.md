# QuickShare 界面视觉规范

> **状态**：默认应用壳层已改为跟随系统明暗模式的安静工作台。下方 Toast、内容预览 Tab 与 Markdown 主题章节保留为已实现组件的历史规范。

## 视觉方向

默认应用壳层使用中性色表面和单一青色强调系统。暗色模式使用浅青主色配深色前景，亮色模式使用深青主色配白色前景，保证按钮和小字号强调文字的对比度。层级优先由背景明度、留白和柔和阴影建立，普通卡片不再依赖描边；边界只保留在输入、焦点、选中、错误和沙箱内容等有语义的状态。微交互限制为短时背景、颜色和透明度变化，不使用环境发光或持续动画。

`hacker`、`cyberpunk` 与 `popart` 仍是显式配置的可选主题，不代表默认视觉方向。Markdown 内容主题继续在沙箱内独立渲染，不继承管理界面的壳层样式。

---

## 组件一：Toast 通知系统

### 行为
- 固定在视口右上角，支持多条堆叠（从上往下排列）
- 自动消失（默认 4 秒），带进度条指示剩余时间
- 手动关闭（点击 X）
- 三种类型：success（绿）、error（红）、info（青）

### 新增 CSS（追加到 `public/css/styles.css`）

```css
/* ===== Toast 通知系统 ===== */
.toast-container {
  position: fixed;
  top: 20px;
  right: 20px;
  z-index: 300;
  display: flex;
  flex-direction: column;
  gap: 10px;
  pointer-events: none;
}

.toast {
  pointer-events: auto;
  background: var(--bg-main);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 14px 18px;
  min-width: 300px;
  max-width: 420px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.35);
  display: flex;
  align-items: flex-start;
  gap: 12px;
  transform: translateX(calc(100% + 40px));
  opacity: 0;
  transition: transform 0.35s cubic-bezier(0.2, 0, 0, 1),
              opacity 0.3s ease;
}

.toast.show {
  transform: translateX(0);
  opacity: 1;
}

.toast-icon {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
}

.toast-success .toast-icon {
  background: rgba(34, 197, 94, 0.12);
  color: #22c55e;
}

.toast-error .toast-icon {
  background: rgba(239, 68, 68, 0.12);
  color: #ef4444;
}

.toast-info .toast-icon {
  background: rgba(var(--primary-rgb), 0.12);
  color: var(--primary);
}

.toast-content {
  flex: 1;
  font-size: 14px;
  line-height: 1.5;
  color: var(--text-primary);
  word-break: break-word;
}

.toast-close {
  flex-shrink: 0;
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 2px;
  font-size: 13px;
  line-height: 1;
  transition: color 0.2s;
  margin-top: 1px;
}

.toast-close:hover {
  color: var(--text-primary);
}

.toast-progress {
  position: absolute;
  bottom: 0;
  left: 0;
  height: 2px;
  border-radius: 0 0 0 12px;
  transition: width 0.1s linear;
}

.toast-success .toast-progress {
  background: #22c55e;
}

.toast-error .toast-progress {
  background: #ef4444;
}

.toast-info .toast-progress {
  background: var(--primary);
}

@media (max-width: 480px) {
  .toast-container {
    top: 10px;
    right: 10px;
    left: 10px;
  }
  .toast {
    min-width: auto;
    max-width: none;
    width: 100%;
  }
}
```

### 新增 JS（追加到 `public/js/admin.js` 末尾，供 admin 页面共用）

```javascript
// ===== Toast 通知系统 =====
window.Toast = {
  container: null,

  init() {
    if (this.container) return;
    this.container = document.createElement('div');
    this.container.className = 'toast-container';
    this.container.setAttribute('role', 'region');
    this.container.setAttribute('aria-live', 'polite');
    this.container.setAttribute('aria-label', 'Notifications');
    document.body.appendChild(this.container);
  },

  show(message, type = 'info', duration = 4000) {
    this.init();

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.style.position = 'relative';
    toast.style.overflow = 'hidden';

    const icons = {
      success: 'fa-check',
      error: 'fa-times',
      info: 'fa-info'
    };

    toast.innerHTML = `
      <span class="toast-icon"><i class="fas ${icons[type]}" aria-hidden="true"></i></span>
      <span class="toast-content">${message}</span>
      <button class="toast-close" aria-label="Close notification"><i class="fas fa-times" aria-hidden="true"></i></button>
      <div class="toast-progress" style="width: 100%;"></div>
    `;

    this.container.appendChild(toast);

    // 触发动画
    requestAnimationFrame(() => toast.classList.add('show'));

    // 进度条动画
    const progress = toast.querySelector('.toast-progress');
    const startTime = Date.now();
    const timer = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, 100 - (elapsed / duration) * 100);
      progress.style.width = remaining + '%';
      if (remaining <= 0) clearInterval(timer);
    }, 50);

    // 自动关闭
    const autoClose = setTimeout(() => this.dismiss(toast, timer), duration);

    // 手动关闭
    toast.querySelector('.toast-close').addEventListener('click', () => {
      clearTimeout(autoClose);
      clearInterval(timer);
      this.dismiss(toast);
    });
  },

  dismiss(toast, timer) {
    if (timer) clearInterval(timer);
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 350);
  },

  success(message, duration) { this.show(message, 'success', duration); },
  error(message, duration) { this.show(message, 'error', duration); },
  info(message, duration) { this.show(message, 'info', duration); }
};
```

### 使用方式（替换现有 `alert()`）

```javascript
// 之前
alert('Delete failed');

// 之后
Toast.error('Delete failed. Please try again.');
```

---

## 组件二：详情页「原始 / 渲染」Tab 切换

### 行为
- 内容区域顶部放置两个 tab 按钮
- 「原始」显示只读 textarea（现有行为）
- 「渲染」显示 sandbox iframe，加载实际渲染结果
- tab 切换有过渡动画（背景色变化 + 文字色变化）
- 首次切换到「渲染」时异步加载内容

### 修改 `views/admin-page-detail.ejs`

替换第 132-140 行的 Content section：

```html
<section class="card admin-card" id="content-section">
  <div class="admin-content-header">
    <div class="admin-content-tabs">
      <button type="button" class="admin-tab active" data-tab="raw" aria-selected="true" role="tab">
        <i class="fas fa-code" aria-hidden="true"></i>
        <span>Raw</span>
      </button>
      <button type="button" class="admin-tab" data-tab="rendered" aria-selected="false" role="tab">
        <i class="fas fa-eye" aria-hidden="true"></i>
        <span>Preview</span>
      </button>
    </div>
    <a class="admin-icon-link" href="<%= publicUrl %>" target="_blank" rel="noopener noreferrer" aria-label="Open public page">
      <i class="fas fa-external-link-alt" aria-hidden="true"></i>
    </a>
  </div>

  <div class="admin-tab-content">
    <div class="admin-tab-panel active" data-panel="raw" role="tabpanel">
      <textarea class="admin-content-viewer" id="content-textarea" readonly aria-label="Raw content"><%= sharedPage.htmlContent %></textarea>
    </div>
    <div class="admin-tab-panel" data-panel="rendered" role="tabpanel" hidden>
      <iframe id="rendered-preview" class="admin-rendered-preview" sandbox="allow-downloads allow-forms allow-modals allow-popups allow-scripts" title="Rendered content preview"></iframe>
    </div>
  </div>
</section>
```

### 新增 CSS（追加到 `public/css/styles.css`）

```css
/* ===== Tab 切换 ===== */
.admin-content-tabs {
  display: flex;
  gap: 2px;
  background: rgba(var(--primary-rgb), 0.06);
  padding: 4px;
  border-radius: 10px;
}

.admin-tab {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 14px;
  font-weight: 500;
  padding: 8px 16px;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: inherit;
}

.admin-tab:hover {
  color: var(--text-primary);
}

.admin-tab.active {
  background: var(--bg-main);
  color: var(--primary);
  box-shadow: 0 1px 3px rgba(0,0,0,0.12);
}

.admin-tab-content {
  position: relative;
  margin-top: 16px;
}

.admin-tab-panel {
  display: none;
}

.admin-tab-panel.active {
  display: block;
}

.admin-rendered-preview {
  width: 100%;
  min-height: 500px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: #ffffff;
  display: block;
}

@media (prefers-color-scheme: dark) {
  .admin-rendered-preview {
    background: #1a1a1a;
  }
}
```

### 修改 `public/js/admin-detail.js`

在文件末尾追加：

```javascript
// ===== Tab 切换 =====
document.querySelectorAll('.admin-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const targetPanel = tab.dataset.tab;

    document.querySelectorAll('.admin-tab').forEach(t => {
      t.classList.remove('active');
      t.setAttribute('aria-selected', 'false');
    });
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');

    document.querySelectorAll('.admin-tab-panel').forEach(p => {
      p.classList.remove('active');
      p.hidden = true;
    });
    const panel = document.querySelector(`[data-panel="${targetPanel}"]`);
    panel.classList.add('active');
    panel.hidden = false;

    if (targetPanel === 'rendered') {
      loadRenderedPreview();
    }
  });
});

function loadRenderedPreview() {
  const iframe = document.getElementById('rendered-preview');
  if (iframe.dataset.loaded === 'true') return;

  iframe.src = `/p/${window.pageData.id}`;
  iframe.dataset.loaded = 'true';
}
```

---

## 组件三：Markdown 主题选择器

### 行为
- 首页：当代码类型检测为 Markdown 时，在密码保护区域下方显示主题选择器
- 后台编辑：编辑表单中增加主题字段，仅当 codeType 为 markdown 时显示
- 下拉选择，包含 5 套预设主题
- 主题名称使用中英文双语标签

### 首页修改 `views/index.ejs`

在 `password-protection-toggle` div 结束后，添加：

```html
<div id="markdown-theme-selector" class="markdown-theme-selector hidden">
  <div class="theme-selector-header">
    <i class="fas fa-palette" aria-hidden="true"></i>
    <span class="theme-label">Markdown Theme</span>
  </div>
  <select id="markdown-theme" class="theme-select">
    <option value="bytedance" selected>ByteDance 蓝绿 (bytedance)</option>
    <option value="github">GitHub 经典 (github)</option>
    <option value="apple">Apple 极简 (apple)</option>
    <option value="notion">Notion 笔记 (notion)</option>
    <option value="claude">Claude 暖调 (claude)</option>
  </select>
</div>
```

### 后台编辑修改 `views/admin-page-detail.ejs`

在编辑表单（`#edit-form` 内的 `.admin-edit-grid`）中，添加一个字段：

```html
<div class="admin-edit-field" id="theme-field" <%= sharedPage.codeType !== 'markdown' ? 'hidden' : '' %>>
  <label for="edit-theme">Markdown Theme</label>
  <select id="edit-theme" name="markdownTheme">
    <option value="bytedance" <%= !sharedPage.markdownTheme || sharedPage.markdownTheme === 'bytedance' ? 'selected' : '' %>>ByteDance</option>
    <option value="github" <%= sharedPage.markdownTheme === 'github' ? 'selected' : '' %>>GitHub</option>
    <option value="apple" <%= sharedPage.markdownTheme === 'apple' ? 'selected' : '' %>>Apple</option>
    <option value="notion" <%= sharedPage.markdownTheme === 'notion' ? 'selected' : '' %>>Notion</option>
    <option value="claude" <%= sharedPage.markdownTheme === 'claude' ? 'selected' : '' %>>Claude</option>
  </select>
</div>
```

### 新增 CSS（追加到 `public/css/styles.css`）

```css
/* ===== Markdown 主题选择器 ===== */
.markdown-theme-selector {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--border-color);
}

.theme-selector-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  color: var(--text-muted);
  font-size: 13px;
}

.theme-label {
  font-weight: 500;
}

.theme-select {
  width: 100%;
  padding: 10px 14px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg-main);
  color: var(--text-primary);
  font-size: 14px;
  font-family: inherit;
  cursor: pointer;
  transition: border-color 0.2s, box-shadow 0.2s;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%236b7280' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 14px center;
  padding-right: 36px;
}

.theme-select:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(var(--primary-rgb), 0.15);
}

/* 后台编辑页主题字段 */
#theme-field select {
  width: 100%;
  padding: 10px 14px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-main);
  color: var(--text-primary);
  font-size: 14px;
  font-family: inherit;
  cursor: pointer;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%236b7280' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 12px center;
  padding-right: 34px;
}

#theme-field select:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(var(--primary-rgb), 0.15);
}
```

### 首页 JS 修改 `public/js/main.js`

在代码类型检测逻辑中，当检测到 markdown 时显示主题选择器：

```javascript
// 在代码类型变更的监听逻辑中添加：
function updateThemeSelectorVisibility(codeType) {
  const selector = document.getElementById('markdown-theme-selector');
  if (!selector) return;
  if (codeType === 'markdown') {
    selector.classList.remove('hidden');
  } else {
    selector.classList.add('hidden');
  }
}
```

---

## 文件修改清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `public/css/styles.css` | 追加 | Toast、Tab、主题选择器样式 |
| `public/js/admin.js` | 追加 | Toast 系统 |
| `public/js/admin-detail.js` | 追加 | Tab 切换逻辑 |
| `views/admin-page-detail.ejs` | 修改 | Content section 改为 tab 布局，编辑表单加 theme 字段 |
| `views/index.ejs` | 修改 | 加 Markdown 主题选择器 |
| `public/js/main.js` | 修改 | 代码类型检测时控制主题选择器显隐 |
| `utils/contentRenderer.js` | 修改 | `renderMarkdown()` 根据 theme 加载对应 CSS |
| `models/postgres-pages.js` | 修改 | `createPage` / `updatePage` 支持 markdown_theme 字段 |
| `models/memory-pages.js` | 修改 | 同上 |
| `app.js` | 修改 | 创建/更新接口接收 markdownTheme 参数 |
| `public/css/markdown-github.css` | 新增 | GitHub 经典主题 |
| `public/css/markdown-apple.css` | 新增 | Apple 极简主题 |
| `public/css/markdown-notion.css` | 新增 | Notion 笔记主题 |
| `public/css/markdown-claude.css` | 新增 | Claude 暖调主题 |

---

## 5 套 Markdown 主题 — 详细设计规范

参考 Google Stitch DESIGN.md 格式，每套主题包含完整色板、字体层级、组件样式、间距系统和 Do/Don't。

---

### Theme 1: ByteDance

> 已有主题，蓝绿双色系。现代科技感，渐变装饰，视觉层次丰富。

#### Color Palette

| Token | Hex | Role |
|-------|-----|------|
| primary | `#1677ff` | 主强调色 |
| primary-green | `#05d4cd` | 副强调色 |
| ink | `#1d2129` | 标题文字 |
| body | `#4e5969` | 正文文字 |
| body-muted | `#86909c` | 辅助文字 |
| canvas | `#ffffff` | 页面背景 |
| surface | `#f7f8fa` | 代码块/引用背景 |
| border | `#e5e6eb` | 边框/分割线 |
| border-light | `#f2f3f5` | 浅边框 |

#### Typography

| Element | Size | Weight | Line Height | Color |
|---------|------|--------|-------------|-------|
| H1 | 1.6em | 600 | 1.4 | `#1d2129` |
| H2 | 1.3em | 600 | 1.5 | `#ffffff` (on gradient bg) |
| H3 | 1.2em | 600 | 1.6 | `#1677ff` |
| H4 | 1.1em | 500 | 1.6 | `#05d4cd` |
| Body | 15px | 400 | 1.8 | `#4e5969` |
| Code | 14px | 400 | 1.5 | inherit |
| Caption | 12px | 400 | 1.4 | `#86909c` |

#### Component Styles

- **H1**: `display: table`, 水平居中, 上下渐变装饰线 (`#1677ff` -> `#05d4cd`)
- **H2**: 渐变背景 (`135deg, #1677ff, #05d4cd`), 白色文字, 圆角 8px 24px, 下方三角箭头
- **H3**: 左边框 4px `#1677ff`, 背景 `rgba(22,119,255,0.05)`, 圆角 6px
- **H4**: 底部虚线边框 `rgba(5,212,205,0.3)`, 左侧 `◆` 装饰
- **Blockquote**: 左边框 4px `#05d4cd`, 背景 `#f2f3f5`, 顶部 `「` 引号装饰
- **Code Block**: 背景 `#f7f8fa`, 顶部 4px 渐变线 (`#1677ff` -> `#05d4cd`), 圆角 8px
- **Inline Code**: 颜色 `#05d4cd`, 背景 `rgba(5,212,205,0.1)`
- **Link**: 颜色 `#1677ff`, 底部边框 `rgba(22,119,255,0.3)`, hover -> `#05d4cd`
- **Table**: 表头渐变背景, 表头文字 `#1677ff`, 偶数行 `#f7f8fa`
- **HR**: 渐变线 (`#1677ff` -> `#05d4cd`), 中间圆点装饰
- **List**: 无序列表圆点色 `#1677ff`, 偶数项 `#05d4cd`

#### Spacing

- 段落间距: `1.5em`
- 标题上间距: H1 `2em`, H2 `3em`, H3 `2em`, H4 `2em`
- 内容区最大宽度: `900px`
- 内容区内边距: `20px`

#### Dark Mode

- Canvas: `#1a1a1a`
- Body: `#e6e6e6`
- Surface: `#2a2a2a`
- Border: `#333`

---

### Theme 2: GitHub

> 经典 Markdown 渲染风格。白底黑字，极简层级，零装饰。

#### Color Palette

| Token | Hex | Role |
|-------|-----|------|
| primary | `#0969da` | 链接/强调 |
| ink | `#1f2328` | 标题文字 |
| body | `#1f2328` | 正文文字 |
| body-muted | `#656d76` | 辅助文字 |
| canvas | `#ffffff` | 页面背景 |
| surface | `#f6f8fa` | 代码块/引用背景 |
| border | `#d0d7de` | 边框/分割线 |
| border-light | `#eaeef2` | 浅边框 |
| semantic-success | `#1a7f37` | 成功 |
| semantic-danger | `#cf222e` | 危险 |

#### Typography

| Element | Size | Weight | Line Height | Color |
|---------|------|--------|-------------|-------|
| H1 | 2em | 600 | 1.25 | `#1f2328` |
| H2 | 1.5em | 600 | 1.25 | `#1f2328` |
| H3 | 1.25em | 600 | 1.25 | `#1f2328` |
| H4 | 1em | 600 | 1.25 | `#1f2328` |
| Body | 16px | 400 | 1.6 | `#1f2328` |
| Code | 14px | 400 | 1.5 | inherit |

#### Component Styles

- **H1**: 底部边框 1px solid `#d0d7de`, padding-bottom 0.3em
- **H2**: 底部边框 1px solid `#d0d7de`, padding-bottom 0.3em
- **H3**: 无装饰，纯层级
- **H4**: 无装饰，纯层级
- **Blockquote**: 左边框 4px `#d0d7de`, 颜色 `#656d76`, padding-left 1em
- **Code Block**: 背景 `#f6f8fa`, 圆角 6px, 字体 `SFMono-Regular, Consolas, monospace`
- **Inline Code**: 背景 `rgba(175,184,193,0.2)`, 圆角 3px, padding 2px 4px
- **Link**: 颜色 `#0969da`, 无下划线, hover underline
- **Table**: 表头背景 `#f6f8fa`, 全边框 1px `#d0d7de`, 表头粗体
- **HR**: 高度 1px, 背景 `#d0d7de`, 无边框
- **List**: 标准圆点/数字，无自定义颜色

#### Spacing

- 段落间距: `1em`
- 标题上间距: H1/H2 `1.5em`, H3/H4 `1.25em`
- 内容区最大宽度: `900px`
- 内容区内边距: `20px`

#### Do / Don't

- Do: 保持极简，不添加装饰元素
- Do: 使用 GitHub 原生字体栈
- Don't: 使用渐变色
- Don't: 使用阴影或圆角装饰

---

### Theme 3: Apple

> 原生 Apple 体验。超大圆角，大量留白，呼吸感，SF 字体栈。

#### Color Palette

| Token | Hex | Role |
|-------|-----|------|
| primary | `#007AFF` | 链接/强调 |
| primary-hover | `#0051D5` | 链接 hover |
| ink | `#1d1d1f` | 标题文字 |
| body | `#1d1d1f` | 正文文字 |
| body-muted | `#86868b` | 辅助文字 |
| canvas | `#ffffff` | 页面背景 |
| surface | `#f5f5f7` | 代码块/引用背景 |
| surface-elevated | `#fafafc` | 卡片背景 |
| border | `#e0e0e0` | 边框 |
| border-light | `#f0f0f0` | 浅边框 |

#### Typography

| Element | Size | Weight | Line Height | Color |
|---------|------|--------|-------------|-------|
| H1 | 2em | 600 | 1.2 | `#1d1d1f` |
| H2 | 1.5em | 600 | 1.3 | `#1d1d1f` |
| H3 | 1.25em | 600 | 1.4 | `#1d1d1f` |
| H4 | 1em | 600 | 1.4 | `#1d1d1f` |
| Body | 17px | 400 | 1.5 | `#1d1d1f` |
| Code | 14px | 400 | 1.5 | inherit |

#### Component Styles

- **H1**: 无装饰，letter-spacing `-0.022em`
- **H2**: 无装饰，letter-spacing `-0.022em`
- **H3**: 无装饰
- **H4**: 无装饰
- **Blockquote**: 背景 `#f5f5f7`, 圆角 16px, padding 20px, 无边框
- **Code Block**: 背景 `#f5f5f7`, 圆角 12px, 字体 `SF Mono, SFMono-Regular, monospace`
- **Inline Code**: 背景 `#f5f5f7`, 圆角 6px, padding 2px 6px
- **Link**: 颜色 `#007AFF`, 无下划线, hover 时 opacity 0.8
- **Table**: 无边框或极淡边框, 表头 `#f5f5f7`, 圆角 12px (整表), overflow hidden
- **HR**: 高度 1px, 背景 `#e0e0e0`, margin 2em 0
- **List**: 标准圆点, 无自定义颜色
- **Image**: 圆角 16px, 无阴影

#### Spacing

- 段落间距: `1.5em`
- 标题上间距: H1 `2em`, H2 `1.75em`, H3 `1.5em`
- 内容区最大宽度: `800px`
- 内容区内边距: `40px 20px`

#### Signature Detail

- 超大圆角（12-20px）是 Apple 风格的标志
- 大量留白，内容区左右留白充足
- 无装饰性元素（渐变、阴影、边框装饰）
- 图片和卡片使用相同圆角，视觉统一

---

### Theme 4: Notion

> 知识库笔记风格。结构化感强，callout 块，生产力工具美学。

#### Color Palette

| Token | Hex | Role |
|-------|-----|------|
| primary | `#37352f` | 主文字色 |
| accent | `#e16259` | 强调/链接 hover |
| link | `#37352f` | 链接色 (带下划线) |
| ink | `#37352f` | 标题文字 |
| body | `#37352f` | 正文文字 |
| body-muted | `#9ca3af` | 辅助文字 |
| canvas | `#ffffff` | 页面背景 |
| surface | `#f7f6f3` | 代码块/引用背景 |
| surface-callout | `#f7f6f3` | callout 背景 |
| border | `#e3e2e0` | 边框/分割线 |
| border-light | `#eae9e7` | 浅边框 |

#### Typography

| Element | Size | Weight | Line Height | Color |
|---------|------|--------|-------------|-------|
| H1 | 1.875em | 600 | 1.3 | `#37352f` |
| H2 | 1.5em | 600 | 1.3 | `#37352f` |
| H3 | 1.25em | 600 | 1.4 | `#37352f` |
| H4 | 1.125em | 600 | 1.4 | `#37352f` |
| Body | 16px | 400 | 1.6 | `#37352f` |
| Code | 14px | 400 | 1.5 | inherit |

#### Component Styles

- **H1**: 底部边框 1px `#e3e2e0`, padding-bottom 0.2em
- **H2**: 无装饰，纯层级
- **H3**: 无装饰，纯层级
- **H4**: 无装饰，纯层级
- **Blockquote**: 背景 `#f7f6f3`, 左边框 3px `#e9e9e7`, 圆角 3px
- **Callout**: 背景 `#f7f6f3`, 圆角 3px, padding 16px, 左侧可配 emoji/icon
- **Code Block**: 背景 `#f7f6f3`, 圆角 3px, 字体 `SF Mono, monospace`
- **Inline Code**: 背景 `#f1f1ef`, 颜色 `#eb5757`, 圆角 3px, padding 2px 4px
- **Link**: 颜色 `#37352f`, 下划线, hover 颜色 `#e16259`
- **Table**: 全边框 1px `#e3e2e0`, 表头背景 `#f7f6f3`, 圆角 3px
- **HR**: 高度 1px, 背景 `#e3e2e0`
- **List**: 标准圆点/数字
- **Checkbox (todo)**: 自定义 checkbox, 边框 `#d1d1d1`, 完成时 `#2eaadc`

#### Spacing

- 段落间距: `1em`
- 标题上间距: H1 `2em`, H2 `1.5em`, H3 `1.25em`
- 内容区最大宽度: `900px`
- 内容区内边距: `20px`

#### Signature Detail

- 极小圆角（3px）是 Notion 风格的标志
- 链接使用下划线而非颜色区分
- Inline code 使用红色 `#eb5757`，是 Notion 的标志性特征
- Callout 块是核心组件，支持 emoji 前缀
- 整体灰度偏高，无鲜艳主色

---

### Theme 5: Claude

> 后添加的暖调主题（commit `6094f05`）。设计规范见 `public/css/markdown-claude.css`。

---

*设计稿完成。Daddy 确认后可直接按清单实施。*
