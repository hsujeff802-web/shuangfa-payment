/* 雙發付款管理系統 V8.3 Build 0321
   雲端授權／裝置綁定、登入權限、已付款鎖定、修改紀錄、智慧語音提醒 */
(() => {
  'use strict';

  const AUTH_KEY = 'shuangfa_v83_auth_rc';
  const SESSION_KEY = 'shuangfa_v83_session_rc';
  const DEFAULT_CODE = 'admin';
  const DEFAULT_PASSWORD = '1234';
  const IDLE_MS = 30 * 60 * 1000;

  let currentUser = null;
  let failedAttempts = 0;
  let lockUntil = 0;
  let idleTimer = null;
  let voiceReady = false;
  let pendingVoice = [];
  const scheduledVoiceTimers = new Set();
  let voiceGeneration = 0;
  let audioContext = null;
  let activeAudio = null;
  let activeAudioCancel = null;
  let editingPaymentId = '';
  let settingsAccessGranted = false;
  let logoutInProgress = false;
  let signatureFeedbackAllowed = false;
  const LICENSE_KEY = 'shuangfa_v83_license_rc';
  const LICENSE_IDB_KEY = 'shuangfa_v83_license_rc';
  const DEVICE_IDB_KEY = 'shuangfa_v83_device_rc';
  const DEVICE_KEY = 'shuangfa_v83_device_rc';
  const LICENSE_COOKIE = 'shuangfa_v83_license_rc';
  const DEVICE_COOKIE = 'shuangfa_v83_device_rc';
  const LICENSE_DB_NAME = 'shuangfa_license_v1_rc';
  const LICENSE_DB_STORE = 'license';
  const CLOUD_LICENSE_CONFIG = window.SHuangfaCloudLicenseConfig || {};
  const LICENSE_ENABLED = Boolean(
    CLOUD_LICENSE_CONFIG.enabled &&
    String(CLOUD_LICENSE_CONFIG.supabaseUrl || '').trim() &&
    String(CLOUD_LICENSE_CONFIG.supabaseAnonKey || '').trim()
  );
  const LICENSE_CACHE_NAME = 'shuangfa-payment-license-v1';
  const LICENSE_CODE_KEY = 'shuangfa_v83_license_code_rc';
  const LICENSE_CODE_COOKIE = 'shuangfa_v83_license_code_rc';
  const LICENSE_SECRET = 'shuangfa-v83-offline-license-2026';
  let licenseState = null;
  let licenseReady = false;
  let deviceIdCache = '';
  let licenseValidationMessage = '';

  const q = selector => document.querySelector(selector);
  const qa = selector => [...document.querySelectorAll(selector)];
  const now = () => new Date().toISOString();
  const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

  // Safari／iPad 可能因私密瀏覽或網站資料限制，讓 localStorage 無法長期保存。
  // 授權資料使用獨立 IndexedDB，再以 Cookie 作第二層備援，避免付款資料庫忙碌時連授權也無法讀回。
  function safeLocalGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }

  function safeLocalSet(key, value) {
    try { localStorage.setItem(key, value); return true; } catch { return false; }
  }

  function safeLocalRemove(key) {
    try { localStorage.removeItem(key); } catch {}
  }

  function cloneForStorage(value) {
    try {
      if (typeof structuredClone === 'function') return structuredClone(value);
      return JSON.parse(JSON.stringify(value));
    } catch { return value; }
  }

  function safeCookieGet(key) {
    try {
      const prefix = `${encodeURIComponent(key)}=`;
      const item = document.cookie.split('; ').find(part => part.startsWith(prefix));
      return item ? decodeURIComponent(item.slice(prefix.length)) : null;
    } catch { return null; }
  }

  function safeCookieSet(key, value) {
    try {
      document.cookie = `${encodeURIComponent(key)}=${encodeURIComponent(value)}; Max-Age=315360000; Path=/; SameSite=Lax`;
      return safeCookieGet(key) === String(value);
    } catch { return false; }
  }

  function licenseCacheRequest(key) {
    try {
      const base = new URL('./', window.location.href);
      return new Request(new URL(`.shuangfa-license/${encodeURIComponent(key)}`, base).href);
    } catch { return null; }
  }

  async function readLicenseCache(key) {
    if (!('caches' in window)) return null;
    const request = licenseCacheRequest(key);
    if (!request) return null;
    try {
      const cache = await caches.open(LICENSE_CACHE_NAME);
      const response = await cache.match(request);
      return response ? await response.json() : null;
    } catch (error) {
      console.warn('獨立授權快取讀取略過', error);
      return null;
    }
  }

  async function writeLicenseCache(value, key) {
    if (!('caches' in window)) return false;
    const request = licenseCacheRequest(key);
    if (!request) return false;
    try {
      const cache = await caches.open(LICENSE_CACHE_NAME);
      await cache.put(request, new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }));
      return true;
    } catch (error) {
      console.warn('獨立授權快取寫入略過', error);
      return false;
    }
  }

  function readRawLicenseCode() {
    return String(safeLocalGet(LICENSE_CODE_KEY) || safeCookieGet(LICENSE_CODE_COOKIE) || '').trim();
  }

  function writeRawLicenseCode(code) {
    const raw = String(code || '').trim();
    if (!raw) return false;
    const localSaved = safeLocalSet(LICENSE_CODE_KEY, raw);
    const cookieSaved = safeCookieSet(LICENSE_CODE_COOKIE, raw);
    return localSaved || cookieSaved;
  }

  function licenseCookieKey(key) {
    return key === LICENSE_IDB_KEY ? LICENSE_COOKIE : key === DEVICE_IDB_KEY ? DEVICE_COOKIE : '';
  }

  function openLicenseDB() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('此瀏覽器不支援 IndexedDB'));
      const request = indexedDB.open(LICENSE_DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(LICENSE_DB_STORE)) request.result.createObjectStore(LICENSE_DB_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('授權資料庫開啟失敗'));
      request.onblocked = () => reject(new Error('授權資料庫目前被其他分頁占用'));
    });
  }

  async function readDedicatedLicenseStore(key) {
    const idb = await openLicenseDB();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { idb.close(); } catch {}
        fn(value);
      };
      const timer = setTimeout(() => finish(reject, new Error('授權資料庫讀取逾時')), 8000);
      try {
        const tx = idb.transaction(LICENSE_DB_STORE, 'readonly');
        const request = tx.objectStore(LICENSE_DB_STORE).get(key);
        request.onsuccess = () => finish(resolve, request.result || null);
        request.onerror = () => finish(reject, request.error || new Error('授權資料庫讀取失敗'));
        tx.onerror = () => finish(reject, tx.error || new Error('授權資料庫讀取交易失敗'));
        tx.onabort = () => finish(reject, tx.error || new Error('授權資料庫讀取交易已中止'));
      } catch (error) { finish(reject, error); }
    });
  }

  async function writeDedicatedLicenseStore(value, key) {
    const idb = await openLicenseDB();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { idb.close(); } catch {}
        fn(result);
      };
      const timer = setTimeout(() => finish(reject, new Error('授權資料庫寫入逾時')), 8000);
      try {
        const tx = idb.transaction(LICENSE_DB_STORE, 'readwrite');
        tx.oncomplete = () => finish(resolve, true);
        tx.onerror = () => finish(reject, tx.error || new Error('授權資料庫寫入失敗'));
        tx.onabort = () => finish(reject, tx.error || new Error('授權資料庫寫入交易已中止'));
        tx.objectStore(LICENSE_DB_STORE).put(cloneForStorage(value), key);
      } catch (error) { finish(reject, error); }
    });
  }

  async function readLicenseStores(key) {
    const values = [];
    const add = value => {
      if (!value || typeof value !== 'object') return;
      if (!values.some(item => JSON.stringify(item) === JSON.stringify(value))) values.push(value);
    };
    try { add(await readDedicatedLicenseStore(key)); }
    catch (error) { console.warn('獨立授權資料庫讀取略過', error); }
    try { add(await readLicenseCache(key)); }
    catch (error) { console.warn('獨立授權快取讀取略過', error); }
    const cookieKey = licenseCookieKey(key);
    if (cookieKey) {
      try { add(JSON.parse(safeCookieGet(cookieKey) || 'null')); } catch {}
    }
    try {
      if (typeof readFromIndexedDB === 'function') add(await readFromIndexedDB(key));
    } catch (error) { console.warn('既有授權資料庫讀取略過', error); }
    return values;
  }

  async function readLicenseStore(key) {
    return (await readLicenseStores(key))[0] || null;
  }

  async function writeLicenseStore(value, key) {
    let saved = false;
    try { await writeDedicatedLicenseStore(value, key); saved = true; }
    catch (error) { console.warn('獨立授權資料庫寫入略過', error); }
    try { saved = await writeLicenseCache(value, key) || saved; }
    catch (error) { console.warn('獨立授權快取寫入略過', error); }
    try {
      if (typeof writeToIndexedDB === 'function') { await writeToIndexedDB(value, key); saved = true; }
    } catch (error) { console.warn('既有授權資料庫寫入略過', error); }
    const cookieKey = licenseCookieKey(key);
    if (cookieKey) saved = safeCookieSet(cookieKey, JSON.stringify(value)) || saved;
    return saved;
  }

  function savedDeviceIdSync() {
    const candidates = [
      safeLocalGet(LICENSE_KEY),
      safeCookieGet(LICENSE_COOKIE),
      safeCookieGet(DEVICE_COOKIE)
    ];
    for (const candidate of candidates) {
      const raw = String(candidate || '').trim();
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        const id = parsed?.id || parsed?.device;
        if (id) return String(id).trim();
      } catch {}
    }
    return String(safeLocalGet(DEVICE_KEY) || '').trim();
  }

  async function adoptDeviceId(value) {
    const id = String(value || '').trim();
    if (!id) return '';
    deviceIdCache = id;
    safeLocalSet(DEVICE_KEY, id);
    safeCookieSet(DEVICE_COOKIE, JSON.stringify({ id }));
    try { await writeLicenseStore({ id }, DEVICE_IDB_KEY); }
    catch (error) { console.warn('已保存設備識別碼同步略過', error); }
    return id;
  }

  function storageContextLabel() {
    const standalone = navigator.standalone === true || Boolean(window.matchMedia?.('(display-mode: standalone)')?.matches);
    return standalone ? '主畫面 App 模式' : 'Safari 瀏覽器模式';
  }

  async function inspectLicenseStorage() {
    const local = (() => { try { return JSON.parse(safeLocalGet(LICENSE_KEY) || 'null'); } catch { return null; } })();
    const cookie = (() => { try { return JSON.parse(safeCookieGet(LICENSE_COOKIE) || 'null'); } catch { return null; } })();
    const rawCode = readRawLicenseCode();
    const dedicated = await readDedicatedLicenseStore(LICENSE_IDB_KEY).catch(() => null);
    const legacy = typeof readFromIndexedDB === 'function' ? await readFromIndexedDB(LICENSE_IDB_KEY).catch(() => null) : null;
    const cache = await readLicenseCache(LICENSE_IDB_KEY);
    const stored = [local, dedicated, legacy, cache, cookie].filter(value => value && typeof value === 'object');
    const code = licenseState?.code || '';
    const storedCode = local?.code || rawCode || dedicated?.code || legacy?.code || cache?.code || cookie?.code || '';
    return {
      context: storageContextLabel(),
      local: Boolean(local?.code),
      indexedDB: Boolean(dedicated?.code || legacy?.code),
      cache: Boolean(cache?.code),
      cookie: Boolean(cookie?.code),
      rawCode: Boolean(rawCode),
      hasStored: Boolean(storedCode),
      valid: Boolean(licenseState?.code),
      matched: Boolean(code && (rawCode === code || stored.some(item => item?.code === code)))
    };
  }

  async function renderLicenseStorageStatus() {
    const elements = [q('#licenseStorageStatus'), q('#licenseStorageStatusSettings')].filter(Boolean);
    if (!elements.length) return;
    elements.forEach(element => { element.textContent = '正在檢查授權保存狀態…'; });
    try {
      const result = await inspectLicenseStorage();
      const saved = result.valid && result.matched;
      const details = `本機儲存：${result.local ? '正常' : '未讀到'}｜資料庫：${result.indexedDB ? '正常' : '未讀到'}｜快取：${result.cache ? '正常' : '未讀到'}｜Cookie：${result.cookie || result.rawCode ? '正常' : '未讀到'}`;
      const connection = licenseState?.offline ? '目前離線使用，仍在雲端授權的離線寬限期內' : licenseState?.recovery === 'device' ? '雲端已恢復（裝置綁定）' : licenseState?.cloud ? '雲端已驗證' : '尚未完成雲端驗證';
      const message = saved
        ? `✅ 授權已驗證並保存（${connection}／${result.context}）<br><small>${details}</small>`
        : result.hasStored
          ? `⚠️ 授權資料已保存，但目前未通過驗證。${licenseValidationMessage ? `<br>${licenseValidationMessage}` : '<br>請連網重新驗證，或確認使用一般瀏覽模式。'}<br><small>${details}</small>`
          : `⚠️ 目前尚未讀到可恢復的授權（${result.context}）。請連網輸入公司專用授權碼；不要使用私密瀏覽。<br><small>${details}</small>`;
      elements.forEach(element => { element.innerHTML = message; });
    } catch (error) {
      elements.forEach(element => { element.textContent = `⚠️ 授權保存檢測失敗：${error.message || '請確認瀏覽模式'}`; });
    }
  }

  async function checkLicenseStorage(button) {
    if (button) { button.disabled = true; button.textContent = '檢查中…'; }
    try {
      // 啟動時若先顯示授權畫面，但保存資料仍在瀏覽器中，先重新執行
      // 裝置綁定恢復；不要要求使用者再次貼上授權碼。
      if (LICENSE_ENABLED && (!licenseReady || !licenseState)) {
        licenseReady = await ensureLicense();
      }
      if (LICENSE_ENABLED && licenseState?.code && navigator.onLine !== false) {
        try {
          const refreshed = licenseState?.recovery === 'device'
            ? await callCloudLicenseByDevice(licenseState.device || getDeviceId())
            : await callCloudLicense(licenseState.code);
          refreshed.activatedAt = licenseState.activatedAt || refreshed.activatedAt || now();
          licenseState = refreshed;
          licenseReady = true;
          await persistLicenseState(licenseState);
        } catch (error) {
          licenseValidationMessage = error.message || '雲端授權驗證失敗';
          if (!error.transient) {
            licenseState = null;
            licenseReady = false;
          }
        }
      } else if (licenseState?.code) {
        await persistLicenseState(licenseState);
      }
      await renderLicenseStorageStatus();
      const result = await inspectLicenseStorage();
      const verified = result.valid && result.matched;
      if (verified) {
        licenseReady = true;
        hideLicenseGate();
        await ensureAuth();
        await restoreSession();
      }
      originalToast(verified
        ? `授權已驗證並保存（${licenseState?.offline ? '離線寬限' : licenseState?.recovery === 'device' ? '雲端恢復' : '雲端驗證'}／${result.context}）`
        : result.hasStored
          ? `授權資料已保存，但驗證未通過：${licenseValidationMessage || '請連網重新驗證。'}`
          : '目前沒有讀到可恢復的授權，請連網輸入授權碼。');
    } catch (error) {
      originalToast(error.message || '授權保存檢查失敗');
    } finally {
      if (button) { button.disabled = false; button.textContent = '檢查授權保存'; }
    }
  }

  async function requestPersistentStorage() {
    try {
      if (navigator.storage?.persist) await navigator.storage.persist();
    } catch (error) { console.warn('請求持久儲存略過', error); }
  }

  async function persistLicenseState(state) {
    await requestPersistentStorage();
    const localSaved = safeLocalSet(LICENSE_KEY, JSON.stringify(state));
    const indexedDbSaved = await writeLicenseStore(state, LICENSE_IDB_KEY);
    const cookieSaved = safeCookieSet(LICENSE_COOKIE, JSON.stringify(state));
    const rawSaved = writeRawLicenseCode(state.code);
    const stored = await readLicenseStores(LICENSE_IDB_KEY);
    const cacheStored = await readLicenseCache(LICENSE_IDB_KEY);
    const localVerified = (() => { try { return JSON.parse(safeLocalGet(LICENSE_KEY) || 'null')?.code === state.code; } catch { return false; } })();
    const cookieVerified = (() => { try { return JSON.parse(safeCookieGet(LICENSE_COOKIE) || 'null')?.code === state.code; } catch { return false; } })();
    const indexedDbVerified = stored.some(item => item?.code === state.code);
    const rawVerified = readRawLicenseCode() === String(state.code || '');
    const cacheVerified = cacheStored?.code === state.code;
    if ((!localSaved && !indexedDbSaved && !cookieSaved && !rawSaved) || (!localVerified && !cookieVerified && !indexedDbVerified && !rawVerified && !cacheVerified)) {
      throw new Error('此瀏覽器目前禁止保存授權資料，請關閉私密瀏覽後重新開啟。');
    }
    return { localSaved, indexedDbSaved, cookieSaved, rawSaved, localVerified, cookieVerified, indexedDbVerified, rawVerified, cacheVerified };
  }

  async function ensureStableDeviceId() {
    const localId = savedDeviceIdSync();
    if (localId) {
      deviceIdCache = localId;
      safeLocalSet(DEVICE_KEY, deviceIdCache);
      return deviceIdCache;
    }

    const savedLicense = await readLicenseStore(LICENSE_IDB_KEY);
    if (savedLicense?.device) {
      return adoptDeviceId(savedLicense.device);
    }

    const stored = await readLicenseStore(DEVICE_IDB_KEY);
    if (stored?.id) {
      return adoptDeviceId(stored.id);
    }

    deviceIdCache = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return adoptDeviceId(deviceIdCache);
  }

  async function hash(text) {
    if (crypto?.subtle) {
      const data = new TextEncoder().encode(text);
      const digest = await crypto.subtle.digest('SHA-256', data);
      return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
    }
    return btoa(unescape(encodeURIComponent(text)));
  }

  function readAuth() {
    try { return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); }
    catch { return null; }
  }

  function writeAuth(value) {
    localStorage.setItem(AUTH_KEY, JSON.stringify(value));
  }

  function getDeviceId() {
    let id = deviceIdCache || savedDeviceIdSync();
    if (!id) {
      id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      deviceIdCache = id;
      safeLocalSet(DEVICE_KEY, id);
      safeCookieSet(DEVICE_COOKIE, JSON.stringify({ id }));
      void writeLicenseStore({ id }, DEVICE_IDB_KEY);
    }
    safeLocalSet(DEVICE_KEY, id);
    deviceIdCache = id;
    return id;
  }

  function licensePayloadText(payload) {
    return JSON.stringify({
      company: String(payload.company || '').trim(),
      plan: String(payload.plan || '永久'),
      expiresAt: String(payload.expiresAt || ''),
      device: String(payload.device || '')
    });
  }

  function base64UrlEncode(text) {
    return btoa(unescape(encodeURIComponent(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function base64UrlDecode(text) {
    const padded = String(text).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(text).length + 3) % 4);
    return decodeURIComponent(escape(atob(padded)));
  }

  async function licenseDigest(text) {
    if (crypto?.subtle) {
      const data = new TextEncoder().encode(text);
      const digest = await crypto.subtle.digest('SHA-256', data);
      return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 24).toUpperCase();
    }
    let hashValue = 2166136261;
    for (const char of text) { hashValue ^= char.charCodeAt(0); hashValue = Math.imul(hashValue, 16777619); }
    return (hashValue >>> 0).toString(16).padStart(8, '0').toUpperCase();
  }

  async function makeLicenseCode(payload) {
    const text = licensePayloadText(payload);
    const signature = await licenseDigest(`${LICENSE_SECRET}|${text}`);
    return `SF1-${base64UrlEncode(text)}-${signature}`;
  }

  async function decodeLicenseCode(rawCode) {
    const code = String(rawCode || '').trim();
    const match = code.match(/^SF1-([A-Za-z0-9_-]+)-([A-Fa-f0-9]+)$/);
    if (!match) throw new Error('授權碼格式不正確');
    let payload;
    try { payload = JSON.parse(base64UrlDecode(match[1])); } catch { throw new Error('授權碼內容無法讀取'); }
    const expected = await makeLicenseCode(payload);
    if (expected.toUpperCase() !== code.toUpperCase()) throw new Error('授權碼驗證失敗');
    if (!payload.company) throw new Error('授權碼沒有公司名稱');
    if (payload.expiresAt && (!Number.isFinite(Date.parse(payload.expiresAt)) || Date.parse(payload.expiresAt) <= Date.now())) throw new Error('此授權已經到期');
    if (payload.device && payload.device !== getDeviceId()) throw new Error('此授權碼不是這台手機或平板的授權');
    return { ...payload, code };
  }

  function cloudError(message, code = 'CLOUD_UNAVAILABLE', transient = false) {
    const error = new Error(message);
    error.code = code;
    error.transient = transient;
    return error;
  }

  function cloudErrorMessage(code, fallback = '雲端授權驗證失敗') {
    const messages = {
      LICENSE_INPUT_INVALID: '授權碼或設備資料格式不正確。',
      LICENSE_INVALID: '授權碼不存在或不正確。',
      LICENSE_INACTIVE: '此授權已停用，請聯絡授權管理者。',
      LICENSE_EXPIRED: '此授權已到期。',
      DEVICE_LIMIT_REACHED: '此授權已達裝置數量上限。',
      DEVICE_REVOKED: '此裝置已被停用，請聯絡授權管理者。',
      LICENSE_DEVICE_NOT_FOUND: '雲端找不到這台裝置的授權紀錄，請先用公司授權碼啟用一次。',
      CLOUD_RESPONSE_INVALID: '雲端授權回應格式不正確。',
      CLOUD_NOT_READY: '雲端授權資料庫尚未完成設定，請重新執行授權資料表 SQL。',
      CLOUD_AUTH_FAILED: '雲端授權連線被拒絕，請確認 Supabase 公開金鑰設定。',
      CLOUD_UNAVAILABLE: '目前無法連線雲端授權，請先連網啟用。'
    };
    return messages[code] || fallback;
  }

  function cloudDeviceLabel() {
    const standalone = navigator.standalone === true || Boolean(window.matchMedia?.('(display-mode: standalone)')?.matches);
    const apple = /iPad|iPhone|iPod/i.test(navigator.userAgent || '');
    return `${apple ? 'Apple' : '一般'} ${standalone ? '主畫面 App' : '瀏覽器'}｜${navigator.platform || '未知平台'}`.slice(0, 120);
  }

  function isLicenseExpired(state) {
    if (!state?.expiresAt) return false;
    const expires = Date.parse(state.expiresAt);
    return !Number.isFinite(expires) || expires <= Date.now();
  }

  function isOfflineLicenseUsable(state) {
    if (!state?.code || state.device !== getDeviceId() || isLicenseExpired(state)) return false;
    const validatedAt = Date.parse(state.lastValidatedAt || state.activatedAt || '');
    const graceDays = Math.max(0, Number(state.offlineGraceDays ?? CLOUD_LICENSE_CONFIG.offlineFallbackDays ?? 30));
    return Number.isFinite(validatedAt) && Date.now() - validatedAt <= graceDays * 24 * 60 * 60 * 1000;
  }

  async function callCloudLicense(rawCode) {
    const code = String(rawCode || '').trim();
    const deviceId = await ensureStableDeviceId();
    if (!code || code.length > 240 || !deviceId) throw cloudError(cloudErrorMessage('LICENSE_INPUT_INVALID', '請輸入有效的授權碼。'), 'LICENSE_INPUT_INVALID');
    const baseUrl = String(CLOUD_LICENSE_CONFIG.supabaseUrl || '').replace(/\/+$/, '');
    const rpcName = encodeURIComponent(String(CLOUD_LICENSE_CONFIG.rpcName || 'activate_license'));
    const endpoint = `${baseUrl}/rest/v1/rpc/${rpcName}`;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), 12000) : null;
    let response;
    let body = null;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        signal: controller?.signal,
        headers: {
          apikey: String(CLOUD_LICENSE_CONFIG.supabaseAnonKey),
          Authorization: `Bearer ${String(CLOUD_LICENSE_CONFIG.supabaseAnonKey)}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          p_license_code: code,
          p_device_id: deviceId,
          p_device_label: cloudDeviceLabel(),
          p_platform: String(navigator.platform || navigator.userAgent || '').slice(0, 120),
          p_app_version: 'V8.3 Build 0321'
        })
      });
      body = await response.json().catch(() => null);
    } catch (error) {
      const message = error?.name === 'AbortError' ? '雲端授權連線逾時，請確認網路後重試。' : cloudErrorMessage('CLOUD_UNAVAILABLE');
      throw cloudError(message, 'CLOUD_UNAVAILABLE', true);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    if (!response.ok) {
      const raw = String(body?.message || body?.hint || body?.details || body?.code || '');
      const match = raw.match(/LICENSE_[A-Z_]+|DEVICE_[A-Z_]+/);
      const codeName = match?.[0]
        || (response.status === 401 || response.status === 403 ? 'CLOUD_AUTH_FAILED'
          : response.status === 404 || response.status === 405 ? 'CLOUD_NOT_READY'
            : response.status >= 500 || response.status === 429 ? 'CLOUD_UNAVAILABLE' : 'LICENSE_INVALID');
      throw cloudError(cloudErrorMessage(codeName, raw || undefined), codeName, response.status >= 500 || response.status === 429);
    }
    const result = Array.isArray(body) ? body[0] : body;
    if (!result?.company || !result?.deviceId) throw cloudError(cloudErrorMessage('CLOUD_RESPONSE_INVALID'), 'CLOUD_RESPONSE_INVALID', true);
    if (String(result.deviceId) !== deviceId) throw cloudError('雲端回傳的設備識別不一致，請重新啟用。', 'CLOUD_RESPONSE_INVALID');
    return {
      version: 2,
      cloud: true,
      offline: false,
      code,
      company: String(result.company),
      plan: String(result.plan || '授權版'),
      expiresAt: String(result.expiresAt || ''),
      maxDevices: Math.max(1, Number(result.maxDevices || 1)),
      offlineGraceDays: Math.max(0, Number(result.offlineGraceDays ?? CLOUD_LICENSE_CONFIG.offlineFallbackDays ?? 30)),
      device: deviceId,
      lastValidatedAt: String(result.lastValidatedAt || now()),
      activatedAt: licenseState?.activatedAt || now()
    };
  }

  // 同一台已綁定裝置若只遺失瀏覽器的授權快取，使用裝置識別向雲端恢復授權。
  // 這裡不會取得或保存原始授權碼；恢復後只保存裝置綁定的本機狀態。
  async function callCloudLicenseByDevice(deviceId = '') {
    const id = String(deviceId || '').trim();
    if (!id) throw cloudError(cloudErrorMessage('LICENSE_INPUT_INVALID'), 'LICENSE_INPUT_INVALID');
    const baseUrl = String(CLOUD_LICENSE_CONFIG.supabaseUrl || '').replace(/\/+$/, '');
    const rpcName = encodeURIComponent(String(CLOUD_LICENSE_CONFIG.restoreRpcName || 'restore_license_by_device'));
    const endpoint = `${baseUrl}/rest/v1/rpc/${rpcName}`;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), 12000) : null;
    let response;
    let body = null;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        signal: controller?.signal,
        headers: {
          apikey: String(CLOUD_LICENSE_CONFIG.supabaseAnonKey),
          Authorization: `Bearer ${String(CLOUD_LICENSE_CONFIG.supabaseAnonKey)}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          p_device_id: id,
          p_device_label: cloudDeviceLabel(),
          p_platform: String(navigator.platform || navigator.userAgent || '').slice(0, 120),
          p_app_version: 'V8.3 Build 0321'
        })
      });
      body = await response.json().catch(() => null);
    } catch (error) {
      const message = error?.name === 'AbortError' ? '雲端授權連線逾時，請確認網路後重試。' : cloudErrorMessage('CLOUD_UNAVAILABLE');
      throw cloudError(message, 'CLOUD_UNAVAILABLE', true);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    if (!response.ok) {
      const raw = String(body?.message || body?.hint || body?.details || body?.code || '');
      const match = raw.match(/LICENSE_[A-Z_]+|DEVICE_[A-Z_]+/);
      const codeName = match?.[0]
        || (response.status === 401 || response.status === 403 ? 'CLOUD_AUTH_FAILED'
          : response.status === 404 || response.status === 405 ? 'CLOUD_NOT_READY'
            : response.status >= 500 || response.status === 429 ? 'CLOUD_UNAVAILABLE' : 'LICENSE_DEVICE_NOT_FOUND');
      throw cloudError(cloudErrorMessage(codeName, raw || undefined), codeName, response.status >= 500 || response.status === 429);
    }
    const result = Array.isArray(body) ? body[0] : body;
    if (!result?.company || !result?.deviceId) throw cloudError(cloudErrorMessage('CLOUD_RESPONSE_INVALID'), 'CLOUD_RESPONSE_INVALID', true);
    if (String(result.deviceId) !== id) throw cloudError('雲端回傳的設備識別不一致，請重新啟用。', 'CLOUD_RESPONSE_INVALID');
    return {
      version: 3,
      cloud: true,
      recovery: 'device',
      offline: false,
      code: `DEVICE-RECOVERY:${id}`,
      company: String(result.company),
      plan: String(result.plan || '授權版'),
      expiresAt: String(result.expiresAt || ''),
      maxDevices: Math.max(1, Number(result.maxDevices || 1)),
      offlineGraceDays: Math.max(0, Number(result.offlineGraceDays ?? CLOUD_LICENSE_CONFIG.offlineFallbackDays ?? 30)),
      device: id,
      lastValidatedAt: String(result.lastValidatedAt || now()),
      activatedAt: licenseState?.activatedAt || now()
    };
  }

  async function readLicenseCandidates() {
    const candidates = [];
    const add = value => {
      if (!value || typeof value !== 'object' || !value.code) return;
      if (!candidates.some(item => item.code === value.code && item.device === value.device && item.lastValidatedAt === value.lastValidatedAt)) candidates.push(value);
    };
    const rawCode = readRawLicenseCode();
    if (rawCode) add({ code: rawCode });
    try { add(JSON.parse(safeLocalGet(LICENSE_KEY) || 'null')); } catch {}
    try { (await readLicenseStores(LICENSE_IDB_KEY)).forEach(add); } catch (error) { console.warn('授權資料讀取略過', error); }
    return candidates;
  }

  async function ensureLicense() {
    if (!LICENSE_ENABLED) {
      licenseValidationMessage = '';
      licenseState = { version: 1, company: settings?.systemName || '雙發付款管理系統', plan: '單機版', expiresAt: '', device: '', legacy: true, code: 'AUTH-DISABLED', activatedAt: now() };
      return true;
    }
    licenseValidationMessage = '';
    const candidates = await readLicenseCandidates();
    const stored = candidates.find(item => item?.code && item.device) || candidates.find(item => item?.code);
    if (!stored?.code) {
      const deviceId = await ensureStableDeviceId();
      if (navigator.onLine !== false && deviceId) {
        try {
          licenseState = await callCloudLicenseByDevice(deviceId);
          await persistLicenseState(licenseState);
          return true;
        } catch (error) {
          licenseValidationMessage = error.message || '雲端裝置授權恢復失敗';
          console.warn('雲端裝置授權恢復失敗', error);
        }
      }
      licenseState = null;
      return false;
    }

    // 先恢復上次雲端驗證成功的裝置 ID，再呼叫雲端；避免瀏覽器／主畫面 App
    // 因儲存層順序不同而先產生新 ID，導致每次開啟都被要求重新輸入授權碼。
    if (stored.device) await adoptDeviceId(stored.device);
    else await ensureStableDeviceId();

    if (navigator.onLine !== false) {
      try {
        licenseState = stored.recovery === 'device'
          ? await callCloudLicenseByDevice(stored.device || getDeviceId())
          : await callCloudLicense(stored.code);
        licenseState.activatedAt = stored.activatedAt || licenseState.activatedAt || now();
        await persistLicenseState(licenseState);
        return true;
      } catch (error) {
        licenseValidationMessage = error.message || '雲端授權驗證失敗';
        console.warn('雲端授權驗證失敗', error);
        const cached = candidates.find(item => isOfflineLicenseUsable(item));
        const hardFailure = ['LICENSE_INVALID', 'LICENSE_INACTIVE', 'LICENSE_EXPIRED', 'DEVICE_REVOKED'].includes(error.code);
        if (cached && !hardFailure) {
          licenseState = { ...cached, cloud: true, offline: true };
          licenseValidationMessage = '雲端暫時未完成重新驗證，已使用最近一次有效授權（離線寬限期內）。';
          return true;
        }
        if (!error.transient) {
          licenseState = null;
          return false;
        }
      }
    }

    const cached = candidates.find(item => isOfflineLicenseUsable(item));
    if (cached) {
      licenseState = { ...cached, cloud: true, offline: true };
      licenseValidationMessage = '目前離線使用，仍在授權的離線寬限期間。';
      return true;
    }
    licenseState = null;
    return false;
  }

  function licenseDescription() {
    if (!LICENSE_ENABLED) return '單機版：授權門禁已關閉。登入帳號與密碼仍然有效。';
    if (!licenseState) return '尚未啟用授權。請輸入公司專用授權碼。';
    const expiry = licenseState.expiresAt ? new Date(licenseState.expiresAt).toLocaleDateString('zh-TW') : '永久';
    const connection = licenseState.offline ? '目前離線使用（仍在寬限期）' : licenseState.recovery === 'device' ? '雲端已恢復（裝置綁定）' : '雲端已驗證';
    return `公司：${licenseState.company}<br>授權方案：${licenseState.plan || '授權版'}<br>有效期限：${expiry}<br><small>${connection}</small>`;
  }

  function renderLicenseInfo() {
    if (!LICENSE_ENABLED) return;
    const status = q('#licenseStatus');
    const deviceId = getDeviceId();
    if (status) status.innerHTML = licenseDescription();
    qa('#licenseDeviceIdGate, #licenseDeviceIdSettings').forEach(element => { element.textContent = deviceId; });
    void renderLicenseStorageStatus();
  }

  function showLicenseGate(message = '') {
    if (!LICENSE_ENABLED) return false;
    if (licenseReady && licenseState) {
      hideLicenseGate();
      return false;
    }
    const gate = q('#licenseGate');
    if (!gate) return;
    q('#loginGate')?.classList.add('hidden');
    gate.classList.remove('hidden');
    document.body.classList.add('login-locked');
    renderLicenseInfo();
    if (message) q('#licenseMessage').textContent = message;
    setTimeout(() => q('#licenseCode')?.focus(), 100);
  }

  function hideLicenseGate() {
    q('#licenseGate')?.classList.add('hidden');
    if (!currentUser) document.body.classList.remove('login-locked');
  }

  async function activateLicense() {
    if (!LICENSE_ENABLED) return;
    const code = q('#licenseCode')?.value.trim();
    if (!code) return toast('請輸入授權碼');
    const button = q('#activateLicense');
    if (button) { button.disabled = true; button.textContent = '驗證中…'; }
    try {
      licenseState = await callCloudLicense(code);
      await persistLicenseState(licenseState);
      licenseValidationMessage = '';
      licenseReady = true;
      await ensureAuth();
      hideLicenseGate();
      showLogin();
      renderLicenseInfo();
      originalToast(`授權啟用成功：${licenseState.company}`);
    } catch (error) {
      licenseState = null;
      licenseValidationMessage = error.message || '授權碼無法使用';
      q('#licenseMessage').textContent = error.message || '授權碼無法使用';
      originalToast(error.message || '授權碼無法使用');
    } finally {
      if (button) { button.disabled = false; button.textContent = '啟用系統授權'; }
    }
  }

  async function ensureAuth() {
    let auth = readAuth();
    if (!auth?.users?.length) {
      try {
        const old = JSON.parse(localStorage.getItem('shuangfa_v83_auth') || 'null');
        if (old?.users?.length) {
          auth = old;
          writeAuth(auth);
        }
      } catch (error) { console.warn('RC 登入設定移轉略過', error); }
    }
    if (!auth?.users?.length) {
      auth = {
        version: 1,
        users: [{
          code: DEFAULT_CODE,
          name: '徐鵬雙',
          role: 'admin',
          enabled: true,
          mustChangePassword: true,
          passwordHash: await hash(DEFAULT_PASSWORD),
          createdAt: now()
        }]
      };
      writeAuth(auth);
    }
    return auth;
  }

  async function verifySettingsPassword() {
    if (!currentUser) return false;
    const password = window.prompt('進入系統設定需要輸入目前登入密碼：');
    if (password === null) return false;
    if (!password) {
      toast('請輸入目前登入密碼');
      return false;
    }
    const auth = await ensureAuth();
    const code = String(currentUser.code || '').trim().toLowerCase();
    const user = auth.users.find(x => x.enabled !== false && String(x.code || '').trim().toLowerCase() === code);
    if (!user || user.passwordHash !== await hash(password)) {
      toast('目前登入密碼不正確，無法進入系統設定');
      speak('目前登入密碼不正確，無法進入系統設定。', 'error', true);
      return false;
    }
    return true;
  }

  function saveAudit(action, detail = {}) {
    db.auditLogs = Array.isArray(db.auditLogs) ? db.auditLogs : [];
    db.auditLogs.unshift({
      id: uid(),
      at: now(),
      action,
      userCode: currentUser?.code || 'system',
      userName: currentUser?.name || '系統',
      detail
    });
    db.auditLogs = db.auditLogs.slice(0, 2000);
    try {
      const pending = save();
      // IndexedDB 是非同步保存；先掛上錯誤處理，避免未等待的紀錄造成未處理 Promise。
      if (pending && typeof pending.catch === 'function') {
        pending.catch(error => console.warn('操作紀錄儲存失敗', error));
      }
      return pending;
    } catch (error) {
      console.warn('操作紀錄儲存失敗', error);
      return false;
    }
  }

  function voiceSettings() {
    return {
      enabled: settings.voiceEnabled !== false,
      errors: settings.voiceErrors !== false,
      success: settings.voiceSuccess !== false,
      backup: settings.voiceBackup !== false,
      due: settings.voiceDue !== false,
      volume: Number(settings.voiceVolume ?? 0.9),
      rate: Number(settings.voiceRate || 1),
      gender: ['auto', 'female', 'male'].includes(settings.voiceGender) ? settings.voiceGender : 'auto'
    };
  }

  function voiceAllowed(kind) {
    const v = voiceSettings();
    if (!v.enabled) return false;
    if (kind === 'error') return v.errors;
    if (kind === 'backup') return v.backup;
    if (kind === 'due') return v.due;
    return v.success;
  }

  function signatureVoiceBlocked() {
    return !!document.querySelector('#signature.active') && !signatureFeedbackAllowed;
  }

  function cancelVoicePlayback() {
    voiceGeneration += 1;
    for (const timer of scheduledVoiceTimers) clearTimeout(timer);
    scheduledVoiceTimers.clear();
    pendingVoice = [];
    try { window.speechSynthesis?.cancel?.(); } catch {}
    try { activeAudioCancel?.(); } catch {}
    activeAudio = null;
    activeAudioCancel = null;
  }

  function playTone(kind = 'success') {
    if (signatureVoiceBlocked() || !voiceAllowed(kind)) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      audioContext = audioContext || new AudioCtx();
      if (audioContext.state === 'suspended') audioContext.resume();
      const start = audioContext.currentTime;
      const notes = kind === 'error' ? [330, 240] : kind === 'due' ? [660, 880, 660] : [660, 880];
      notes.forEach((frequency, index) => {
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();
        osc.type = 'sine';
        osc.frequency.value = frequency;
        const at = start + index * 0.13;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(Math.max(0.015, voiceSettings().volume * 0.055), at + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.11);
        osc.connect(gain).connect(audioContext.destination);
        osc.start(at);
        osc.stop(at + 0.12);
      });
      if (navigator.vibrate && kind === 'error') navigator.vibrate(90);
    } catch (error) {
      console.warn('提示音播放失敗', error);
    }
  }

  function voiceMatchesGender(voice, gender) {
    if (gender === 'auto') return true;
    const label = `${voice?.name || ''} ${voice?.voiceURI || ''}`.toLowerCase();
    const female = /(female|woman|girl|女聲|女音|mei[-\s]?jia|sin[-\s]?ji|ting[-\s]?ting|tingting)/i.test(label);
    const male = /(male|man|boy|男聲|男音|li[-\s]?mu|lisheng|li[-\s]?sheng)/i.test(label);
    return gender === 'female' ? female : male;
  }

  function getChineseVoice() {
    const voices = window.speechSynthesis?.getVoices?.() || [];
    const chinese = voices.filter(v => /^zh/i.test(v.lang));
    const preferred = chinese.filter(v => /zh[-_]TW/i.test(v.lang));
    const candidates = preferred.length ? preferred : chinese;
    const gender = voiceSettings().gender;
    return candidates.find(v => voiceMatchesGender(v, gender)) || candidates[0] || null;
  }

  function speakNow(text, kind = 'success', force = false) {
    if (signatureVoiceBlocked() || !text || (!force && !voiceAllowed(kind))) return false;
    playTone(kind);
    if (!('speechSynthesis' in window)) return false;
    try {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'zh-TW';
      utterance.rate = voiceSettings().rate;
      utterance.volume = voiceSettings().volume;
      const voice = getChineseVoice();
      if (voice) utterance.voice = voice;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
      return true;
    } catch (error) {
      console.warn('語音播放失敗', error);
      return false;
    }
  }

  function speak(text, kind = 'success', force = false) {
    if (signatureVoiceBlocked() || (!force && !voiceAllowed(kind))) return;
    const generation = voiceGeneration;
    const isWorkCompletion = /完成|已儲存|已備份|已清除|已修改|壓縮完成|還原完成/.test(String(text || ''));
    const play = () => {
      if (generation !== voiceGeneration || signatureVoiceBlocked()) return;
      if (!voiceReady && !force) {
        pendingVoice.push({ text, kind });
        return;
      }
      speakNow(text, kind, force);
    };
    // 儲存、備份、完成工作後先停一秒，再播放中文語音。
    if (isWorkCompletion && (kind === 'success' || kind === 'backup')) {
      const timer = setTimeout(() => { scheduledVoiceTimers.delete(timer); play(); }, 1000);
      scheduledVoiceTimers.add(timer);
    }
    else play();
  }

  function unlockVoice() {
    voiceReady = true;
    if (signatureVoiceBlocked()) { pendingVoice = []; return; }
    const item = pendingVoice.shift();
    if (item) speakNow(item.text, item.kind);
  }

  function unlockPlayback() {
    unlockVoice();
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      audioContext = audioContext || new AudioCtx();
      if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
      window.speechSynthesis?.getVoices?.();
    } catch (error) {
      console.warn('登入／登出播放權限啟用失敗', error);
    }
  }

  function unlockFromFirstUserGesture() {
    unlockPlayback();
    ['pointerdown', 'touchstart', 'keydown', 'click'].forEach(type => {
      window.removeEventListener(type, unlockFromFirstUserGesture, true);
    });
  }
  ['pointerdown', 'touchstart', 'keydown', 'click'].forEach(type => {
    window.addEventListener(type, unlockFromFirstUserGesture, true);
  });

  function speakAfterSignature(text, kind = 'success') {
    if (!text || !voiceAllowed(kind)) return false;
    signatureFeedbackAllowed = true;
    try {
      // 若完成提示是在非同步儲存後播放，仍重新喚醒已建立的播放環境。
      unlockPlayback();
      return speakNow(text, kind, true);
    } finally {
      signatureFeedbackAllowed = false;
    }
  }

  window.shuangfaSpeak = speak;
  window.shuangfaSpeakAfterSignature = speakAfterSignature;
  window.shuangfaCancelVoice = cancelVoicePlayback;

  function injectUI() {
    document.body.insertAdjacentHTML('afterbegin', `
      <div id="licenseGate" class="login-gate hidden" aria-modal="true" role="dialog">
        <div class="login-panel license-panel">
          <div class="login-brand">
            <img src="icon-192.png" alt="系統 Logo" class="login-logo">
            <h2>系統授權啟用</h2>
          </div>
          <p class="license-intro">此系統需要公司專用授權才能使用。第一次在手機、平板或電腦開啟時請連網啟用；之後付款資料、照片、簽名與備份仍保存在本機，雲端只驗證授權與設備狀態。Safari 網頁版與主畫面 App 可能算不同設備，請固定使用同一種開啟方式，不要使用私密瀏覽。</p>
          <div id="licenseMessage" class="login-message">請輸入授權碼開始使用。</div>
          <div class="lock-notice"><b>本機設備識別碼</b><br><span id="licenseDeviceIdGate"></span><br><small>如需綁定手機／平板，請把此識別碼提供給授權管理者。</small></div>
          <div class="login-input-row"><span class="login-input-icon" aria-hidden="true">🔑</span><input id="licenseCode" autocomplete="off" autocapitalize="characters" placeholder="請貼上公司專用授權碼" aria-label="授權碼"></div>
          <button id="activateLicense" class="primary full">啟用系統授權</button>
          <div id="licenseStorageStatus" class="backup-status">尚未檢查授權保存狀態。</div>
          <button id="checkLicenseStorageGate" class="secondary full">檢查授權保存</button>
        </div>
      </div>
      <div id="loginGate" class="login-gate hidden" aria-modal="true" role="dialog">
        <div class="login-panel">
          <div class="login-brand">
            <img src="icon-192.png" alt="系統 Logo" class="login-logo">
            <h2 id="loginSystemName">雙發付款管理系統</h2>
          </div>
          <div class="login-input-row">
            <span class="login-input-icon" aria-hidden="true">👤</span>
            <input id="loginCode" autocomplete="username" autocapitalize="none" placeholder="請輸入登入代碼" aria-label="登入代碼">
          </div>
          <div class="login-input-row">
            <span class="login-input-icon" aria-hidden="true">🔒</span>
            <input id="loginPassword" type="password" autocomplete="current-password" inputmode="text" placeholder="請輸入密碼" aria-label="登入密碼">
          </div>
          <label class="remember-row"><input id="rememberLogin" type="checkbox" checked> 記住登入</label>
          <button id="loginSubmit" class="primary full">登入</button>
          <div id="loginMessage" class="login-message"></div>
        </div>
      </div>
      <div id="correctionModal" class="correction-modal hidden" aria-modal="true" role="dialog">
        <div class="correction-panel">
          <h2>新增修改紀錄</h2>
          <div class="lock-notice">🔒 原始付款資料不會被修改，只會永久新增一筆更正紀錄。</div>
          <div id="correctionPaymentSummary" class="mini-summary"></div>
          <label>修改項目<select id="correctionField">
            <option value="amountDue">應付金額</option>
            <option value="amountPaid">實付金額</option>
            <option value="deductionNote">扣款內容</option>
            <option value="checkNumber">支票號碼</option>
            <option value="checkDueDate">支票到期日</option>
            <option value="bank">銀行</option>
            <option value="status">狀態</option>
            <option value="other">其他內容</option>
          </select></label>
          <label>修改後正確內容<input id="correctionNewValue" placeholder="請輸入正確內容"></label>
          <label>修改原因<textarea id="correctionReason" rows="3" placeholder="例如：支票號碼輸入錯誤、銀行換票"></textarea></label>
          <div class="two"><button id="cancelCorrection" class="secondary">取消</button><button id="saveCorrection" class="primary">儲存修改紀錄</button></div>
        </div>
      </div>`);

    q('.topbar>div').insertAdjacentHTML('beforeend', '<small id="loginUserTag" class="login-user-tag hidden"></small>');
    q('.home-grid').insertAdjacentHTML('beforeend', '<button id="homeRevisionCard" class="home-card"><b>修改紀錄</b><span>原始資料鎖定，查看所有更正</span></button>');
    q('#detailImages').insertAdjacentHTML('beforebegin', '<div id="detailRevisionHistory"></div>');
    q('#editPaymentBtn').textContent = '新增修改紀錄';
    q('#systemInfoCard')?.insertAdjacentHTML('afterend', `
      <div class="card" id="licenseInfoCard">
        <h3>🔑 軟體授權</h3>
        <div id="licenseStatus" class="backup-status"></div>
        <p class="hint">新手機或平板需要公司專用授權碼才能使用。雲端只保存公司授權與設備識別，不會上傳付款內容、照片、簽名或備份。</p>
        <div class="backup-status"><b>本機設備識別碼</b><br><span id="licenseDeviceIdSettings"></span></div>
        <div id="licenseStorageStatusSettings" class="backup-status">尚未檢查授權保存狀態。</div>
        <button id="checkLicenseStorage" class="secondary full">檢查授權保存</button>
        <button id="copyLicenseDevice" class="secondary full">複製設備識別碼</button>
      </div>`);

    q('#settings').insertAdjacentHTML('beforebegin', `
      <section id="revisions" class="page">
        <h2>修改紀錄</h2>
        <div class="card" id="revisionCenterCard">
          <p class="hint">已付款資料不能直接修改。每次更正都會保留修改前、修改後、原因、記錄人及時間。</p>
          <input id="revisionSearch" placeholder="搜尋廠商、序號、修改項目或原因">
          <p id="revisionCount" class="hint"></p>
          <div id="revisionList"></div>
        </div>
      </section>`);

    q('#settings').insertAdjacentHTML('beforeend', `
      <div class="card" id="voiceSettingsCard"><h3>🔊 智慧語音提醒</h3>
        <p class="hint">可用中文語音說出輸入錯誤、付款完成、備份完成及支票到期提醒。iPhone／iPad 第一次播放時請先點一下畫面。</p>
        <label class="toggle-row"><span><b>啟用中文語音</b><small>關閉後不播放語音及提示音</small></span><input id="voiceEnabled" type="checkbox"></label>
        <div class="voice-grid">
          <label class="toggle-row"><span>輸入錯誤</span><input id="voiceErrors" type="checkbox"></label>
          <label class="toggle-row"><span>付款完成</span><input id="voiceSuccess" type="checkbox"></label>
          <label class="toggle-row"><span>備份完成</span><input id="voiceBackup" type="checkbox"></label>
          <label class="toggle-row"><span>支票到期</span><input id="voiceDue" type="checkbox"></label>
        </div>
        <label>語音性別<select id="voiceGender"><option value="auto">系統自動</option><option value="female">女聲</option><option value="male">男聲</option></select></label>
        <p class="hint">iPad／手機會從已安裝的中文系統語音中選擇；若裝置沒有對應音色，會改用可用的中文聲音。</p>
        <label>語音音量 <b id="voiceVolumeText">90%</b><input id="voiceVolume" type="range" min="0" max="1" step="0.05"></label>
        <label>語音速度 <b id="voiceRateText">正常</b><input id="voiceRate" type="range" min="0.7" max="1.3" step="0.1"></label>
        <button id="testVoice" class="secondary full">測試語音：資料已備份完成</button>
      </div>
      <div class="card" id="loginLogoutSoundCard"><h3>🎵 登入／登出聲音</h3>
        <p class="hint">可自訂登入歡迎詞，也可從手機或電腦選擇 MP3、WAV、M4A 音樂。音樂會存入本機設定並包含在完整備份中。</p>
        <label class="toggle-row"><span><b>啟用登入歡迎聲音</b><small>登入成功後播放</small></span><input id="loginSoundEnabled" type="checkbox"></label>
        <label>登入歡迎詞<input id="loginWelcomeText" maxlength="80" placeholder="歡迎進入{系統名稱}"></label>
        <label>登入播放方式<select id="loginPlayMode"><option value="voice">只播放歡迎詞</option><option value="music">只播放自訂音樂</option><option value="musicVoice">先音樂、再歡迎詞</option><option value="voiceMusic">先歡迎詞、再音樂</option></select></label>
        <label class="secondary full file-label">選擇登入音樂<input id="loginMusicInput" type="file" accept="audio/*,.mp3,.wav,.m4a,.aac"></label>
        <div id="loginMusicName" class="backup-status">尚未選擇登入音樂</div>
        <div class="inline"><button id="testLoginSound" class="secondary">試聽登入聲音</button><button id="removeLoginMusic" class="secondary">移除登入音樂</button></div>
        <hr>
        <label class="toggle-row"><span><b>啟用登出聲音</b><small>完成登出前播放</small></span><input id="logoutSoundEnabled" type="checkbox"></label>
        <label>登出聲音<select id="logoutSoundMode"><option value="windows">Windows 風格提示音</option><option value="windowsxp">Windows XP 關機風格聲音</option><option value="custom">自訂音樂</option><option value="none">無聲</option></select></label>
        <label>登出自訂詞<input id="logoutFarewellText" maxlength="80" placeholder="謝謝使用{系統名稱}，再見"></label>
        <label>登出播放方式<select id="logoutPlayMode"><option value="sound">只播放登出聲音</option><option value="voice">只播放自訂詞</option><option value="soundVoice">先登出聲音、再自訂詞</option><option value="voiceSound">先自訂詞、再登出聲音</option></select></label>
        <label class="secondary full file-label">選擇登出音樂<input id="logoutMusicInput" type="file" accept="audio/*,.mp3,.wav,.m4a,.aac"></label>
        <div id="logoutMusicName" class="backup-status">尚未選擇登出音樂</div>
        <div class="inline"><button id="testLogoutSound" class="secondary">試聽登出聲音</button><button id="removeLogoutMusic" class="secondary">移除登出音樂</button></div>
        <button id="saveLoginLogoutSound" class="primary full">儲存登入／登出設定</button>
      </div>
      <div class="card"><h3>🔐 登入帳號與密碼</h3>
        <p id="currentLoginInfo" class="hint"></p>
        <p class="hint credential-hint">登入後可修改自己的登入帳號或密碼。每次變更都必須先輸入目前密碼確認。</p>
        <label>目前登入帳號<input id="currentLoginCode" readonly autocomplete="username"></label>
        <label>新登入帳號<input id="newLoginCode" maxlength="30" autocomplete="username" placeholder="留空代表不修改帳號"></label>
        <div id="defaultPasswordNotice" class="lock-notice hidden">目前仍使用初始密碼，請登入後立即修改。</div>
        <label>目前密碼<input id="oldPassword" type="password"></label>
        <label>新密碼<input id="newPassword" type="password" minlength="4"></label>
        <label>再次輸入新密碼<input id="newPassword2" type="password" minlength="4"></label>
        <button id="changePassword" class="primary full">儲存登入帳號／密碼</button>
        <button id="logoutBtn" class="secondary full">登出</button>
      </div>
      <div class="card" id="userManagementCard">
        <h3>👥 使用者姓名管理</h3>
        <p class="hint">只有管理員可以新增或移除使用者。每位使用者使用自己的姓名、登入帳號與密碼；目前登入的管理員不能被移除。</p>
        <div id="userManagementList" class="user-management-list"></div>
        <hr>
        <label>使用姓名<input id="newUserName" maxlength="30" placeholder="例如：王小明"></label>
        <label>登入帳號<input id="newUserCode" maxlength="30" autocomplete="username" placeholder="例如：staff01"></label>
        <label>初始密碼<input id="newUserPassword" type="password" minlength="4" autocomplete="new-password" placeholder="至少 4 碼"></label>
        <label>使用者權限<select id="newUserRole"><option value="staff">一般使用者</option><option value="admin">管理員</option></select></label>
        <button id="addUser" class="primary full">新增使用者</button>
      </div>
`);
  }

  function syncLoginBrand() {
    const name = (typeof getSystemName === 'function' ? getSystemName() : (settings?.systemName || '雙發付款管理系統'));
    const title = q('#loginSystemName');
    if (title) title.textContent = name;
    const logo = q('.login-logo');
    if (logo) logo.alt = `${name} Logo`;
  }

  function showLogin() {
    if (!licenseReady || !licenseState) { showLicenseGate('尚未啟用授權，請先輸入公司專用授權碼。'); return; }
    syncLoginBrand();
    document.body.classList.add('login-locked');
    settingsAccessGranted = false;
    const gate = q('#loginGate');
    if (!gate) return;
    gate.classList.remove('hidden');
    setTimeout(() => { const code=q('#loginCode'); const password=q('#loginPassword'); (code && !code.value ? code : password).focus(); }, 100);
  }

  function hideLogin() {
    q('#loginGate')?.classList.add('hidden');
    document.body.classList.remove('login-locked');
  }

  function setLogoutBusy(busy) {
    qa('#logoutBtn, #homeLogoutBtn').forEach(button => {
      if (busy) {
        if (!button.dataset.restoreHtml) button.dataset.restoreHtml = button.innerHTML;
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        button.innerHTML = button.id === 'homeLogoutBtn'
          ? '<b>📦 備份中…</b><span>請稍候，完成後自動登出</span>'
          : '📦 備份中…';
      } else {
        const restore = button.dataset.restoreHtml;
        if (restore) {
          button.innerHTML = restore;
          delete button.dataset.restoreHtml;
        }
        button.disabled = false;
        button.removeAttribute('aria-busy');
      }
    });
  }

  async function requireInternalBackup(reason) {
    if (typeof window.shuangfaInternalBackup !== 'function') {
      throw new Error('完整內部備份功能尚未就緒');
    }
    return window.shuangfaInternalBackup(reason);
  }

  async function idleBackupAndLogout() {
    if (!currentUser || logoutInProgress) return;
    logoutInProgress = true;
    setLogoutBusy(true);
    try {
      if (typeof saveAudit === 'function') saveAudit('閒置自動登出');
      await requireInternalBackup('閒置自動登出');
      originalToast('閒置 30 分鐘，已完成內部備份，準備自動登出');
      await speakPromise('已閒置 30 分鐘，資料已備份完成，系統即將自動登出。', 'backup');
      await new Promise(resolve => setTimeout(resolve, 180));
      await playLogoutSound();
      logout(true, true);
    } catch (error) {
      console.error('閒置自動備份失敗', error);
      originalToast('自動備份失敗，系統暫不登出，請手動備份');
      speak('自動備份失敗，系統暫不登出。', 'error', true);
      resetIdleTimer();
    } finally {
      logoutInProgress = false;
      setLogoutBusy(false);
    }
  }

  function resetIdleTimer() {
    clearTimeout(idleTimer);
    if (!currentUser) return;
    idleTimer = setTimeout(idleBackupAndLogout, IDLE_MS);
  }

  function renderUser() {
    const tag = q('#loginUserTag');
    if (!currentUser) {
      tag.classList.add('hidden');
      return;
    }
    tag.textContent = `已登入：${currentUser.name}（${currentUser.role === 'admin' ? '管理員' : '員工'}）`;
    tag.classList.remove('hidden');
    q('#currentLoginInfo').textContent = `目前登入：${currentUser.name}｜代碼 ${currentUser.code}`;
    const currentLoginCode = q('#currentLoginCode');
    if (currentLoginCode) currentLoginCode.value = currentUser.code;
    q('#defaultPasswordNotice').classList.toggle('hidden', !currentUser.mustChangePassword);
  }

  function renderUserManagement() {
    const list = q('#userManagementList');
    const card = q('#userManagementCard');
    if (!list || !card) return;
    const admin = currentUser?.role === 'admin';
    card.classList.toggle('hidden', !admin);
    if (!admin) return;
    const auth = readAuth() || { users: [] };
    const safe = value => typeof esc === 'function' ? esc(String(value ?? '')) : String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    list.innerHTML = (auth.users || []).map(user => {
      const isCurrent = String(user.code).toLowerCase() === String(currentUser.code).toLowerCase();
      const role = user.role === 'admin' ? '管理員' : '一般使用者';
      return `<div class="user-management-row"><div><b>${safe(user.name || '未設定姓名')}</b><small>${safe(user.code)}｜${role}${isCurrent ? '｜目前登入' : ''}</small></div><button class="secondary" data-remove-user="${safe(user.code)}" ${isCurrent ? 'disabled title="目前登入者不能移除"' : ''}>移除</button></div>`;
    }).join('') || '<p class="hint">目前沒有使用者資料。</p>';
    qa('[data-remove-user]').forEach(button => {
      button.onclick = () => removeManagedUser(button.dataset.removeUser);
    });
  }

  async function removeManagedUser(code) {
    if (currentUser?.role !== 'admin') return toast('只有管理員可以移除使用者');
    const auth = await ensureAuth();
    const same = value => String(value || '').trim().toLowerCase();
    const user = auth.users.find(x => same(x.code) === same(code));
    if (!user) return toast('找不到這位使用者');
    if (same(user.code) === same(currentUser.code)) return toast('目前登入的管理員不能移除');
    if (user.role === 'admin' && auth.users.filter(x => x.enabled !== false && x.role === 'admin').length <= 1) return toast('系統至少要保留一位管理員');
    const password = prompt(`移除使用者「${user.name || user.code}」前，請輸入目前管理員密碼：`);
    if (password === null) return;
    if (!password || (await hash(password)) !== auth.users.find(x => same(x.code) === same(currentUser.code))?.passwordHash) return toast('管理員密碼不正確，無法移除');
    if (!confirm(`確定要移除使用者「${user.name || user.code}」嗎？`)) return;
    auth.users = auth.users.filter(x => same(x.code) !== same(user.code));
    writeAuth(auth);
    renderUserManagement();
    await Promise.resolve(saveAudit('移除使用者', { code: user.code, name: user.name || '' }));
    originalToast(`使用者「${user.name || user.code}」已移除`);
  }

  async function login() {
    if (!licenseReady || !licenseState) { showLicenseGate('尚未啟用授權，請先輸入公司專用授權碼。'); return; }
    // 必須在使用者按下登入的同一個操作中啟用播放，避免 iPhone／iPad 偶爾阻擋音效。
    unlockPlayback();
    const currentTime = Date.now();
    if (currentTime < lockUntil) {
      const seconds = Math.ceil((lockUntil - currentTime) / 1000);
      q('#loginMessage').textContent = `登入暫時鎖定，請 ${seconds} 秒後再試`;
      speak('登入暫時鎖定，請稍後再試。', 'error', true);
      return;
    }

    const code = q('#loginCode').value.trim();
    const password = q('#loginPassword').value;
    const auth = await ensureAuth();
    const user = auth.users.find(x => x.enabled !== false && String(x.code || '').toLowerCase() === code.toLowerCase());

    if (!user || user.passwordHash !== await hash(password)) {
      failedAttempts += 1;
      if (failedAttempts >= 5) {
        lockUntil = Date.now() + 30 * 1000;
        failedAttempts = 0;
        q('#loginMessage').textContent = '登入錯誤 5 次，已暫時鎖定 30 秒';
      } else {
        q('#loginMessage').textContent = `登入代碼或密碼錯誤（${failedAttempts}/5）`;
      }
      speak('登入代碼或密碼錯誤，請重新確認。', 'error', true);
      return;
    }

    failedAttempts = 0;
    currentUser = {
      code: user.code,
      name: user.name,
      role: user.role,
      mustChangePassword: !!user.mustChangePassword
    };
    const target = q('#rememberLogin').checked ? localStorage : sessionStorage;
    target.setItem(SESSION_KEY, JSON.stringify(currentUser));
    hideLogin();
    history = ['home'];
    if (typeof show === 'function') show('home', false);
    renderUser();
    resetIdleTimer();
    saveAudit('登入');
    // 等歡迎聲完成後才播啟動提醒，避免 speechSynthesis.cancel() 把登入聲取消。
    await playLoginWelcome();
    queueStartupAnnouncements();
  }

  function audioSettings() {
    return {
      loginEnabled: settings.loginSoundEnabled !== false,
      loginText: settings.loginWelcomeText || '歡迎進入{系統名稱}',
      loginMode: settings.loginPlayMode || 'voice',
      loginMusicData: settings.loginMusicData || '',
      loginMusicName: settings.loginMusicName || '',
      logoutEnabled: settings.logoutSoundEnabled !== false,
      logoutMode: settings.logoutSoundMode || 'windows',
      logoutMusicData: settings.logoutMusicData || '',
      logoutMusicName: settings.logoutMusicName || '',
      logoutText: settings.logoutFarewellText || '謝謝使用{系統名稱}，再見',
      logoutPlayMode: settings.logoutPlayMode || 'sound'
    };
  }

  function playAudioData(dataUrl) {
    if (!dataUrl || signatureVoiceBlocked()) return Promise.resolve(false);
    try { activeAudioCancel?.(); } catch {}
    return new Promise(resolve => {
      try {
        const audio = new Audio();
        activeAudio = audio;
        audio.preload = 'auto';
        audio.playsInline = true;
        audio.setAttribute('playsinline', '');
        audio.volume = voiceSettings().volume;
        let timer = null;
        let finished = false;
        const done = result => {
          if (finished) return;
          finished = true;
          if (timer) clearTimeout(timer);
          audio.onended = audio.onerror = audio.onabort = null;
          if (activeAudio === audio) {
            activeAudio = null;
            activeAudioCancel = null;
          }
          resolve(result);
        };
        activeAudioCancel = () => { try { audio.pause(); audio.currentTime = 0; } catch {} done(false); };
        audio.onended = () => done(true);
        audio.onerror = () => { console.warn('自訂音樂播放失敗'); done(false); };
        audio.onabort = () => done(false);
        // 某些 iOS 版本不回報 ended/error，避免登入流程卡住。
        timer = setTimeout(() => done(false), 15000);
        audio.src = dataUrl;
        audio.load();
        const result = audio.play();
        if (result?.catch) result.catch(() => done(false));
      } catch { resolve(false); }
    });
  }

  function speakPromise(text, kind = 'success', force = false) {
    return new Promise(resolve => {
      if (signatureVoiceBlocked() || !text || !('speechSynthesis' in window) || (!force && !voiceAllowed(kind))) return resolve(false);
      let finished = false;
      let timer = null;
      const finish = result => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      };
      try {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'zh-TW';
        utterance.rate = voiceSettings().rate;
        utterance.volume = voiceSettings().volume;
        const voice = getChineseVoice();
        if (voice) utterance.voice = voice;
        utterance.onend = () => finish(true);
        utterance.onerror = () => finish(false);
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(utterance);
        // iPhone 偶爾不回報 onend，不能讓登出流程永久停住。
        timer = setTimeout(() => { try { window.speechSynthesis.cancel(); } catch {} finish(false); }, 10000);
      } catch { finish(false); }
    });
  }

  async function playLoginWelcome() {
    const a = audioSettings();
    if (!a.loginEnabled) return;
    const systemName = typeof getSystemName === 'function' ? getSystemName() : '雙發付款管理系統';
    const text = String(a.loginText || '歡迎進入{系統名稱}').replaceAll('{系統名稱}', systemName);
    if (a.loginMode === 'music') {
      if (!a.loginMusicData) return speakPromise(text);
      const played = await playAudioData(a.loginMusicData);
      return played || speakPromise(text);
    }
    if (a.loginMode === 'musicVoice') { await playAudioData(a.loginMusicData); return speakPromise(text); }
    if (a.loginMode === 'voiceMusic') { await speakPromise(text); return playAudioData(a.loginMusicData); }
    return speakPromise(text);
  }

  async function playLogoutBaseSound(a) {
    if (a.logoutMode === 'none') return;
    if (a.logoutMode === 'custom') {
      if (!a.logoutMusicData) return playWindowsStyleLogoutSound();
      const played = await playAudioData(a.logoutMusicData);
      return played || playWindowsStyleLogoutSound();
    }
    if (a.logoutMode === 'windowsxp') return playWindowsXPStyleShutdownSound();
    return playWindowsStyleLogoutSound();
  }

  async function playLogoutSound() {
    const a = audioSettings();
    if (!a.logoutEnabled) return;
    const systemName = typeof getSystemName === 'function' ? getSystemName() : '雙發付款管理系統';
    const text = String(a.logoutText || '謝謝使用{系統名稱}，再見').replaceAll('{系統名稱}', systemName);
    if (a.logoutPlayMode === 'voice') return speakPromise(text);
    if (a.logoutPlayMode === 'soundVoice') { await playLogoutBaseSound(a); return speakPromise(text); }
    if (a.logoutPlayMode === 'voiceSound') { await speakPromise(text); return playLogoutBaseSound(a); }
    return playLogoutBaseSound(a);
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      if (!file) return resolve('');
      if (file.size > 5 * 1024 * 1024) return reject(new Error('音樂檔請小於 5MB'));
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('讀取音樂檔失敗'));
      reader.readAsDataURL(file);
    });
  }

  function applyAudioSettings() {
    const a = audioSettings();
    q('#loginSoundEnabled').checked = a.loginEnabled;
    q('#loginWelcomeText').value = a.loginText;
    q('#loginPlayMode').value = a.loginMode;
    q('#logoutSoundEnabled').checked = a.logoutEnabled;
    q('#logoutSoundMode').value = a.logoutMode;
    q('#logoutFarewellText').value = a.logoutText;
    q('#logoutPlayMode').value = a.logoutPlayMode;
    q('#loginMusicName').textContent = a.loginMusicName ? `目前登入音樂：${a.loginMusicName}` : '尚未選擇登入音樂';
    q('#logoutMusicName').textContent = a.logoutMusicName ? `目前登出音樂：${a.logoutMusicName}` : '尚未選擇登出音樂';
  }

  async function playWindowsXPStyleShutdownSound() {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return Promise.resolve();
      const reusable = audioContext && audioContext.state !== 'closed';
      const context = reusable ? audioContext : new AudioContextClass();
      audioContext = context;
      if (context.state === 'suspended') await context.resume().catch(() => {});
      const now = context.currentTime;
      const master = context.createGain();
      master.gain.setValueAtTime(0.0001, now);
      master.gain.exponentialRampToValueAtTime(0.14, now + 0.04);
      master.gain.exponentialRampToValueAtTime(0.0001, now + 2.2);
      master.connect(context.destination);
      const notes = [
        {f:659.25,t:0.00,d:0.55,v:0.75},
        {f:523.25,t:0.18,d:0.70,v:0.68},
        {f:392.00,t:0.42,d:0.85,v:0.60},
        {f:329.63,t:0.72,d:1.10,v:0.52}
      ];
      notes.forEach(note => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const start = now + note.t;
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(note.f, start);
        oscillator.frequency.exponentialRampToValueAtTime(note.f * 0.985, start + note.d);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(note.v, start + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + note.d);
        oscillator.connect(gain);
        gain.connect(master);
        oscillator.start(start);
        oscillator.stop(start + note.d + 0.05);
      });
      return new Promise(resolve => setTimeout(() => {
        if (!reusable) context.close().catch(() => {});
        resolve();
      }, 2250));
    } catch (error) {
      console.warn('Windows XP 關機風格聲音播放失敗', error);
      return Promise.resolve();
    }
  }

  async function playWindowsStyleLogoutSound() {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return Promise.resolve();
      const reusable = audioContext && audioContext.state !== 'closed';
      const context = reusable ? audioContext : new AudioContextClass();
      audioContext = context;
      if (context.state === 'suspended') await context.resume().catch(() => {});
      const now = context.currentTime;
      const master = context.createGain();
      master.gain.setValueAtTime(0.0001, now);
      master.gain.exponentialRampToValueAtTime(0.16, now + 0.03);
      master.gain.exponentialRampToValueAtTime(0.0001, now + 1.15);
      master.connect(context.destination);
      [659.25, 523.25, 392.0].forEach((frequency, index) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const start = now + index * 0.22;
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(frequency, start);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.8, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.42);
        oscillator.connect(gain);
        gain.connect(master);
        oscillator.start(start);
        oscillator.stop(start + 0.45);
      });
      return new Promise(resolve => setTimeout(() => {
        if (!reusable) context.close().catch(() => {});
        resolve();
      }, 1200));
    } catch (error) {
      console.warn('登出提示音播放失敗', error);
      return Promise.resolve();
    }
  }

  function logout(auto = false, skipAudit = false) {
    if (currentUser && !skipAudit) saveAudit(auto ? '閒置自動登出' : '登出');
    localStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(SESSION_KEY);
    currentUser = null;
    settingsAccessGranted = false;
    clearTimeout(idleTimer);
    history = ['home'];
    if (typeof show === 'function') show('home', false);
    renderUser();
    q('#loginPassword').value = '';
    showLogin();
  }

  function enforceLoginGate() {
    if (!q('#loginGate')) return;
    if (!licenseReady || !licenseState) { showLicenseGate(); return; }
    if (!currentUser) {
      settingsAccessGranted = false;
      showLogin();
      return;
    }
    resetIdleTimer();
  }

  window.addEventListener('pageshow', enforceLoginGate);
  window.addEventListener('popstate', enforceLoginGate);
  window.addEventListener('storage', event => {
    if (event.key !== SESSION_KEY || event.newValue) return;
    currentUser = null;
    settingsAccessGranted = false;
    clearTimeout(idleTimer);
    showLogin();
  });

  async function restoreSession() {
    if (!licenseReady || !licenseState) { showLicenseGate(); return; }
    try {
      currentUser = JSON.parse(sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY) || 'null');
    } catch {
      currentUser = null;
    }
    const auth = await ensureAuth();
    const storedUser = currentUser && auth.users.find(user => user.enabled !== false && String(user.code || '').toLowerCase() === String(currentUser.code || '').toLowerCase());
    if (storedUser) {
      currentUser = { code: storedUser.code, name: storedUser.name, role: storedUser.role, mustChangePassword: !!storedUser.mustChangePassword };
      hideLogin();
      history = ['home'];
      if (typeof show === 'function') show('home', false);
      renderUser();
      resetIdleTimer();
      queueStartupAnnouncements();
    } else {
      localStorage.removeItem(SESSION_KEY);
      sessionStorage.removeItem(SESSION_KEY);
      currentUser = null;
      showLogin();
    }
  }

  function updateVoiceLabels() {
    q('#voiceVolumeText').textContent = `${Math.round(Number(q('#voiceVolume').value) * 100)}%`;
    const rate = Number(q('#voiceRate').value);
    q('#voiceRateText').textContent = rate === 1 ? '正常' : rate < 1 ? '較慢' : '較快';
  }

  function applyVoiceSettings() {
    const v = voiceSettings();
    q('#voiceEnabled').checked = v.enabled;
    q('#voiceErrors').checked = v.errors;
    q('#voiceSuccess').checked = v.success;
    q('#voiceBackup').checked = v.backup;
    q('#voiceDue').checked = v.due;
    q('#voiceGender').value = v.gender;
    q('#voiceVolume').value = v.volume;
    q('#voiceRate').value = v.rate;
    updateVoiceLabels();
  }

  function saveVoiceSettings() {
    settings.voiceEnabled = q('#voiceEnabled').checked;
    settings.voiceErrors = q('#voiceErrors').checked;
    settings.voiceSuccess = q('#voiceSuccess').checked;
    settings.voiceBackup = q('#voiceBackup').checked;
    settings.voiceDue = q('#voiceDue').checked;
    settings.voiceGender = q('#voiceGender').value;
    settings.voiceVolume = Number(q('#voiceVolume').value);
    settings.voiceRate = Number(q('#voiceRate').value);
    saveSettings();
    updateVoiceLabels();
  }

  function dueSummary() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    let overdue = 0;
    let dueToday = 0;
    let dueTomorrow = 0;

    (db.payments || [])
      .filter(p => !['已銷帳', '作廢'].includes(p.status || statusFor(p)))
      .forEach(p => {
        const entries = typeof dueEntries === 'function' ? dueEntries(p) : [];
        if (entries.some(entry => new Date(`${entry.date}T00:00:00`) < today)) overdue += 1;
        if (entries.some(entry => new Date(`${entry.date}T00:00:00`).getTime() === today.getTime())) dueToday += 1;
        if (entries.some(entry => new Date(`${entry.date}T00:00:00`).getTime() === tomorrow.getTime())) dueTomorrow += 1;
      });

    return { overdue, dueToday, dueTomorrow };
  }

  function queueStartupAnnouncements() {
    if (!currentUser) return;
    const day = localDate();
    const autoBackupAt = localStorage.getItem('shuangfa_last_auto_backup') || '';

    if (voiceSettings().backup && autoBackupAt.slice(0, 10) === day && localStorage.getItem('shuangfa_voice_backup_day') !== day) {
      speak('今日資料已自動備份完成。', 'backup');
      localStorage.setItem('shuangfa_voice_backup_day', day);
    }

    const due = dueSummary();
    if (voiceSettings().due && (due.overdue || due.dueToday || due.dueTomorrow) && localStorage.getItem('shuangfa_voice_due_day') !== day) {
      const parts = [];
      if (due.overdue) parts.push(`有${due.overdue}張支票已逾期`);
      if (due.dueToday) parts.push(`今天有${due.dueToday}張支票到期`);
      if (due.dueTomorrow) parts.push(`明天有${due.dueTomorrow}張支票到期`);
      speak(`提醒您，${parts.join('，')}。`, 'due');
      localStorage.setItem('shuangfa_voice_due_day', day);
    }
  }

  const fieldLabels = {
    amountDue: '應付金額',
    amountPaid: '實付金額',
    deductionNote: '扣款內容',
    checkNumber: '支票號碼',
    checkDueDate: '支票到期日',
    bank: '銀行',
    status: '狀態',
    other: '其他內容'
  };

  function originalValue(payment, field) {
    if (field === 'amountDue' || field === 'amountPaid') return `$${money(payment[field])}`;
    if (field === 'other') return '其他內容';
    return String(payment[field] ?? '—');
  }

  function openCorrectionModal() {
    const payment = db.payments.find(x => x.id === currentDetailId);
    if (!payment) return toast('找不到付款資料');
    if (currentUser?.role !== 'admin') return toast('只有管理員可以建立修改紀錄');

    editingPaymentId = payment.id;
    q('#correctionPaymentSummary').innerHTML = `<b>${esc(payment.serial)}</b><br>${esc(payment.vendorCode)} ${esc(payment.vendor)}<br>原始付款憑證：${esc(voucher(payment))}`;
    q('#correctionField').value = 'amountDue';
    q('#correctionNewValue').value = '';
    q('#correctionNewValue').placeholder = `原始內容：${originalValue(payment, 'amountDue')}`;
    q('#correctionReason').value = '';
    q('#correctionModal').classList.remove('hidden');
  }

  function closeCorrectionModal() {
    q('#correctionModal').classList.add('hidden');
    editingPaymentId = '';
  }

  async function saveCorrection() {
    const payment = db.payments.find(x => x.id === editingPaymentId);
    if (!payment) return toast('找不到付款資料');

    const field = q('#correctionField').value;
    const newValue = q('#correctionNewValue').value.trim();
    const reason = q('#correctionReason').value.trim();
    if (!newValue) return toast('請輸入修改後的正確內容');
    if (!reason) return toast('請填寫修改原因');

    const correction = {
      id: uid(),
      paymentId: payment.id,
      serial: payment.serial,
      vendorCode: payment.vendorCode,
      vendor: payment.vendor,
      field,
      fieldLabel: fieldLabels[field] || field,
      oldValue: originalValue(payment, field),
      newValue,
      reason,
      operatorCode: currentUser.code,
      operator: currentUser.name,
      createdAt: now()
    };

    const previousCorrections = Array.isArray(db.correctionLogs) ? [...db.correctionLogs] : [];
    const previousAuditLogs = Array.isArray(db.auditLogs) ? [...db.auditLogs] : [];
    db.correctionLogs = Array.isArray(db.correctionLogs) ? db.correctionLogs : [];
    db.correctionLogs.unshift(correction);
    try {
      const auditSave = saveAudit('新增修改紀錄', correction);
      if (auditSave && typeof auditSave.then === 'function') await auditSave;
      if (auditSave === false) throw new Error('操作紀錄保存失敗');
    } catch (error) {
      db.correctionLogs = previousCorrections;
      db.auditLogs = previousAuditLogs;
      console.error('新增修改紀錄保存失敗', error);
      renderCorrections();
      renderDetailCorrections(payment.id);
      return toast('修改紀錄保存失敗，原始付款資料沒有變動');
    }
    closeCorrectionModal();
    renderCorrections();
    renderDetailCorrections(payment.id);
    originalToast('修改紀錄已儲存，原始付款資料沒有變動');
    speak('修改紀錄已儲存，原始付款資料沒有變動。', 'success');
  }

  function correctionCard(correction, allowDelete = true) {
    return `<div class="correction-row">
      <h4>${esc(correction.serial)}｜${esc(correction.vendorCode)} ${esc(correction.vendor)}</h4>
      <div class="correction-change"><span><small>修改前</small><b>${esc(correction.oldValue)}</b></span><strong>→</strong><span><small>修改後</small><b>${esc(correction.newValue)}</b></span></div>
      <p>項目：${esc(correction.fieldLabel)}<br>原因：${esc(correction.reason)}</p>
      <small>${esc(correction.operator)}｜${new Date(correction.createdAt).toLocaleString('zh-TW')}</small>
      <button class="secondary full" data-revision-payment="${esc(correction.paymentId)}">查看原始付款</button>
      ${allowDelete ? `<button class="secondary full revision-delete-btn" data-delete-revision="${esc(correction.id)}">🗑️ 移除此筆修改紀錄</button>` : ''}
    </div>`;
  }

  async function deleteCorrection(id) {
    if (currentUser?.role !== 'admin') return toast('只有管理員可以移除修改紀錄');
    const correction = (db.correctionLogs || []).find(x => x.id === id);
    if (!correction) return toast('找不到這筆修改紀錄');

    const password = prompt('移除修改紀錄需要輸入目前登入密碼：');
    if (password === null) return;
    if (!password) return toast('請輸入密碼');

    const auth = await ensureAuth();
    const user = auth.users.find(x => x.code === currentUser.code && x.enabled !== false);
    if (!user || user.passwordHash !== await hash(password)) {
      speak('密碼錯誤，無法移除修改紀錄。', 'error', true);
      return toast('密碼錯誤，無法移除');
    }

    if (!confirm(`確定要移除此筆修改紀錄嗎？\n\n${correction.serial}｜${correction.vendorCode} ${correction.vendor}\n${correction.fieldLabel}：${correction.oldValue} → ${correction.newValue}`)) return;

    const previousCorrections = [...(db.correctionLogs || [])];
    const previousAuditLogs = [...(db.auditLogs || [])];
    db.correctionLogs = previousCorrections.filter(x => x.id !== id);
    const auditSave = saveAudit('移除修改紀錄', {
      correctionId: correction.id,
      serial: correction.serial,
      vendorCode: correction.vendorCode,
      vendor: correction.vendor,
      fieldLabel: correction.fieldLabel
    });
    try {
      if (auditSave && typeof auditSave.then === 'function') await auditSave;
      if (auditSave === false) throw new Error('操作紀錄保存失敗');
    } catch (error) {
      db.correctionLogs = previousCorrections;
      db.auditLogs = previousAuditLogs;
      renderCorrections();
      if (currentDetailId) renderDetailCorrections(currentDetailId);
      console.error('移除修改紀錄失敗', error);
      return toast('移除失敗，請稍後再試');
    }
    renderCorrections();
    if (currentDetailId) renderDetailCorrections(currentDetailId);
    originalToast('修改紀錄已移除');
    speak('修改紀錄已移除。', 'success');
  }

  function renderCorrections() {
    const search = (q('#revisionSearch')?.value || '').trim().toLowerCase();
    const all = Array.isArray(db.correctionLogs) ? db.correctionLogs : [];
    const list = all.filter(x => !search || [x.serial, x.vendorCode, x.vendor, x.fieldLabel, x.reason, x.operator, x.newValue].join(' ').toLowerCase().includes(search));
    q('#revisionCount').textContent = `共 ${all.length} 筆｜目前顯示 ${list.length} 筆`;
    q('#revisionList').innerHTML = list.length ? list.map(x => correctionCard(x, true)).join('') : '<div class="correction-empty">目前沒有修改紀錄。</div>';
    qa('[data-revision-payment]').forEach(button => {
      button.onclick = () => {
        const id = button.dataset.revisionPayment;
        history = ['home', 'search', 'detail'];
        openDetail(id);
      };
    });
    qa('[data-delete-revision]').forEach(button => {
      button.onclick = () => deleteCorrection(button.dataset.deleteRevision);
    });
  }

  function renderDetailCorrections(paymentId) {
    const list = (db.correctionLogs || []).filter(x => x.paymentId === paymentId);
    q('#detailRevisionHistory').innerHTML = `<h3>修改紀錄</h3>${list.length ? list.map(x => correctionCard(x, false)).join('') : '<div class="correction-empty">目前沒有修改紀錄，原始資料保持不變。</div>'}`;
    qa('#detailRevisionHistory [data-revision-payment]').forEach(button => button.remove());
  }

  function installEvents() {
    q('#activateLicense').onclick = activateLicense;
    q('#licenseCode').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); activateLicense(); } });
    q('#checkLicenseStorageGate').onclick = event => checkLicenseStorage(event.currentTarget);
    q('#checkLicenseStorage').onclick = event => checkLicenseStorage(event.currentTarget);
    q('#copyLicenseDevice').onclick = async () => {
      const id = getDeviceId();
      try { await navigator.clipboard.writeText(id); originalToast('設備識別碼已複製'); }
      catch { prompt('請複製設備識別碼：', id); }
    };
    q('#loginSubmit').onclick = login;
    q('#loginCode').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); q('#loginPassword').focus(); } });
    q('#loginPassword').addEventListener('keydown', event => { if (event.key === 'Enter') login(); });
    const backupAndLogout = async () => {
      if (!currentUser || logoutInProgress) return;
      logoutInProgress = true;
      setLogoutBusy(true);
      // 按下登出後直接取得播放授權並開始內部備份，不再要求第二次確認。
      unlockPlayback();
      // iPhone 會限制非使用者操作期間第一次播放；先在本次按鍵中播放流程提示，
      // 備份完成後再播放完成提示與登出音效。
      try {
        if (voiceSettings().enabled) {
          playTone('backup');
          speakNow('正在備份資料，完成後自動登出。', 'backup', true);
        }
      } catch (voiceError) { console.warn('登出開始提示音略過', voiceError); }
      if (typeof window.shuangfaStopSignatureVoice === 'function') window.shuangfaStopSignatureVoice();
      try {
        originalToast('正在完成內部備份，請稍候…');
        if (currentUser) saveAudit('登出');
        await requireInternalBackup('登出前完整備份');
        originalToast('完整內部備份已完成，準備登出');
        if (voiceSettings().enabled) await speakPromise('資料已備份完成。', 'backup', true);
        await new Promise(resolve => setTimeout(resolve, 180));
        await playLogoutSound();
        logout(false, true);
      } catch (error) {
        console.error('登出備份失敗', error);
        originalToast('備份失敗，尚未登出');
        speak('備份失敗，系統尚未登出。', 'error', true);
      } finally {
        logoutInProgress = false;
        setLogoutBusy(false);
      }
    };
    q('#logoutBtn').onclick = backupAndLogout;
    const homeLogoutBtn = q('#homeLogoutBtn');
    if (homeLogoutBtn) homeLogoutBtn.onclick = backupAndLogout;
    const settingsButton = q('.home-card[data-go="settings"]');
    if (settingsButton) settingsButton.onclick = async () => {
      if (settingsButton.dataset.checking === '1') return;
      settingsButton.dataset.checking = '1';
      try {
        if (await verifySettingsPassword()) {
          settingsAccessGranted = true;
          show('settings');
        }
      } finally {
        delete settingsButton.dataset.checking;
      }
    };

    ['voiceEnabled', 'voiceErrors', 'voiceSuccess', 'voiceBackup', 'voiceDue', 'voiceGender'].forEach(id => q(`#${id}`).addEventListener('change', saveVoiceSettings));
    ['voiceVolume', 'voiceRate'].forEach(id => q(`#${id}`).addEventListener('input', saveVoiceSettings));
    q('#testVoice').onclick = () => {
      voiceReady = true;
      saveVoiceSettings();
      speakNow('資料已備份完成。', 'backup', true);
    };
    q('#loginMusicInput').onchange = async event => {
      try {
        const file = event.target.files?.[0]; if (!file) return;
        settings.loginMusicData = await fileToDataUrl(file);
        settings.loginMusicName = file.name;
        q('#loginMusicName').textContent = `目前登入音樂：${file.name}`;
        originalToast('登入音樂已載入，請按儲存設定');
      } catch (error) { originalToast(error.message || '登入音樂讀取失敗'); }
    };
    q('#logoutMusicInput').onchange = async event => {
      try {
        const file = event.target.files?.[0]; if (!file) return;
        settings.logoutMusicData = await fileToDataUrl(file);
        settings.logoutMusicName = file.name;
        q('#logoutMusicName').textContent = `目前登出音樂：${file.name}`;
        originalToast('登出音樂已載入，請按儲存設定');
      } catch (error) { originalToast(error.message || '登出音樂讀取失敗'); }
    };
    q('#saveLoginLogoutSound').onclick = () => {
      settings.loginSoundEnabled = q('#loginSoundEnabled').checked;
      settings.loginWelcomeText = q('#loginWelcomeText').value.trim() || '歡迎進入{系統名稱}';
      settings.loginPlayMode = q('#loginPlayMode').value;
      settings.logoutSoundEnabled = q('#logoutSoundEnabled').checked;
      settings.logoutSoundMode = q('#logoutSoundMode').value;
      settings.logoutFarewellText = q('#logoutFarewellText').value.trim() || '謝謝使用{系統名稱}，再見';
      settings.logoutPlayMode = q('#logoutPlayMode').value;
      saveSettings();
      applyAudioSettings();
      originalToast('登入／登出設定已儲存');
      speak('登入與登出設定已儲存完成。', 'success');
    };
    q('#testLoginSound').onclick = () => { unlockPlayback(); playLoginWelcome(); };
    q('#testLogoutSound').onclick = () => { unlockPlayback(); playLogoutSound(); };
    q('#removeLoginMusic').onclick = () => { settings.loginMusicData=''; settings.loginMusicName=''; saveSettings(); applyAudioSettings(); originalToast('登入音樂已移除'); };
    q('#removeLogoutMusic').onclick = () => { settings.logoutMusicData=''; settings.logoutMusicName=''; saveSettings(); applyAudioSettings(); originalToast('登出音樂已移除'); };

    q('#changePassword').onclick = async () => {
      const oldPassword = q('#oldPassword').value;
      const newLoginCode = q('#newLoginCode').value.trim();
      const newPassword = q('#newPassword').value;
      const newPassword2 = q('#newPassword2').value;
      const requestedCode = newLoginCode || currentUser.code;
      const passwordChanged = Boolean(newPassword);
      const codeChanged = requestedCode.toLowerCase() !== String(currentUser.code).toLowerCase();
      if (!codeChanged && !passwordChanged) return toast('請輸入新登入帳號或新密碼');
      if (newLoginCode && (newLoginCode.length < 3 || newLoginCode.length > 30 || /\s/.test(newLoginCode))) {
        return toast('登入帳號需為 3～30 碼，且不能包含空白');
      }
      if (passwordChanged && newPassword.length < 4) return toast('新密碼至少四碼');
      if (passwordChanged && newPassword !== newPassword2) return toast('兩次新密碼不相同');

      const auth = await ensureAuth();
      const sameCode = value => String(value || '').trim().toLowerCase();
      const user = auth.users.find(x => sameCode(x.code) === sameCode(currentUser.code) && x.enabled !== false);
      if (!user || user.passwordHash !== await hash(oldPassword)) return toast('目前密碼不正確');
      if (codeChanged && auth.users.some(x => x !== user && x.enabled !== false && sameCode(x.code) === sameCode(requestedCode))) {
        return toast('這個登入帳號已經存在，請換一個帳號');
      }

      const oldCode = user.code;
      if (codeChanged) user.code = requestedCode;
      if (passwordChanged) {
        user.passwordHash = await hash(newPassword);
        user.mustChangePassword = false;
        user.passwordChangedAt = now();
      }
      user.updatedAt = now();
      writeAuth(auth);
      currentUser.code = user.code;
      currentUser.mustChangePassword = !!user.mustChangePassword;
      const sessionValue = JSON.stringify(currentUser);
      if (localStorage.getItem(SESSION_KEY)) {
        localStorage.setItem(SESSION_KEY, sessionValue);
        sessionStorage.removeItem(SESSION_KEY);
      } else {
        sessionStorage.setItem(SESSION_KEY, sessionValue);
        localStorage.removeItem(SESSION_KEY);
      }
      q('#oldPassword').value = q('#newLoginCode').value = q('#newPassword').value = q('#newPassword2').value = '';
      renderUser();
      await Promise.resolve(saveAudit('修改登入帳號與密碼', { oldCode, newCode: user.code, passwordChanged }));
      const changedText = codeChanged && passwordChanged ? '登入帳號與密碼' : codeChanged ? '登入帳號' : '密碼';
      originalToast(`${changedText}已修改並保存`);
      speak(`${changedText}已修改完成。`, 'success');
    };

    q('#addUser').onclick = async () => {
      if (currentUser?.role !== 'admin') return toast('只有管理員可以新增使用者');
      const name = q('#newUserName').value.trim();
      const code = q('#newUserCode').value.trim();
      const password = q('#newUserPassword').value;
      const role = q('#newUserRole').value === 'admin' ? 'admin' : 'staff';
      if (!name) return toast('請輸入使用姓名');
      if (!code || code.length < 3 || code.length > 30 || /\s/.test(code)) return toast('登入帳號需為 3～30 碼，且不能包含空白');
      if (!password || password.length < 4) return toast('初始密碼至少四碼');
      const auth = await ensureAuth();
      const same = value => String(value || '').trim().toLowerCase();
      if (auth.users.some(x => same(x.code) === same(code))) return toast('這個登入帳號已經存在，請換一個帳號');
      auth.users.push({ code, name, role, enabled: true, mustChangePassword: true, passwordHash: await hash(password), createdAt: now() });
      writeAuth(auth);
      q('#newUserName').value = q('#newUserCode').value = q('#newUserPassword').value = '';
      q('#newUserRole').value = 'staff';
      renderUserManagement();
      await Promise.resolve(saveAudit('新增使用者', { code, name, role }));
      originalToast(`使用者「${name}」已新增`);
      speak('使用者已新增完成。', 'success');
    };

    const copySystemInfo = q('#copySystemInfo');
    if (copySystemInfo) copySystemInfo.onclick = async () => {
      const text = `${typeof getSystemName === 'function' ? getSystemName() : '雙發付款管理系統'}\nV8.3 Build 0321\n資料庫版本：DB 3.0\n最後更新：2026/08/20\n雲端授權：啟用；付款資料仍只保存於本機`;
      try {
        await navigator.clipboard.writeText(text);
        originalToast('系統資訊已複製');
        speak('系統資訊已複製。', 'success');
      } catch {
        prompt('請複製以下系統資訊：', text);
      }
    };

    q('#saveBtn').addEventListener('click', () => {
      const before = db.payments.length;
      let attempts = 0;
      const checkSaved = setInterval(() => {
        attempts += 1;
        if (db.payments.length > before) {
          clearInterval(checkSaved);
          const payment = db.payments[0];
          saveAudit('新增付款', { serial: payment?.serial || '' });
        } else if (attempts >= 20) {
          clearInterval(checkSaved);
        }
      }, 250);
    });

    q('#editPaymentBtn').onclick = openCorrectionModal;
    q('#cancelCorrection').onclick = closeCorrectionModal;
    q('#saveCorrection').onclick = saveCorrection;
    q('#correctionField').onchange = () => {
      const payment = db.payments.find(x => x.id === editingPaymentId);
      if (payment) q('#correctionNewValue').placeholder = `原始內容：${originalValue(payment, q('#correctionField').value)}`;
    };

    q('#homeRevisionCard').onclick = () => {
      show('revisions');
      renderCorrections();
    };
    q('#revisionSearch').oninput = renderCorrections;

    ['pointerdown', 'keydown', 'touchstart'].forEach(eventName => {
      window.addEventListener(eventName, () => {
        unlockVoice();
        resetIdleTimer();
      }, { passive: true });
    });
  }

  const originalToast = toast;
  toast = function(message) {
    originalToast(message);
    if (/完整備份已還原/.test(String(message))) { speak('備份資料已還原完成。', 'backup'); return; }
    if (/請|找不到|不可|錯誤|失敗|不正確|重複|不足|尚未|阻擋|範圍/.test(String(message))) {
      speak(String(message).endsWith('。') ? String(message) : `${message}。`, 'error');
    }
  };

  const originalShow = show;
  show = function(id, push = true) {
    if (id === 'settings' && !settingsAccessGranted) {
      originalToast('進入系統設定需要輸入目前登入密碼');
      return false;
    }
    if (id === 'settings') settingsAccessGranted = false;
    originalShow(id, push);
    if (id === 'settings') {
      syncLoginBrand();
      applyVoiceSettings();
    applyAudioSettings();
      renderUser();
      renderUserManagement();
    }
    if (id === 'revisions') renderCorrections();
  };

  const originalOpenDetail = openDetail;
  openDetail = function(id) {
    originalOpenDetail(id);
    renderDetailCorrections(id);
  };

  async function init() {
    injectUI();
    if (!LICENSE_ENABLED) {
      q('#licenseGate')?.classList.add('hidden');
      q('#licenseInfoCard')?.classList.add('hidden');
      document.body.classList.remove('login-locked');
    }
    if (typeof hydrateFromIndexedDB === 'function') await hydrateFromIndexedDB();
    if (typeof createOpeningBackup === 'function') await createOpeningBackup();
    licenseReady = await ensureLicense();
    renderLicenseInfo();
    syncLoginBrand();
    const systemInfo = q('#systemInfoCard .backup-status');
    if (systemInfo) systemInfo.innerHTML = '<b>目前版本</b><br>V8.3 Build 0321<br><small>雲端授權／裝置綁定測試版；付款資料、照片、簽名與備份仍只保存在本機</small>';
    const systemInfoHint = q('#systemInfoCard .hint');
    if (systemInfoHint) systemInfoHint.innerHTML = '最後更新：2026/08/20<br>資料庫版本：DB 3.0';
    settings.voiceEnabled = settings.voiceEnabled !== false;
    settings.voiceErrors = settings.voiceErrors !== false;
    settings.voiceSuccess = settings.voiceSuccess !== false;
    settings.voiceBackup = settings.voiceBackup !== false;
    settings.voiceDue = settings.voiceDue !== false;
    settings.voiceGender = ['auto', 'female', 'male'].includes(settings.voiceGender) ? settings.voiceGender : 'auto';
    settings.voiceVolume = Number(settings.voiceVolume ?? 0.9);
    settings.voiceRate = Number(settings.voiceRate || 1);
    saveSettings();
    applyVoiceSettings();
    installEvents();
    // 若啟動時第一次雲端恢復遇到時序或短暫網路問題，
    // 自動執行和「檢查授權保存」相同的恢復流程，不要求使用者再按一次。
    if (!licenseReady && LICENSE_ENABLED) {
      await checkLicenseStorage(null);
    }
    if (!licenseReady) {
      showLicenseGate(licenseValidationMessage || '尚未啟用授權，請連網輸入公司專用授權碼。');
      return;
    }
    await ensureAuth();
    await restoreSession();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
