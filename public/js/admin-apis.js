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

    const version = createCell(String(apiKey.credential_version || '1'), 'api-key-version');

    // A freshly created Key is create-only; its scope cell matches the
    // server-rendered rows so it can be widened without a reload.
    const scopesCell = document.createElement('td');
    scopesCell.className = 'api-key-scopes';
    const heldScopes = Array.isArray(apiKey.scopes) ? apiKey.scopes : ['share:create'];
    for (const [scope, label] of [['share:create', '创建'], ['share:read', '读取已授权 Share'], ['share:update', '编辑已授权 Share'], ['share:publish', '上下架已授权 Share']]) {
      const option = document.createElement('label');
      option.className = 'api-scope-option';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'api-scope-checkbox';
      checkbox.dataset.scope = scope;
      checkbox.checked = heldScopes.includes(scope);
      option.append(checkbox, document.createTextNode(' ' + label));
      scopesCell.appendChild(option);
    }
    const scopesButton = document.createElement('button');
    scopesButton.type = 'button';
    scopesButton.className = 'cyber-btn cyber-btn-secondary api-key-scopes-btn';
    scopesButton.dataset.apiKeyId = apiKey.id;
    scopesButton.dataset.apiKeyName = apiKey.name;
    scopesButton.textContent = '保存范围';
    scopesCell.appendChild(scopesButton);

    const created = document.createElement('td');
    const createdTime = document.createElement('time');
    createdTime.dateTime = new Date(Number(apiKey.created_at)).toISOString();
    createdTime.textContent = formatTime(apiKey.created_at);
    created.appendChild(createdTime);

    const lastUsed = createCell('从未使用', 'admin-muted');

    const actions = document.createElement('td');
    actions.className = 'admin-actions-col';
    const rotate = document.createElement('button');
    rotate.type = 'button';
    rotate.className = 'admin-rotate-btn api-key-rotate-btn';
    rotate.dataset.apiKeyId = apiKey.id;
    rotate.dataset.apiKeyName = apiKey.name;
    rotate.setAttribute('aria-label', '轮换 API 密钥 ' + apiKey.name);
    rotate.innerHTML = '<i class="fas fa-sync-alt" aria-hidden="true"></i><span class="sr-only">轮换</span>';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'admin-delete-btn api-key-delete-btn';
    remove.dataset.apiKeyId = apiKey.id;
    remove.dataset.apiKeyName = apiKey.name;
    remove.setAttribute('aria-label', '删除 API 密钥 ' + apiKey.name);
    remove.innerHTML = '<i class="fas fa-trash-alt" aria-hidden="true"></i><span class="sr-only">删除</span>';
    actions.append(rotate, remove);

    row.append(name, prefix, version, scopesCell, created, lastUsed, actions);
    keyRows.prepend(row);
    addGrantPanel(apiKey);
  }

  async function rotateKey(button) {
    const id = button.dataset.apiKeyId;
    const name = button.dataset.apiKeyName || '此密钥';

    if (!id || !window.confirm('确定轮换“' + name + '”吗？旧密钥会立即失效，使用旧密钥的自动化任务必须改用轮换后显示的新密钥。')) {
      return;
    }

    button.disabled = true;

    try {
      const response = await fetch('/admin/apis/keys/' + encodeURIComponent(id) + '/rotate', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken()
        },
        body: JSON.stringify({})
      });
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || '轮换 API 密钥失败');
      }

      // The new secret is shown exactly once, in the same panel used for a
      // freshly created key; it is never rendered into the table.
      secretValue.textContent = data.apiKey.secret;
      secretPanel.hidden = false;

      const row = button.closest('tr');
      const prefixCode = row?.querySelector('.api-key-prefix');
      if (prefixCode) prefixCode.textContent = data.apiKey.key_prefix;
      const versionCell = row?.querySelector('.api-key-version');
      if (versionCell) versionCell.textContent = String(data.apiKey.credential_version || '');

      notify('success', 'API 密钥已轮换，请立即复制新密钥');
    } catch (error) {
      notify('error', error.message);
    } finally {
      button.disabled = false;
    }
  }

  async function deleteKey(button) {
    const id = button.dataset.apiKeyId;
    const name = button.dataset.apiKeyName || '此密钥';

    if (!id || !window.confirm('确定删除“' + name + '”吗？使用此密钥的自动化任务会立即停止工作。')) {
      return;
    }

    button.disabled = true;

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

      button.closest('tr')?.remove();
      document.querySelector('.api-grant-panel[data-api-key-id="' + id + '"]')?.remove();
      addEmptyState();
      notify('success', 'API 密钥已删除');
    } catch (error) {
      button.disabled = false;
      notify('error', error.message);
    }
  }

  form.addEventListener('submit', async function (event) {
    event.preventDefault();

    const name = nameInput.value.trim();
    const submit = form.querySelector('button[type="submit"]');

    if (!name) {
      nameInput.focus();
      return;
    }

    submit.disabled = true;
    form.setAttribute('aria-busy', 'true');

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
      form.setAttribute('aria-busy', 'false');
      submit.disabled = false;
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

  async function saveScopes(button) {
    const id = button.dataset.apiKeyId;
    const row = button.closest('tr');

    if (!id || !row) return;

    const scopes = Array.from(row.querySelectorAll('.api-scope-checkbox'))
      .filter(checkbox => checkbox.checked)
      .map(checkbox => checkbox.dataset.scope);

    button.disabled = true;

    try {
      const response = await fetch('/admin/apis/keys/' + encodeURIComponent(id) + '/scopes', {
        method: 'PUT',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken()
        },
        body: JSON.stringify({ scopes })
      });
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || '保存授权范围失败');
      }

      notify('success', '授权范围已保存');
    } catch (error) {
      notify('error', error.message);
    } finally {
      button.disabled = false;
    }
  }

  // --- Per-Share grants (T12; edit grant + auto-edit opt-in, T13;
  // --- publish grant, T15) -------------------------------------------
  // The grant panels are owner tooling: they list what the API itself
  // never exposes (which Shares a Key may touch) and grant/revoke the
  // read, update and publish permissions. Publish is independent: it
  // neither rides along with an edit grant nor implies read. The
  // auto-edit toggle opts the Key into read+update grants on its OWN
  // future creations only — never publish.

  function grantableShares() {
    try {
      return JSON.parse(document.getElementById('grantable-shares-data')?.textContent || '[]');
    } catch (error) {
      return [];
    }
  }

  function permissionLabel(permissions) {
    const labels = [];

    if (permissions.read) labels.push('只读');
    if (permissions.update) labels.push('编辑');
    if (permissions.publish) labels.push('上下架');

    return labels.join('、') || '无';
  }

  async function loadGrants(panel) {
    const keyId = panel.dataset.apiKeyId;
    const list = panel.querySelector('[data-grant-list]');

    if (!keyId || !list) return;

    try {
      const response = await fetch('/admin/apis/keys/' + encodeURIComponent(keyId) + '/grants', {
        headers: { Accept: 'application/json' }
      });
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || '加载授权失败');
      }

      list.replaceChildren();

      if (data.grants.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'admin-muted';
        empty.textContent = '暂无授权。';
        list.appendChild(empty);
        return;
      }

      for (const grant of data.grants) {
        const item = document.createElement('li');
        const label = document.createElement('span');
        label.textContent = (grant.shareTitle ? grant.shareTitle + '（' + grant.shareId + '）' : grant.shareId)
          + ' · ' + permissionLabel(grant.permissions)
          + (grant.shareExists ? '' : ' · Share 已不存在');
        const revoke = document.createElement('button');
        revoke.type = 'button';
        revoke.className = 'cyber-btn cyber-btn-secondary api-grant-revoke-btn';
        revoke.dataset.shareId = grant.shareId;
        revoke.textContent = '撤回';
        item.append(label, revoke);
        list.appendChild(item);
      }
    } catch (error) {
      list.replaceChildren();
      const failed = document.createElement('li');
      failed.className = 'admin-muted';
      failed.textContent = error.message;
      list.appendChild(failed);
    }
  }

  async function grantAccess(panel, select) {
    const keyId = panel.dataset.apiKeyId;
    const shareId = select.value;
    const permissionSelect = panel.querySelector('[data-grant-permission]');
    const permissionChoice = permissionSelect ? permissionSelect.value : 'read';
    const permissions = permissionChoice === 'update'
      ? { read: true, update: true }
      : permissionChoice === 'publish'
        ? { publish: true }
        : { read: true };

    if (!keyId || !shareId) return;

    try {
      const response = await fetch('/admin/apis/keys/' + encodeURIComponent(keyId) + '/grants', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken()
        },
        body: JSON.stringify({ shareId, permissions })
      });
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || '授予权限失败');
      }

      select.value = '';
      notify('success', permissions.update
        ? '已授予编辑权限（含读取）'
        : permissions.publish
          ? '已授予上下架权限（不含读取）'
          : '已授予只读权限');
      await loadGrants(panel);
    } catch (error) {
      notify('error', error.message);
    }
  }

  async function toggleAutoGrant(panel, checkbox) {
    const keyId = panel.dataset.apiKeyId;
    const enabled = checkbox.checked;

    if (!keyId) return;

    checkbox.disabled = true;

    try {
      const response = await fetch('/admin/apis/keys/' + encodeURIComponent(keyId) + '/auto-grant', {
        method: 'PUT',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken()
        },
        body: JSON.stringify({ enabled })
      });
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || '保存自动编辑设置失败');
      }

      checkbox.checked = data.apiKey.auto_grant_new_share_edit === true;
      notify('success', enabled
        ? '已开启自动编辑：该密钥新建的 Share 将自动授予其读取+编辑权限'
        : '已关闭自动编辑未来新建');
    } catch (error) {
      // Never leave the checkbox showing a state the server refused.
      checkbox.checked = !enabled;
      notify('error', error.message);
    } finally {
      checkbox.disabled = false;
    }
  }

  async function revokeAccess(panel, button) {
    const keyId = panel.dataset.apiKeyId;
    const shareId = button.dataset.shareId;

    if (!keyId || !shareId || !window.confirm('确定撤回该 Share 的授权吗？')) {
      return;
    }

    button.disabled = true;

    try {
      const response = await fetch(
        '/admin/apis/keys/' + encodeURIComponent(keyId) + '/grants/' + encodeURIComponent(shareId),
        {
          method: 'DELETE',
          headers: {
            Accept: 'application/json',
            'X-CSRF-Token': csrfToken()
          }
        }
      );
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || '撤回授权失败');
      }

      notify('success', '授权已撤回');
      await loadGrants(panel);
    } catch (error) {
      button.disabled = false;
      notify('error', error.message);
    }
  }

  function wireGrantPanel(panel) {
    const form = panel.querySelector('[data-grant-form]');

    form?.addEventListener('submit', function (event) {
      event.preventDefault();
      grantAccess(panel, form.querySelector('[data-grant-share]'));
    });

    panel.querySelector('[data-auto-grant-toggle]')?.addEventListener('change', function (event) {
      toggleAutoGrant(panel, event.target);
    });

    panel.querySelector('[data-grant-list]')?.addEventListener('click', function (event) {
      const button = event.target.closest('.api-grant-revoke-btn');

      if (button) revokeAccess(panel, button);
    });

    loadGrants(panel);
  }

  function addGrantPanel(apiKey) {
    const card = document.querySelector('.api-grants-card');

    if (!card) return;

    card.querySelector('.api-key-empty')?.remove();

    const panel = document.createElement('div');
    panel.className = 'api-grant-panel';
    panel.dataset.apiKeyId = apiKey.id;

    const heading = document.createElement('h3');
    heading.className = 'api-grant-key-name';
    heading.textContent = apiKey.name + ' ';
    const prefix = document.createElement('code');
    prefix.className = 'api-key-prefix';
    prefix.textContent = apiKey.key_prefix;
    heading.appendChild(prefix);

    const list = document.createElement('ul');
    list.className = 'api-grant-list';
    list.dataset.grantList = '';

    // A freshly created Key starts with the auto-edit opt-in off, like
    // the server-rendered panels of existing Keys.
    const autoGrantOption = document.createElement('label');
    autoGrantOption.className = 'api-auto-grant-option';
    const autoGrantToggle = document.createElement('input');
    autoGrantToggle.type = 'checkbox';
    autoGrantToggle.className = 'api-auto-grant-checkbox';
    autoGrantToggle.dataset.autoGrantToggle = '';
    autoGrantToggle.checked = apiKey.auto_grant_new_share_edit === true;
    autoGrantOption.append(
      autoGrantToggle,
      document.createTextNode(' 自动编辑未来新建：该密钥新建 Share 时自动获得读取+编辑授权（不含上下架，不追溯既有 Share；需要先具备「读取」与「编辑」范围）')
    );

    const form = document.createElement('form');
    form.className = 'api-grant-form';
    form.dataset.grantForm = '';
    const select = document.createElement('select');
    select.className = 'cyber-input api-grant-share-select';
    select.dataset.grantShare = '';
    select.required = true;
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '选择 Share…';
    select.appendChild(placeholder);

    for (const share of grantableShares()) {
      const option = document.createElement('option');
      option.value = share.id;
      option.textContent = (share.title ? share.title : share.id) + '（' + share.id + '）';
      select.appendChild(option);
    }

    const permissionSelect = document.createElement('select');
    permissionSelect.className = 'cyber-input api-grant-permission-select';
    permissionSelect.dataset.grantPermission = '';
    const readOption = document.createElement('option');
    readOption.value = 'read';
    readOption.textContent = '只读';
    const updateOption = document.createElement('option');
    updateOption.value = 'update';
    updateOption.textContent = '编辑（含读取）';
    // T15: publish is a separately grantable permission here too —
    // a panel built for a freshly created Key must offer the same
    // three choices as the server-rendered one.
    const publishOption = document.createElement('option');
    publishOption.value = 'publish';
    publishOption.textContent = '上下架（不含读取）';
    permissionSelect.append(readOption, updateOption, publishOption);

    const submit = document.createElement('button');
    submit.className = 'cyber-btn cyber-btn-secondary';
    submit.type = 'submit';
    submit.textContent = '授予';
    form.append(select, permissionSelect, submit);

    panel.append(heading, list, autoGrantOption, form);
    card.appendChild(panel);
    wireGrantPanel(panel);
  }

  document.querySelectorAll('.api-grant-panel').forEach(wireGrantPanel);

  keyRows.addEventListener('click', function (event) {
    const scopesButton = event.target.closest('.api-key-scopes-btn');

    if (scopesButton) {
      saveScopes(scopesButton);
      return;
    }

    const rotateButton = event.target.closest('.api-key-rotate-btn');

    if (rotateButton) {
      rotateKey(rotateButton);
      return;
    }

    const button = event.target.closest('.api-key-delete-btn');

    if (button) deleteKey(button);
  });
})();
