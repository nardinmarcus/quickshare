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
    cell.colSpan = 6;
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

    row.append(name, prefix, version, created, lastUsed, actions);
    keyRows.prepend(row);
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

  keyRows.addEventListener('click', function (event) {
    const rotateButton = event.target.closest('.api-key-rotate-btn');

    if (rotateButton) {
      rotateKey(rotateButton);
      return;
    }

    const button = event.target.closest('.api-key-delete-btn');

    if (button) deleteKey(button);
  });
})();
