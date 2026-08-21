(() => {
  'use strict';

  const config = window.SHuangfaCloudLicenseConfig || {};
  const state = { adminPassword: '' };
  const $ = id => document.getElementById(id);

  const adminPanel = $('adminPanel');
  const generatorPanel = $('generatorPanel');
  const resultPanel = $('resultPanel');
  const adminPassword = $('adminPassword');
  const unlockButton = $('unlockButton');
  const adminStatus = $('adminStatus');
  const form = $('licenseForm');
  const plan = $('plan');
  const term = $('term');
  const expiryField = $('expiryField');
  const expiryDate = $('expiryDate');
  const maxDevices = $('maxDevices');
  const offlineGraceDays = $('offlineGraceDays');
  const generateButton = $('generateButton');
  const clearButton = $('clearButton');
  const formStatus = $('formStatus');
  const licenseCode = $('licenseCode');
  const licenseDetails = $('licenseDetails');
  const copyButton = $('copyButton');

  function setStatus(element, message, type = '') {
    element.textContent = message || '';
    element.className = `status${type ? ` ${type}` : ''}`;
  }

  function updatePlanDefaults() {
    if (plan.value === '測試版') {
      maxDevices.value = '10';
      if (!expiryDate.value) expiryDate.value = '2026-09-19';
    } else if (plan.value === '正式版') {
      maxDevices.value = '1';
    }
  }

  function updateExpiryVisibility() {
    expiryField.classList.toggle('hidden', term.value === 'perpetual');
  }

  function getExpiryValue() {
    if (term.value === 'perpetual') return null;
    if (term.value === 'custom') {
      if (!expiryDate.value) throw new Error('請選擇到期日。');
      const expiry = new Date(`${expiryDate.value}T23:59:59+08:00`);
      if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now()) throw new Error('到期日必須晚於今天。');
      return expiry.toISOString();
    }
    return null;
  }

  function friendlyError(body, response) {
    const raw = String(body?.message || body?.details || body?.hint || body?.code || '');
    const match = raw.match(/LICENSE_[A-Z_]+|DEVICE_[A-Z_]+/);
    const code = match?.[0] || '';
    const messages = {
      LICENSE_ADMIN_AUTH_FAILED: '管理員密碼不正確。',
      LICENSE_COMPANY_REQUIRED: '請輸入公司名稱。',
      LICENSE_MAX_DEVICES_INVALID: '裝置數量必須介於 1 到 1000。',
      LICENSE_GRACE_DAYS_INVALID: '離線寬限天數不正確。',
      LICENSE_CUSTOM_EXPIRY_REQUIRED: '請輸入到期日。',
      LICENSE_EXPIRY_MUST_BE_FUTURE: '到期日必須晚於現在。',
      LICENSE_TERM_INVALID: '有效期限選項不正確。'
    };
    return messages[code] || raw || `產生失敗（HTTP ${response.status}）。`;
  }

  async function issueLicense(payload) {
    const baseUrl = String(config.supabaseUrl || '').replace(/\/+$/, '');
    const anonKey = String(config.supabaseAnonKey || '');
    if (!baseUrl || !anonKey) throw new Error('雲端授權設定不完整。');
    const response = await fetch(`${baseUrl}/rest/v1/rpc/issue_license_for_admin`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(friendlyError(body, response));
    return Array.isArray(body) ? body[0] : body;
  }

  function renderResult(result) {
    const code = String(result?.licenseCode || '');
    if (!code) throw new Error('雲端沒有回傳授權碼。');
    licenseCode.textContent = code;
    const rows = [
      ['公司', result.company],
      ['方案', result.plan],
      ['有效期限', result.expiresAt ? new Date(result.expiresAt).toLocaleString('zh-TW') : '永久'],
      ['裝置上限', `${result.maxDevices} 台`],
      ['離線寬限', `${result.offlineGraceDays} 天`]
    ];
    licenseDetails.innerHTML = rows.map(([label, value]) => `<dt>${label}</dt><dd>${String(value ?? '')}</dd>`).join('');
    resultPanel.classList.remove('hidden');
    resultPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  unlockButton.addEventListener('click', () => {
    const password = adminPassword.value.trim();
    if (!password) {
      setStatus(adminStatus, '請輸入管理員密碼。', 'error');
      adminPassword.focus();
      return;
    }
    state.adminPassword = password;
    adminPanel.classList.add('hidden');
    generatorPanel.classList.remove('hidden');
    setStatus(formStatus, '已通過本頁驗證；按下產生時才會向雲端確認密碼。', 'success');
    $('companyName').focus();
  });

  adminPassword.addEventListener('keydown', event => {
    if (event.key === 'Enter') unlockButton.click();
  });
  plan.addEventListener('change', updatePlanDefaults);
  term.addEventListener('change', updateExpiryVisibility);

  form.addEventListener('submit', async event => {
    event.preventDefault();
    setStatus(formStatus, '正在建立授權碼…');
    generateButton.disabled = true;
    try {
      const expiry = getExpiryValue();
      const payload = {
        p_admin_password: state.adminPassword,
        p_company_name: $('companyName').value.trim(),
        p_term: term.value === 'perpetual' ? '永久' : term.value,
        p_expires_at: expiry,
        p_plan: plan.value,
        p_max_devices: Number(maxDevices.value),
        p_offline_grace_days: Number(offlineGraceDays.value),
        p_active: true
      };
      const result = await issueLicense(payload);
      renderResult(result);
      setStatus(formStatus, '授權碼建立成功。', 'success');
    } catch (error) {
      setStatus(formStatus, error.message || '產生失敗，請稍後再試。', 'error');
    } finally {
      generateButton.disabled = false;
    }
  });

  clearButton.addEventListener('click', () => {
    resultPanel.classList.add('hidden');
    licenseCode.textContent = '';
    licenseDetails.innerHTML = '';
    setStatus(formStatus, '已清除上一組結果。');
  });

  copyButton.addEventListener('click', async () => {
    const code = licenseCode.textContent.trim();
    try {
      await navigator.clipboard.writeText(code);
      copyButton.textContent = '已複製';
      setTimeout(() => { copyButton.textContent = '複製授權碼'; }, 1600);
    } catch {
      setStatus(formStatus, '瀏覽器禁止自動複製，請長按授權碼手動複製。', 'error');
    }
  });

  updatePlanDefaults();
  updateExpiryVisibility();
})();
