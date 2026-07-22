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
    cell.colSpan = 5;
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

    const created = document.createElement('td');
    const createdTime = document.createElement('time');
    createdTime.dateTime = new Date(Number(apiKey.created_at)).toISOString();
    createdTime.textContent = formatTime(apiKey.created_at);
    created.appendChild(createdTime);

    const lastUsed = createCell('从未使用', 'admin-muted');

    const actions = document.createElement('td');
    actions.className = 'admin-actions-col';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'admin-delete-btn api-key-delete-btn';
    remove.dataset.apiKeyId = apiKey.id;
    remove.dataset.apiKeyName = apiKey.name;
    remove.setAttribute('aria-label', '删除 API 密钥 ' + apiKey.name);
    remove.innerHTML = '<i class="fas fa-trash-alt" aria-hidden="true"></i><span class="sr-only">删除</span>';
    actions.appendChild(remove);

    row.append(name, prefix, created, lastUsed, actions);
    keyRows.prepend(row);
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
    const button = event.target.closest('.api-key-delete-btn');

    if (button) deleteKey(button);
  });
})();
