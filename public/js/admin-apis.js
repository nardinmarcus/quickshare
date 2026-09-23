(function () {
  const form = document.getElementById('api-key-form');
  const nameInput = document.getElementById('api-key-name');
  const secretPanel = document.getElementById('new-api-key-panel');
  const secretValue = document.getElementById('new-api-key-value');
  const copyButton = document.getElementById('copy-api-key-btn');
  const keyRows = document.getElementById('api-keys-body');

  if (!form || !keyRows) return;

  function csrfToken() {
    return document.querySelector('meta[name="csrf-token"]')?.content || '';
  }

  function notify(type, message) {
    if (window.Toast && typeof window.Toast[type] === 'function') {
      window.Toast[type](message);
      return;
    }

    window.alert(message);
  }

  function formatTime(value) {
    return window.AdminTime.format(value);
  }

  function removeEmptyState() {
    document.getElementById('api-keys-empty')?.remove();
  }

  function addEmptyState() {
    if (keyRows.children.length > 0) return;

    const row = document.createElement('tr');
    row.id = 'api-keys-empty';
    const cell = document.createElement('td');
    cell.colSpan = 7;
    cell.className = 'api-key-empty';
    cell.textContent = '尚未创建托管密钥。';
    row.appendChild(cell);
    keyRows.appendChild(row);
  }

  function createCell(text, className) {
    const cell = document.createElement('td');

    if (className) cell.className = className;
    cell.textContent = text;
    return cell;
  }

  function createGrantsPanelRow(apiKey) {
    const panelRow = document.createElement('tr');
    panelRow.id = 'grants-' + apiKey.id;
    panelRow.className = 'api-key-grants-row';
    panelRow.hidden = true;

    const panelCell = document.createElement('td');
    panelCell.colSpan = 7;
    const panel = document.createElement('div');
    panel.className = 'api-key-grants-panel';
    panel.dataset.grantsPanel = apiKey.id;

    const heading = document.createElement('h3');
    heading.textContent = 'Share 授权 · ' + apiKey.name;
    panel.appendChild(heading);

    const hint = document.createElement('p');
    hint.className = 'admin-muted';
    hint.textContent = '读取、编辑与上下架是分开的 Share 权限。编辑包含读取；上下架不会获得正文读取、编辑、列表或历史权限。';
    panel.appendChild(hint);

    const list = document.createElement('ul');
    list.className = 'api-key-grant-list';
    list.dataset.grantList = apiKey.id;
    const empty = document.createElement('li');
    empty.className = 'api-key-grant-empty';
    empty.dataset.grantEmpty = '';
    empty.textContent = '尚未授权任何 Share。';
    list.appendChild(empty);
    panel.appendChild(list);

    const autoLabel = document.createElement('label');
    autoLabel.className = 'api-key-auto-edit-option';
    const autoToggle = document.createElement('input');
    autoToggle.type = 'checkbox';
    autoToggle.className = 'api-key-auto-edit-toggle';
    autoToggle.dataset.autoGrantEdit = apiKey.id;
    autoToggle.checked = apiKey.auto_grant_new_share_edit === true;
    autoLabel.append(autoToggle, document.createTextNode(' 后续通过此托管密钥创建的 Share 自动授予读取与编辑权'));
    panel.appendChild(autoLabel);
    const autoHint = document.createElement('p');
    autoHint.className = 'admin-muted';
    autoHint.textContent = '只影响启用后的新建；不会追溯旧 Share，也不影响旧版 SHARE_API_KEY 或前端登录创建。';
    panel.appendChild(autoHint);

    const grantForm = document.createElement('form');
    grantForm.className = 'api-key-grant-form';
    grantForm.dataset.grantForm = apiKey.id;
    const label = document.createElement('label');
    label.htmlFor = 'grant-share-id-' + apiKey.id;
    label.textContent = 'Share ID';
    grantForm.appendChild(label);
    const formRow = document.createElement('div');
    formRow.className = 'api-key-grant-form-row';
    const input = document.createElement('input');
    input.id = 'grant-share-id-' + apiKey.id;
    input.name = 'shareId';
    input.className = 'cyber-input';
    input.autocomplete = 'off';
    input.required = true;
    input.placeholder = '例如：xS_9ngJnG9NX';
    formRow.appendChild(input);
    const readLabel = document.createElement('label');
    readLabel.className = 'api-key-edit-option';
    const readToggle = document.createElement('input');
    readToggle.type = 'checkbox';
    readToggle.name = 'canRead';
    readToggle.checked = true;
    readLabel.append(readToggle, document.createTextNode(' 授予读取'));
    formRow.appendChild(readLabel);
    const editLabel = document.createElement('label');
    editLabel.className = 'api-key-edit-option';
    const editToggle = document.createElement('input');
    editToggle.type = 'checkbox';
    editToggle.name = 'canUpdate';
    editLabel.append(editToggle, document.createTextNode(' 授予编辑'));
    formRow.appendChild(editLabel);
    const publishLabel = document.createElement('label');
    publishLabel.className = 'api-key-publish-option';
    const publishToggle = document.createElement('input');
    publishToggle.type = 'checkbox';
    publishToggle.name = 'canPublish';
    publishLabel.append(publishToggle, document.createTextNode(' 单独授予上下架'));
    formRow.appendChild(publishLabel);
    const submit = document.createElement('button');
    submit.className = 'cyber-btn cyber-btn-secondary';
    submit.type = 'submit';
    submit.textContent = '授予授权';
    formRow.appendChild(submit);
    grantForm.appendChild(formRow);
    const grantHint = document.createElement('p');
    grantHint.className = 'admin-muted';
    grantHint.textContent = '编辑自动包含读取；只勾选上下架即可创建 publish-only 授权，不会开放列表、正文、历史或标题元信息。';
    grantForm.appendChild(grantHint);
    panel.appendChild(grantForm);

    panelCell.appendChild(panel);
    panelRow.appendChild(panelCell);
    return panelRow;
  }

  function addKeyRow(apiKey) {
    removeEmptyState();

    const row = document.createElement('tr');
    row.dataset.apiKeyId = apiKey.id;

    const name = document.createElement('td');
    const strong = document.createElement('strong');
    strong.textContent = apiKey.name;
    name.appendChild(strong);

    const prefix = document.createElement('td');
    const prefixCode = document.createElement('code');
    prefixCode.className = 'api-key-prefix';
    prefixCode.textContent = apiKey.key_prefix;
    prefix.appendChild(prefixCode);

    const scopes = document.createElement('td');
    const scopeList = document.createElement('div');
    scopeList.className = 'api-key-scope-list';
    scopeList.dataset.apiKeyScopes = apiKey.id;
    (Array.isArray(apiKey.scopes) && apiKey.scopes.length > 0 ? apiKey.scopes : ['share:create']).forEach((scope) => {
      const scopeCode = document.createElement('code');
      scopeCode.className = 'api-key-scope';
      scopeCode.textContent = scope;
      scopeList.appendChild(scopeCode);
    });
    scopes.appendChild(scopeList);

    const grants = document.createElement('td');
    const grantCount = document.createElement('span');
    grantCount.dataset.readGrantCount = apiKey.id;
    grantCount.textContent = '0';
    grants.appendChild(grantCount);

    const created = document.createElement('td');
    const createdTime = document.createElement('time');
    createdTime.dateTime = new Date(Number(apiKey.created_at)).toISOString();
    createdTime.textContent = formatTime(apiKey.created_at);
    created.appendChild(createdTime);

    const lastUsed = createCell('从未使用', 'admin-muted');

    const actions = document.createElement('td');
    actions.className = 'admin-actions-col';
    const manageGrants = document.createElement('button');
    manageGrants.type = 'button';
    manageGrants.className = 'admin-icon-link api-key-grants-btn';
    manageGrants.dataset.apiKeyId = apiKey.id;
    manageGrants.setAttribute('aria-expanded', 'false');
    manageGrants.setAttribute('aria-controls', 'grants-' + apiKey.id);
    manageGrants.setAttribute('aria-label', '管理 Share 授权 ' + apiKey.name);
    manageGrants.innerHTML = '<i class="fas fa-user-check" aria-hidden="true"></i><span class="sr-only">Share 授权</span>';
    actions.appendChild(manageGrants);
    const rotate = document.createElement('button');
    rotate.type = 'button';
    rotate.className = 'admin-icon-link api-key-rotate-btn';
    rotate.dataset.apiKeyId = apiKey.id;
    rotate.dataset.apiKeyName = apiKey.name;
    rotate.setAttribute('aria-label', '轮换 API 密钥 ' + apiKey.name);
    rotate.innerHTML = '<i class="fas fa-sync-alt" aria-hidden="true"></i><span class="sr-only">轮换</span>';
    actions.appendChild(rotate);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'admin-delete-btn api-key-delete-btn';
    remove.dataset.apiKeyId = apiKey.id;
    remove.dataset.apiKeyName = apiKey.name;
    remove.setAttribute('aria-label', '删除 API 密钥 ' + apiKey.name);
    remove.innerHTML = '<i class="fas fa-trash-alt" aria-hidden="true"></i><span class="sr-only">删除</span>';
    actions.appendChild(remove);

    row.append(name, prefix, scopes, grants, created, lastUsed, actions);
    const panelRow = createGrantsPanelRow(apiKey);
    keyRows.prepend(panelRow);
    keyRows.prepend(row);
  }

  let busy = false;
  function setBusy(value) {
    busy = value;
    form.setAttribute('aria-busy', String(value));
    keyRows.setAttribute('aria-busy', String(value));
    document.querySelectorAll('#api-key-form button, #api-keys-body button, #api-keys-body input').forEach(control => {
      control.disabled = value || control.dataset.blockedByEdit === 'true';
    });
  }

  function clearSecret() {
    secretValue.textContent = '';
    secretPanel.hidden = true;
  }

  function grantsPanelFor(keyId) {
    return keyRows.querySelector('[data-grants-panel="' + CSS.escape(keyId) + '"]');
  }

  function grantCountFor(keyId) {
    return keyRows.querySelector('[data-read-grant-count="' + CSS.escape(keyId) + '"]');
  }

  function renderKeyScopes(keyId, scopes) {
    if (!Array.isArray(scopes)) return;
    const list = keyRows.querySelector('[data-api-key-scopes="' + CSS.escape(keyId) + '"]');
    if (!list) return;
    while (list.children.length) list.children[0].remove();
    if (scopes.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'admin-muted';
      empty.textContent = '无';
      list.appendChild(empty);
    } else {
      scopes.forEach(scope => {
        const badge = document.createElement('code');
        badge.className = 'api-key-scope';
        badge.textContent = scope;
        list.appendChild(badge);
      });
    }
  }

  function refreshGrantEmptyState(keyId) {
    const panel = grantsPanelFor(keyId);
    if (!panel) return;
    const list = panel.querySelector('[data-grant-list]');
    const hasItems = list.querySelector('[data-grant-item]') !== null;
    let empty = list.querySelector('[data-grant-empty]');
    if (hasItems) {
      empty?.remove();
    } else if (!empty) {
      empty = document.createElement('li');
      empty.className = 'api-key-grant-empty';
      empty.dataset.grantEmpty = '';
      empty.textContent = '尚未授权任何 Share。';
      list.appendChild(empty);
    }
  }

  function appendGrantItem(keyId, grant) {
    const shareId = grant?.shareId || grant?.share_id;
    if (!shareId) return null;
    const canRead = grant.canRead === true || grant.can_read === true;
    const canUpdate = grant.canUpdate === true || grant.can_update === true;
    const canPublish = grant.canPublish === true || grant.can_publish === true;
    if (!canRead && !canUpdate && !canPublish) return null;

    const panel = grantsPanelFor(keyId);
    if (!panel) return null;
    const list = panel.querySelector('[data-grant-list]');
    let item = list.querySelector('[data-grant-item="' + CSS.escape(shareId) + '"]');
    if (!item) {
      item = document.createElement('li');
      item.dataset.grantItem = shareId;
      const code = document.createElement('code');
      code.textContent = shareId;
      const title = document.createElement('span');
      title.className = 'admin-muted';
      title.textContent = grant.shareTitle || grant.share_title || '（已授权 Share）';
      item.append(code, title);
      list.appendChild(item);
    }

    let access = item.querySelector('[data-grant-access]');
    if (!access) {
      access = document.createElement('strong');
      access.className = 'api-key-grant-access';
      access.dataset.grantAccess = '';
      item.appendChild(access);
    }
    access.textContent = canUpdate && canPublish ? '编辑 + 上下架'
      : canUpdate ? '编辑 + 读取'
        : canRead && canPublish ? '读取 + 上下架'
          : canRead ? '仅读取' : '仅可上下架';

    let edit = item.querySelector('.api-key-edit-grant-btn');
    if (!edit) {
      edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'api-key-edit-grant-btn';
      edit.dataset.apiKeyId = keyId;
      edit.dataset.shareId = shareId;
      item.appendChild(edit);
    }
    edit.dataset.canUpdate = String(canUpdate);
    edit.setAttribute('aria-pressed', String(canUpdate));
    edit.setAttribute('aria-label', (canUpdate ? '撤销' : '授予') + '该密钥对 ' + shareId + ' 的编辑权');
    edit.textContent = canUpdate ? '撤销编辑权' : '授予编辑权';

    let publish = item.querySelector('.api-key-publish-grant-btn');
    if (!publish) {
      publish = document.createElement('button');
      publish.type = 'button';
      publish.className = 'api-key-publish-grant-btn';
      publish.dataset.apiKeyId = keyId;
      publish.dataset.shareId = shareId;
      item.appendChild(publish);
    }
    publish.dataset.canPublish = String(canPublish);
    publish.setAttribute('aria-pressed', String(canPublish));
    publish.setAttribute('aria-label', (canPublish ? '撤销' : '授予') + '该密钥对 ' + shareId + ' 的上下架权');
    publish.textContent = canPublish ? '撤销上下架权' : '授予上下架权';

    let revoke = item.querySelector('.api-key-revoke-btn');
    if (canRead) {
      if (!revoke) {
        revoke = document.createElement('button');
        revoke.type = 'button';
        revoke.className = 'admin-delete-btn api-key-revoke-btn';
        revoke.dataset.apiKeyId = keyId;
        revoke.dataset.shareId = shareId;
        item.appendChild(revoke);
      }
      revoke.dataset.blockedByEdit = String(canUpdate);
      revoke.disabled = canUpdate;
      revoke.title = canUpdate ? '请先撤销编辑权，再撤回读取授权' : '';
      revoke.setAttribute('aria-label', canUpdate ? '请先撤销编辑权' : '撤回该密钥对 ' + shareId + ' 的读取授权');
      revoke.textContent = canUpdate ? '先撤销编辑权' : '撤回读取授权';
    } else {
      revoke?.remove();
    }
    refreshGrantEmptyState(keyId);
    return item;
  }

  function bumpGrantCount(keyId, delta) {
    const counter = grantCountFor(keyId);
    if (!counter) return;
    counter.textContent = String(Math.max(0, Number(counter.textContent || '0') + delta));
  }

  async function toggleGrantsPanel(button) {
    const keyId = button.dataset.apiKeyId;
    const panelRow = document.getElementById('grants-' + CSS.escape(keyId)) || grantsPanelFor(keyId)?.closest('tr');
    if (!panelRow) return;
    const open = panelRow.hidden;
    panelRow.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open) {
      panelRow.querySelector('input')?.focus();
    }
  }

  function applyGrantUpdate(keyId, shareId, grant) {
    const existing = grantsPanelFor(keyId)?.querySelector('[data-grant-item="' + CSS.escape(shareId) + '"]');
    if (grant && (grant.canRead || grant.canUpdate || grant.canPublish)) {
      appendGrantItem(keyId, grant);
      if (!existing) bumpGrantCount(keyId, 1);
    } else if (existing) {
      existing.remove();
      bumpGrantCount(keyId, -1);
      refreshGrantEmptyState(keyId);
    }
  }

  async function grantRead(form) {
    if (busy) return;
    const keyId = form.dataset.grantForm;
    const input = form.querySelector('input[name="shareId"]');
    const canReadInput = form.querySelector('input[name="canRead"]');
    const canUpdateInput = form.querySelector('input[name="canUpdate"]');
    const canPublishInput = form.querySelector('input[name="canPublish"]');
    const canUpdate = canUpdateInput?.checked === true;
    const canRead = canReadInput?.checked === true || canUpdate;
    const canPublish = canPublishInput?.checked === true;
    const shareId = (input.value || '').trim();

    if (!shareId) {
      input.focus();
      return;
    }
    if (!canRead && !canPublish) {
      notify('error', '至少选择读取、编辑或上下架授权');
      canReadInput?.focus();
      return;
    }

    setBusy(true);
    try {
      const response = await fetch('/admin/apis/keys/' + encodeURIComponent(keyId) + '/grants', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
        body: JSON.stringify({ shareId, canRead, canUpdate, canPublish })
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || '授权失败');

      const existingItem = grantsPanelFor(keyId)?.querySelector('[data-grant-item="' + CSS.escape(shareId) + '"]');
      const hadGrant = Boolean(existingItem);
      if (data.grant) applyGrantUpdate(keyId, shareId, data.grant);
      else if (data.changed) applyGrantUpdate(keyId, shareId, null);
      renderKeyScopes(keyId, data.scopes);
      if (data.changed) {
        const effective = {
          canRead: data.grant?.canRead === true,
          canUpdate: data.grant?.canUpdate === true,
          canPublish: data.grant?.canPublish === true
        };
        if (effective.canUpdate && effective.canPublish) notify('success', '已分别授予读取、编辑与上下架权');
        else if (effective.canUpdate) notify('success', '已授予读取与编辑权');
        else if (effective.canRead && effective.canPublish) notify('success', '已分别授予读取与上下架权');
        else if (effective.canRead) notify('success', '已授予读取授权');
        else if (effective.canPublish) notify('success', '已授予 publish-only 上下架权；读取、列表与历史仍不可用');
        else notify('success', '授权已更新');
      } else {
        notify('info', hadGrant ? '该 Share 已具有所选授权，未重复添加' : '授权状态未改变');
      }
      if (canReadInput) canReadInput.checked = true;
      if (canUpdateInput) canUpdateInput.checked = false;
      if (canPublishInput) canPublishInput.checked = false;
      input.value = '';
      input.focus();
    } catch (error) {
      notify('error', error.message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleEditGrant(button) {
    if (busy) return;
    const keyId = button.dataset.apiKeyId;
    const shareId = button.dataset.shareId;
    const canUpdate = button.dataset.canUpdate !== 'true';
    setBusy(true);
    try {
      const response = await fetch('/admin/apis/keys/' + encodeURIComponent(keyId) + '/grants/' + encodeURIComponent(shareId), {
        method: 'PUT',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
        body: JSON.stringify({ canUpdate })
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || '更新编辑授权失败');
      applyGrantUpdate(keyId, shareId, data.grant);
      renderKeyScopes(keyId, data.scopes);
      notify(data.changed ? 'success' : 'info', data.changed
        ? (canUpdate ? '已授予编辑权（同时保留读取权）' : '已撤销编辑权，读取授权仍保留')
        : '编辑授权状态未改变');
    } catch (error) {
      notify('error', error.message);
    } finally {
      setBusy(false);
    }
  }

  async function togglePublishGrant(button) {
    if (busy) return;
    const keyId = button.dataset.apiKeyId;
    const shareId = button.dataset.shareId;
    const canPublish = button.dataset.canPublish !== 'true';
    setBusy(true);
    try {
      const response = await fetch('/admin/apis/keys/' + encodeURIComponent(keyId) + '/grants/' + encodeURIComponent(shareId), {
        method: 'PUT',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
        body: JSON.stringify({ canPublish })
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || '更新上下架授权失败');
      applyGrantUpdate(keyId, shareId, data.grant);
      renderKeyScopes(keyId, data.scopes);
      notify(data.changed ? 'success' : 'info', data.changed
        ? (canPublish ? '已授予上下架权；该权限不包含内容读取' : '已撤销上下架权；其他读取/编辑授权保持不变')
        : '上下架授权状态未改变');
    } catch (error) {
      notify('error', error.message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleAutoGrant(input) {
    if (busy) return;
    const keyId = input.dataset.autoGrantEdit;
    const enabled = input.checked;
    setBusy(true);
    try {
      const response = await fetch('/admin/apis/keys/' + encodeURIComponent(keyId) + '/auto-grant-edit', {
        method: 'PUT',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
        body: JSON.stringify({ enabled })
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || '更新自动编辑授权失败');
      input.checked = data.autoGrantNewShareEdit === true;
      notify(data.changed ? 'success' : 'info', data.changed
        ? (enabled ? '已为后续托管密钥新建启用自动编辑授权' : '已关闭后续自动编辑授权；现有授权保持不变')
        : '自动编辑授权状态未改变');
    } catch (error) {
      input.checked = !enabled;
      notify('error', error.message);
    } finally {
      setBusy(false);
    }
  }

  async function revokeRead(button) {
    if (busy || button.disabled || button.dataset.blockedByEdit === 'true') return;
    const keyId = button.dataset.apiKeyId;
    const shareId = button.dataset.shareId;

    setBusy(true);
    try {
      const response = await fetch('/admin/apis/keys/' + encodeURIComponent(keyId) + '/grants/' + encodeURIComponent(shareId), {
        method: 'DELETE',
        headers: { Accept: 'application/json', 'X-CSRF-Token': csrfToken() }
      });
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || '撤回授权失败');
      }

      if (data.changed) {
        applyGrantUpdate(keyId, shareId, data.grant);
        notify('success', data.grant?.canPublish === true
          ? '已撤回读取授权；独立上下架权仍保留'
          : '已撤回读取授权');
      } else {
        notify('info', '该读取授权已不存在');
      }
      renderKeyScopes(keyId, data.scopes);
    } catch (error) {
      notify('error', error.message);
    } finally {
      setBusy(false);
    }
  }

  async function rotateKey(button) {
    if (busy) return;
    const id = button.dataset.apiKeyId;
    const name = button.dataset.apiKeyName || '此密钥';
    if (!id || !window.confirm('轮换“' + name + '”吗？Key ID 保持不变，旧密钥立即失效。已授权的 Share 读取授权保持不变。请复制新密钥并更新自动化任务。')) return;
    clearSecret();
    setBusy(true);
    try {
      const response = await fetch('/admin/apis/keys/' + encodeURIComponent(id) + '/rotate', {
        method: 'POST', headers: { Accept: 'application/json', 'X-CSRF-Token': csrfToken() }
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || '轮换 API 密钥失败');
      secretValue.textContent = data.apiKey.secret;
      secretPanel.hidden = false;
      secretPanel.scrollIntoView({ block: 'nearest' });
      copyButton?.focus();
      notify('success', 'API 密钥已轮换，旧密钥已失效');
    } catch (error) {
      notify('error', error.message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteKey(button) {
    if (busy) return;
    const id = button.dataset.apiKeyId;
    const name = button.dataset.apiKeyName || '此密钥';

    if (!id || !window.confirm('确定删除“' + name + '”吗？使用此密钥的自动化任务会立即停止工作，其 Share 读取授权一并移除。')) {
      return;
    }

    clearSecret();
    setBusy(true);

    try {
      const response = await fetch('/admin/apis/keys/' + encodeURIComponent(id), {
        method: 'DELETE',
        headers: {
          Accept: 'application/json',
          'X-CSRF-Token': csrfToken()
        }
      });
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || '删除 API 密钥失败');
      }

      document.getElementById('grants-' + CSS.escape(id))?.remove();
      button.closest('tr')?.remove();
      addEmptyState();
      notify('success', 'API 密钥已删除');
    } catch (error) {
      notify('error', error.message);
    } finally {
      setBusy(false);
    }
  }

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (busy) return;

    const name = nameInput.value.trim();

    if (!name) {
      nameInput.focus();
      return;
    }

    clearSecret();
    setBusy(true);

    try {
      const response = await fetch('/admin/apis/keys', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken()
        },
        body: JSON.stringify({ name })
      });
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || '创建 API 密钥失败');
      }

      secretValue.textContent = data.apiKey.secret;
      secretPanel.hidden = false;
      nameInput.value = '';
      addKeyRow(data.apiKey);
      notify('success', 'API 密钥已创建');
    } catch (error) {
      notify('error', error.message);
    } finally {
      setBusy(false);
    }
  });

  copyButton?.addEventListener('click', async function () {
    const secret = secretValue.textContent;

    if (!secret) return;

    try {
      await navigator.clipboard.writeText(secret);
      notify('success', 'API 密钥已复制');
    } catch (error) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(secretValue);
      selection.removeAllRanges();
      selection.addRange(range);
      notify('info', '已选中密钥，请手动复制');
    }
  });

  keyRows.addEventListener('click', function (event) {
    const editGrant = event.target.closest('.api-key-edit-grant-btn');
    if (editGrant) {
      toggleEditGrant(editGrant);
      return;
    }
    const publishGrant = event.target.closest('.api-key-publish-grant-btn');
    if (publishGrant) {
      togglePublishGrant(publishGrant);
      return;
    }
    const revoke = event.target.closest('.api-key-revoke-btn');
    if (revoke) {
      revokeRead(revoke);
      return;
    }
    const manage = event.target.closest('.api-key-grants-btn');
    if (manage) {
      toggleGrantsPanel(manage);
      return;
    }
    const deleteButton = event.target.closest('.api-key-delete-btn');
    if (deleteButton) {
      deleteKey(deleteButton);
      return;
    }
    const rotate = event.target.closest('.api-key-rotate-btn');
    if (rotate) rotateKey(rotate);
  });

  keyRows.addEventListener('change', function (event) {
    const autoGrant = event.target.closest('.api-key-auto-edit-toggle');
    if (autoGrant) toggleAutoGrant(autoGrant);
  });

  keyRows.addEventListener('submit', function (event) {
    const grantForm = event.target.closest('[data-grant-form]');
    if (!grantForm) return;
    event.preventDefault();
    grantRead(grantForm);
  });
})();
