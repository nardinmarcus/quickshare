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
    heading.textContent = '读取授权 · ' + apiKey.name;
    panel.appendChild(heading);

    const hint = document.createElement('p');
    hint.className = 'admin-muted';
    hint.textContent = '为该密钥授权读取指定 Share；授权后可用 GET /api/v1/shares 系列接口读取。撤回全部授权后该密钥立即失去读取能力（scope 自动收回）。';
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
    const submit = document.createElement('button');
    submit.className = 'cyber-btn cyber-btn-secondary';
    submit.type = 'submit';
    submit.textContent = '授予读取';
    formRow.appendChild(submit);
    grantForm.appendChild(formRow);
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
    manageGrants.setAttribute('aria-label', '管理读取授权 ' + apiKey.name);
    manageGrants.innerHTML = '<i class="fas fa-user-check" aria-hidden="true"></i><span class="sr-only">读取授权</span>';
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
    document.querySelectorAll('#api-key-form button, #api-keys-body button').forEach(button => { button.disabled = value; });
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

  function appendGrantItem(keyId, shareId) {
    const panel = grantsPanelFor(keyId);
    if (!panel) return null;
    const list = panel.querySelector('[data-grant-list]');
    if (list.querySelector('[data-grant-item="' + CSS.escape(shareId) + '"]')) {
      return list.querySelector('[data-grant-item="' + CSS.escape(shareId) + '"]');
    }

    const item = document.createElement('li');
    item.dataset.grantItem = shareId;
    const code = document.createElement('code');
    code.textContent = shareId;
    item.appendChild(code);
    const revoke = document.createElement('button');
    revoke.type = 'button';
    revoke.className = 'admin-delete-btn api-key-revoke-btn';
    revoke.dataset.apiKeyId = keyId;
    revoke.dataset.shareId = shareId;
    revoke.setAttribute('aria-label', '撤回该密钥对 ' + shareId + ' 的读取授权');
    revoke.textContent = '撤回';
    item.appendChild(revoke);
    list.appendChild(item);
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

  async function grantRead(form) {
    if (busy) return;
    const keyId = form.dataset.grantForm;
    const input = form.querySelector('input[name="shareId"]');
    const shareId = (input.value || '').trim();

    if (!shareId) {
      input.focus();
      return;
    }

    setBusy(true);
    try {
      const response = await fetch('/admin/apis/keys/' + encodeURIComponent(keyId) + '/grants', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
        body: JSON.stringify({ shareId })
      });
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || '授权失败');
      }

      if (data.changed) {
        appendGrantItem(keyId, shareId);
        bumpGrantCount(keyId, 1);
        notify('success', '已授予读取授权');
      } else {
        notify('info', '该 Share 已在授权列表中，未重复添加');
      }
      renderKeyScopes(keyId, data.scopes);
      input.value = '';
      input.focus();
    } catch (error) {
      notify('error', error.message);
    } finally {
      setBusy(false);
    }
  }

  async function revokeRead(button) {
    if (busy) return;
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
        button.closest('[data-grant-item]')?.remove();
        bumpGrantCount(keyId, -1);
        refreshGrantEmptyState(keyId);
        notify('success', '已撤回读取授权');
      } else {
        notify('info', '该授权已不存在');
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

  keyRows.addEventListener('submit', function (event) {
    const grantForm = event.target.closest('[data-grant-form]');
    if (!grantForm) return;
    event.preventDefault();
    grantRead(grantForm);
  });
})();
