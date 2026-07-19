

    const GAS_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbwBf85PSB_G8ovzVU-f2wyu8ogrbwlkf8IcqzotPOt3SKCyb6HntYZdk3_R4lEOEZY/exec';
    installAppsScriptBridge();

    function installAppsScriptBridge() {
      if (typeof google !== 'undefined' && google.script && google.script.run) return;
      if (window.location.protocol === 'file:') return;

      const READ_METHODS = new Set(['getBootstrapData', 'getDashboard', 'getNasData', 'listUsers']);
      const CACHE_TTL_BY_METHOD = {
        getBootstrapData: 15000,
        getDashboard: 15000,
        getNasData: 60000,
        listUsers: 60000
      };
      const responseCache = new Map();
      const inFlightReads = new Map();
      const mutationLocks = new Map();
      const DUPLICATE_REQUEST = {};
      let pendingRequests = 0;
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

      function requestKey(method, args) {
        try {
          return method + ':' + JSON.stringify(args);
        } catch (error) {
          return method + ':' + String(args);
        }
      }

      function setApiPending(delta) {
        pendingRequests = Math.max(0, pendingRequests + delta);
        document.documentElement.toggleAttribute('data-api-loading', pendingRequests > 0);
        updateConnectionStatus(pendingRequests > 0 ? 'loading' : 'online');
      }

      async function fetchApi(method, args) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);
        setApiPending(1);
        let response;
        try {
          response = await fetch(GAS_WEB_APP_URL, {
            method: 'POST',
            mode: 'cors',
            redirect: 'follow',
            cache: 'no-store',
            credentials: 'omit',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ fn: method, args }),
            signal: controller.signal
          });
        } catch (error) {
          const requestError = new Error(
            error && error.name === 'AbortError'
              ? 'การเชื่อมต่อใช้เวลานานเกินไป กรุณาลองอีกครั้ง'
              : 'เชื่อมต่อ Google Apps Script ไม่สำเร็จ กรุณาตรวจอินเทอร์เน็ตและการ Deploy'
          );
          requestError.transient = true;
          throw requestError;
        } finally {
          clearTimeout(timeoutId);
          setApiPending(-1);
        }

        const text = await response.text();
        if (!response.ok) {
          const httpError = new Error('Google Apps Script ตอบกลับ HTTP ' + response.status);
          httpError.transient = response.status === 408 || response.status === 429 || response.status >= 500;
          throw httpError;
        }

        let result;
        try {
          result = JSON.parse(text);
        } catch (error) {
          throw new Error('รูปแบบคำตอบจาก Google Apps Script ไม่ใช่ JSON กรุณา Deploy เวอร์ชันล่าสุดอีกครั้ง');
        }
        if (!result || result.ok !== true) {
          throw new Error((result && (result.error || result.message)) || 'Google Apps Script ทำงานไม่สำเร็จ');
        }
        return result.data;
      }

      async function fetchWithRetry(method, args) {
        const attempts = READ_METHODS.has(method) ? 2 : 1;
        let lastError;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          try {
            return await fetchApi(method, args);
          } catch (error) {
            lastError = error;
            if (!error.transient || attempt === attempts - 1) break;
            await sleep(500 * (attempt + 1));
          }
        }
        throw lastError;
      }

      function callRemote(method, args) {
        const key = requestKey(method, args);
        if (READ_METHODS.has(method)) {
          const cached = responseCache.get(key);
          if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.data);
          if (inFlightReads.has(key)) return inFlightReads.get(key);
          const task = fetchWithRetry(method, args)
            .then(data => {
              const ttl = CACHE_TTL_BY_METHOD[method] || 0;
              if (ttl) responseCache.set(key, { data, expiresAt: Date.now() + ttl });
              return data;
            })
            .finally(() => inFlightReads.delete(key));
          inFlightReads.set(key, task);
          return task;
        }

        if (mutationLocks.has(key)) return Promise.resolve(DUPLICATE_REQUEST);
        responseCache.clear();
        const task = fetchWithRetry(method, args).finally(() => mutationLocks.delete(key));
        mutationLocks.set(key, task);
        return task;
      }

      const createRunner = (successHandler, failureHandler) => new Proxy({}, {
        get(target, prop) {
          if (prop === 'withSuccessHandler') return handler => createRunner(handler, failureHandler);
          if (prop === 'withFailureHandler') return handler => createRunner(successHandler, handler);
          return (...args) => {
            callRemote(String(prop), args)
              .then(data => {
                if (data !== DUPLICATE_REQUEST && successHandler) successHandler(data);
              })
              .catch(error => {
                if (failureHandler) failureHandler(error);
                else console.error(error);
              });
          };
        }
      });

      window.google = window.google || {};
      window.google.script = window.google.script || {};
      window.google.script.run = createRunner(null, null);
    }

    const state = {
      token: localStorage.getItem('mycenter_token') || '',
      user: null,
      options: { callVerStatuses: [], installStatuses: [], billStatuses: [], roles: [] },
      allRecords: [],
      records: [],
      nas: [],
      nasSummary: {
        totalJobs: 0,
        totalBills: 0,
        paidBills: 0,
        unpaidBills: 0,
        totalAmount: 0,
        unpaidAmount: 0,
        paidPercent: 0,
        unpaidPercent: 0
      },
      callLogs: [],
      users: [],
      nasCache: {},
      loadingNas: false,
      loadingUsers: false,
      savingRecord: false,
      recentRecordSubmissions: new Map(),
      savingUser: false,
      loginPending: false,
      pendingNasSaves: new Set(),
      pendingDeletes: new Set(),
      dashboardRequestSeq: 0,
      nasRequestSeq: 0,
      recordRenderLimit: 250,
      nasRenderLimit: 120,
      duplicateIndex: { code: new Map(), name: new Map(), phone: new Map() },
      searchFilter: {
        keyword: '', dateFrom: '', dateTo: '', month: '', year: '',
        statuses: [], callVerStatuses: [], users: [], sort: 'date-desc'
      },
      nasFilter: {
        billStatuses: [], archiveStatuses: [], users: [], dueFrom: '', dueTo: '',
        amountMin: '', amountMax: '', sort: 'date-desc'
      },
      dashboard: { total: 0, counts: {}, records: [] },
      dashboardPeriod: 'day',
      dashboardMonth: new Date().getMonth() + 1,
      dashboardYear: new Date().getFullYear()
    };

    const $ = id => document.getElementById(id);
    const views = ['dashboard', 'form', 'search', 'nas', 'users'];
    const THAI_MONTHS = [
      'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
      'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'
    ];


    function debounce(callback, wait) {
      let timerId = 0;
      const debounced = (...args) => {
        clearTimeout(timerId);
        timerId = setTimeout(() => callback(...args), wait);
      };
      debounced.cancel = () => clearTimeout(timerId);
      debounced.flush = (...args) => {
        clearTimeout(timerId);
        callback(...args);
      };
      return debounced;
    }

    function scheduleNonBlockingRender(callback) {
      if ('requestIdleCallback' in window) requestIdleCallback(callback, { timeout: 900 });
      else setTimeout(callback, 0);
    }

    const renderNasDebounced = debounce(() => renderNas(), 180);
    const applySearchFiltersDebounced = debounce(() => applySearchFilters(), 180);
    const updateDuplicateWarningDebounced = debounce(() => updateDuplicateWarning(), 120);

    document.addEventListener('DOMContentLoaded', init);

    function init() {
      bindEvents();
      showRuntimeWarningIfNeeded();
      updateConnectionStatus(navigator.onLine ? 'online' : 'offline');
      if (state.token) {
        loadBootstrap();
      } else {
        showLogin();
      }
    }

    function bindEvents() {
      $('loginForm').addEventListener('submit', doLogin);
      $('logoutBtn').addEventListener('click', doLogout);
      document.querySelectorAll('.nav button').forEach(button => {
        button.addEventListener('click', () => showView(button.dataset.view));
      });
      document.querySelectorAll('#dashboardPeriodTabs button').forEach(button => {
        button.addEventListener('click', () => loadDashboard(button.dataset.period));
      });
      $('dashboardMonth').addEventListener('change', () => {
        state.dashboardMonth = Number($('dashboardMonth').value);
        loadDashboard(state.dashboardPeriod);
      });
      $('dashboardYear').addEventListener('change', () => {
        state.dashboardYear = Number($('dashboardYear').value);
        loadDashboard(state.dashboardPeriod);
      });
      $('dashboardUserFilter').addEventListener('change', () => loadDashboard(state.dashboardPeriod));
      $('nasKeywordFilter').addEventListener('input', renderNasDebounced);
      $('nasUserFilter').addEventListener('change', () => loadNas());
      $('nasMonth').addEventListener('change', () => loadNas());
      $('nasYear').addEventListener('change', () => loadNas());
      ['nasAmountMin', 'nasAmountMax', 'nasDueFrom', 'nasDueTo', 'nasSort'].forEach(id => {
        $(id).addEventListener(id === 'nasSort' ? 'change' : 'input', id === 'nasSort' ? renderNas : renderNasDebounced);
      });
      $('resetNasFiltersBtn').addEventListener('click', resetNasFilters);
      $('recordForm').addEventListener('submit', saveRecord);
      $('resetFormBtn').addEventListener('click', resetRecordForm);
      ['code96xxx', 'customerName', 'customerPhone'].forEach(id => {
        $(id).addEventListener('input', updateDuplicateWarningDebounced);
      });
      $('searchBtn').addEventListener('click', searchRecords);
      ['keywordFilter', 'searchDateFrom', 'searchDateTo'].forEach(id => {
        $(id).addEventListener('input', applySearchFiltersDebounced);
      });
      ['searchMonth', 'searchYear', 'searchSort'].forEach(id => {
        $(id).addEventListener('change', applySearchFilters);
      });
      $('resetSearchFiltersBtn').addEventListener('click', resetSearchFilters);
      $('newRecordBtn').addEventListener('click', () => {
        resetRecordForm();
        showView('form');
      });
      $('userForm').addEventListener('submit', saveUser);
      $('clearUserBtn').addEventListener('click', clearUserForm);
      $('repairSystemBtn').addEventListener('click', repairSystemData);
      $('showMoreSearchBtn').addEventListener('click', () => {
        state.recordRenderLimit += 250;
        renderRecords();
      });
      $('showMoreNasBtn').addEventListener('click', () => {
        state.nasRenderLimit += 120;
        renderNas();
      });
      window.addEventListener('online', () => updateConnectionStatus('online'));
      window.addEventListener('offline', () => updateConnectionStatus('offline'));
    }

    function doLogin(event) {
      event.preventDefault();
      if (state.loginPending) return;
      if (!hasAppsScriptRuntime()) {
        toast('กรุณาเปิดผ่าน URL ของ Google Apps Script Web app ไม่ใช่เปิดไฟล์ Index.html จากเครื่อง');
        showRuntimeWarningIfNeeded();
        return;
      }
      const button = $('loginForm').querySelector('button[type="submit"]');
      state.loginPending = true;
      if (button) {
        button.disabled = true;
        button.textContent = 'กำลังเข้าสู่ระบบ...';
      }
      const finish = () => {
        state.loginPending = false;
        if (button) {
          button.disabled = false;
          button.textContent = 'เข้าสู่ระบบ';
        }
      };
      google.script.run
        .withSuccessHandler(result => {
          finish();
          state.token = result.token;
          localStorage.setItem('mycenter_token', state.token);
          applyBootstrap(result.bootstrap);
          showApp();
          showView('dashboard');
        })
        .withFailureHandler(error => {
          finish();
          showError(error);
        })
        .login({ username: $('loginUsername').value, password: $('loginPassword').value });
    }
    function doLogout() {
      const token = state.token;
      localStorage.removeItem('mycenter_token');
      state.token = '';
      state.user = null;
      showLogin();
      if (token) google.script.run.logout(token);
    }

    function loadBootstrap() {
      if (!hasAppsScriptRuntime()) {
        localStorage.removeItem('mycenter_token');
        state.token = '';
        showLogin();
        showRuntimeWarningIfNeeded();
        return;
      }
      google.script.run
        .withSuccessHandler(data => {
          applyBootstrap(data);
          showApp();
          showView('dashboard');
        })
        .withFailureHandler(() => {
          localStorage.removeItem('mycenter_token');
          state.token = '';
          showLogin();
        })
        .getBootstrapData(state.token);
    }

    function applyBootstrap(data) {
      Object.assign(state, data);
      state.allRecords = data.records || [];
      state.records = data.records || [];
      state.recordRenderLimit = 250;
      state.nasRenderLimit = 120;
      refreshDuplicateIndex();
      state.nasSummary = data.nasSummary || buildLocalNasSummary();
      hydrateOptions();
      hydrateDashboardPeriodSelectors();
      renderAll();
      resetRecordForm();
    }

    function showLogin() {
      $('loginScreen').classList.remove('hidden');
      $('appShell').classList.add('hidden');
      $('loginPassword').value = '';
    }

    function showApp() {
      $('loginScreen').classList.add('hidden');
      $('appShell').classList.remove('hidden');
    }

    function hasAppsScriptRuntime() {
      return typeof google !== 'undefined' && google.script && google.script.run;
    }

    function showRuntimeWarningIfNeeded() {
      const warning = $('runtimeWarning');
      if (!warning) return;
      warning.style.display = window.location.protocol === 'file:' ? 'block' : 'none';
    }

    function updateConnectionStatus(status) {
      const node = $('connectionStatus');
      if (!node) return;
      const labels = {
        online: 'เชื่อมต่อระบบแล้ว',
        loading: 'กำลังประมวลผลข้อมูล',
        offline: 'ออฟไลน์: ตรวจสอบอินเทอร์เน็ต'
      };
      node.textContent = labels[status] || labels.online;
      node.classList.toggle('is-loading', status === 'loading');
      node.classList.toggle('is-offline', status === 'offline');
    }

    function hydrateOptions() {
      fillSelect($('callVerStatus'), state.options.callVerStatuses, 'เลือก Call Ver Status');
      fillSelect($('installStatus'), state.options.installStatuses, '');
      fillSelect($('userRole'), state.options.roles, '');
      $('dashboardUserFilter').disabled = !canSeeAll();
      $('nasUserFilter').disabled = !canSeeAll();
    }

    function hydrateDashboardPeriodSelectors() {
      $('dashboardMonth').innerHTML = THAI_MONTHS.map((name, index) => `<option value="${index + 1}">${name}</option>`).join('');

      const currentYear = new Date().getFullYear();
      const years = [];
      for (let year = currentYear - 5; year <= currentYear + 2; year++) years.push(year);
      $('dashboardYear').innerHTML = years.map(year => `<option value="${year}">${year + 543}</option>`).join('');
      $('dashboardMonth').value = state.dashboardMonth;
      $('dashboardYear').value = state.dashboardYear;
      $('nasMonth').innerHTML = $('dashboardMonth').innerHTML;
      $('nasYear').innerHTML = $('dashboardYear').innerHTML;
      $('nasMonth').value = state.dashboardMonth;
      $('nasYear').value = state.dashboardYear;

      $('searchMonth').innerHTML = '<option value="">ทุกเดือน</option>' + $('dashboardMonth').innerHTML;
      $('searchYear').innerHTML = '<option value="">ทุกปี</option>' + $('dashboardYear').innerHTML;
      $('searchMonth').value = state.searchFilter.month;
      $('searchYear').value = state.searchFilter.year;

      $('nasMonth').insertAdjacentHTML('afterbegin', '<option value="0">ทุกเดือน</option>');
      $('nasYear').insertAdjacentHTML('afterbegin', '<option value="0">ทุกปี</option>');
    }

    function fillSelect(select, items, firstLabel) {
      select.innerHTML = '';
      if (firstLabel !== '') {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = firstLabel;
        select.appendChild(option);
      }
      items.forEach(item => {
        const option = document.createElement('option');
        option.value = item;
        option.textContent = item;
        select.appendChild(option);
      });
    }

    function renderFilterFacets() {
      const recordUsers = uniqueValues(state.allRecords, 'OwnerUsername');
      const nasUsers = uniqueValues(state.nas, 'OwnerUsername');
      renderFacetFilters('searchFacetFilters', [
        { key: 'statuses', label: 'สถานะติดตั้ง', values: state.options.installStatuses },
        { key: 'callVerStatuses', label: 'Call Ver', values: state.options.callVerStatuses },
        { key: 'users', label: 'USER', values: canSeeAll() ? recordUsers : [state.user && state.user.username].filter(Boolean) }
      ], state.searchFilter, applySearchFilters);
      renderFacetFilters('nasFacetFilters', [
        { key: 'billStatuses', label: 'สถานะบิล', values: state.options.billStatuses },
        { key: 'archiveStatuses', label: 'จัดเก็บไฟล์', values: ['รอติดตามบิล', 'จัดเก็บไฟล์ได้'] },
        { key: 'users', label: 'USER', values: canSeeAll() ? nasUsers : [state.user && state.user.username].filter(Boolean) }
      ], state.nasFilter, renderNas);
    }

    function renderFacetFilters(containerId, definitions, filterState, onChange) {
      const container = $(containerId);
      if (!container) return;
      container.innerHTML = definitions.map(definition => {
        const selected = filterState[definition.key] || [];
        const values = [...new Set((definition.values || []).filter(Boolean).map(String))];
        return `
          <details class="facet" data-facet-key="${escapeAttr(definition.key)}">
            <summary>
              ${escapeHtml(definition.label)}
              <span class="facet-badge ${selected.length ? '' : 'hidden'}">${selected.length}</span>
            </summary>
            <div class="facet-menu">
              ${values.length ? values.map(value => `
                <label>
                  <input type="checkbox" data-facet="${escapeAttr(definition.key)}" value="${escapeAttr(value)}" ${selected.includes(value) ? 'checked' : ''}>
                  <span>${escapeHtml(value)}</span>
                </label>
              `).join('') : '<div class="nas-note" style="margin:8px">ไม่มีตัวเลือก</div>'}
            </div>
          </details>
        `;
      }).join('');
      container.querySelectorAll('input[data-facet]').forEach(input => {
        input.addEventListener('change', () => {
          const key = input.dataset.facet;
          const checked = [...container.querySelectorAll(`input[data-facet="${key}"]:checked`)].map(node => node.value);
          filterState[key] = checked;
          const details = input.closest('details');
          const badge = details && details.querySelector('.facet-badge');
          if (badge) {
            badge.textContent = checked.length;
            badge.classList.toggle('hidden', !checked.length);
          }
          onChange();
        });
      });
    }

    function uniqueValues(rows, key) {
      return [...new Set((rows || []).map(row => String(row[key] || '').trim()).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, 'th'));
    }

    function searchColumnDefinitions() {
      return [
        { key: 'code', label: '96xxx' },
        { key: 'name', label: 'ชื่อ-นามสกุล' },
        { key: 'date', label: 'วันที่ติดตั้ง' },
        { key: 'callver', label: 'Call Ver' },
        { key: 'status', label: 'สถานะ' },
        { key: 'phone', label: 'เบอร์ลูกค้า' },
        { key: 'user', label: 'USER' }
      ];
    }

    function nasColumnDefinitions() {
      return [
        { key: 'code', label: '96xxx' },
        { key: 'name', label: 'ชื่อ-นามสกุล' },
        { key: 'date', label: 'วันที่ติดตั้ง' },
        { key: 'phone', label: 'เบอร์โทรลูกค้า' },
        { key: 'user', label: 'USER' },
        { key: 'bill1', label: 'บิล1' },
        { key: 'bill2', label: 'บิล2' },
        { key: 'bill3', label: 'บิล3' },
        { key: 'bill4', label: 'บิล4' },
        { key: 'archive', label: 'จัดเก็บไฟล์' }
      ];
    }

    function showView(view) {
      views.forEach(name => $(`${name}View`).classList.toggle('hidden', name !== view));
      document.querySelectorAll('.nav button').forEach(button => {
        button.classList.toggle('active', button.dataset.view === view);
      });
      const titles = {
        dashboard: 'แดชบอร์ด',
        form: $('recordId').value ? 'แก้ไขข้อมูล' : 'คีย์ข้อมูลใหม่',
        search: 'ค้นหาข้อมูล',
        nas: 'NAS',
        users: 'จัดการ USER'
      };
      $('pageTitle').textContent = titles[view];
      if (view === 'search') applySearchFilters();
      if (view === 'nas') loadNas();
      if (view === 'users') {
        renderUsers();
        loadUsers();
      }
    }

    function renderAll() {
      renderUser();
      renderDashboard();
      renderFilterFacets();
      scheduleNonBlockingRender(() => {
        applySearchFilters();
        renderNas();
        renderUsers();
      });
    }
    function renderUser() {
      $('rolePill').textContent = state.user.role;
      $('userBox').innerHTML = `<strong>${escapeHtml(state.user.name)}</strong><br>USER: ${escapeHtml(state.user.username)}`;
      $('usersNav').classList.toggle('hidden', state.user.role !== 'ADMIN');
      $('staffPermissionNote').classList.toggle('hidden', !isStaff());
    }

    function renderDashboard() {
      state.dashboardPeriod = state.dashboard.period || state.dashboardPeriod || 'day';
      state.dashboardMonth = Number(state.dashboard.month || state.dashboardMonth || new Date().getMonth() + 1);
      state.dashboardYear = Number(state.dashboard.year || state.dashboardYear || new Date().getFullYear());
      $('dashboardMonth').value = state.dashboardMonth;
      $('dashboardYear').value = state.dashboardYear;
      document.querySelectorAll('#dashboardPeriodTabs button').forEach(button => {
        button.classList.toggle('active', button.dataset.period === state.dashboardPeriod);
      });

      const cards = [
        ['ทั้งหมด', state.dashboard.total, ''],
        ...state.options.installStatuses.map(status => [status, state.dashboard.counts[status] || 0, status])
      ];
      $('dashboardCards').innerHTML = cards.map(([label, value, className]) => `
        <div class="stat">
          <span>${escapeHtml(label)}</span>
          <strong class="${className}">${value}</strong>
        </div>
      `).join('');
      renderDashboardRecords();
    }

    function renderDashboardRecords() {
      const body = $('dashboardRecordsBody');
      const records = state.dashboard.records || [];
      if (!records.length) {
        body.innerHTML = '<tr><td colspan="8">ไม่พบข้อมูลในช่วงเวลานี้</td></tr>';
        return;
      }
      body.innerHTML = records.map(record => `
        <tr>
          <td>${escapeHtml(record.Code96xxx)}</td>
          <td>${escapeHtml(record.CustomerName)}</td>
          <td>${escapeHtml(record.InstallDate)}</td>
          <td>${escapeHtml(record.CallVerStatus)}</td>
          <td><span class="badge ${escapeHtml(record.InstallStatus)}">${escapeHtml(record.InstallStatus)}</span></td>
          <td>${escapeHtml(record.CustomerPhone)}</td>
          <td>${escapeHtml(record.OwnerUsername)}</td>
          <td>${recordActionButtons(record)}</td>
        </tr>
      `).join('');
    }

    function loadDashboard(period) {
      state.dashboardPeriod = period || state.dashboardPeriod || 'day';
      const requestSeq = ++state.dashboardRequestSeq;
      google.script.run
        .withSuccessHandler(dashboard => {
          if (requestSeq !== state.dashboardRequestSeq) return;
          state.dashboard = dashboard;
          renderDashboard();
        })
        .withFailureHandler(error => {
          if (requestSeq === state.dashboardRequestSeq) showError(error);
        })
        .getDashboard(state.token, getDashboardPeriodPayload());
    }
    function recordActionButtons(record) {
      const edit = `<button class="btn btn-ghost btn-small" type="button" onclick="editRecord('${escapeAttr(record.ID)}')">แก้ไข</button>`;
      const remove = isStaff() ? '' : `<button class="btn btn-danger btn-small" type="button" data-record-delete="${escapeAttr(record.ID)}" onclick="removeRecord('${escapeAttr(record.ID)}')">ลบ</button>`;
      return `<div class="top-actions">${edit}${remove}</div>`;
    }

    function renderRecords() {
      const body = $('recordsBody');
      const table = body.closest('table');
      const columns = searchColumnDefinitions();
      const headers = [
        ...columns.map(column => `<th>${escapeHtml(column.label)}</th>`),
        '<th>อัปเดต</th>',
        '<th>จัดการ</th>'
      ].join('');
      $('searchResultCount').textContent = `${state.records.length.toLocaleString('th-TH')} รายการ`;
      renderSearchMonthChips();
      const visibleRecords = state.records.slice(0, state.recordRenderLimit);
      const renderKey = JSON.stringify([
        state.records.length,
        state.recordRenderLimit,
        visibleRecords.map(record => [record.ID, record.UpdatedAt, record.CreatedAt])
      ]);
      if (body.dataset.renderKey === renderKey) return;
      body.dataset.renderKey = renderKey;
      table.querySelector('thead').innerHTML = `<tr>${headers}</tr>`;
      updateTablePagination('search', visibleRecords.length, state.records.length, 'รายการค้นหา');
      if (!state.records.length) {
        body.innerHTML = `<tr><td class="empty-state" colspan="${columns.length + 2}">ไม่พบข้อมูลที่ตรงกับตัวกรอง</td></tr>`;
        return;
      }
      const duplicateIndex = buildDuplicateIndex(visibleRecords);
      const groups = groupRecordsByMonth(visibleRecords);
      body.innerHTML = groups.map(group => `
        <tr class="month-group-row">
          <td colspan="${columns.length + 2}">
            <div class="month-group-content">
              <span>${escapeHtml(group.label)}</span>
              <span>${group.records.length.toLocaleString('th-TH')} รายการ</span>
            </div>
          </td>
        </tr>
        ${group.records.map(record => `
          <tr>
            ${columns.map(column => renderRecordColumn(record, column.key, duplicateIndex)).join('')}
            <td>${escapeHtml(record.UpdatedAt || record.CreatedAt)}</td>
            <td>${recordActionButtons(record)}</td>
          </tr>
        `).join('')}
      `).join('');
    }

    function groupRecordsByMonth(records) {
      const groups = new Map();
      records.forEach(record => {
        const match = String(record.InstallDate || '').match(/^(\d{4})-(\d{2})/);
        const key = match ? `${match[1]}-${match[2]}` : 'undated';
        if (!groups.has(key)) {
          const label = match
            ? `${THAI_MONTHS[Number(match[2]) - 1]} ${Number(match[1]) + 543}`
            : 'ไม่ระบุวันที่ติดตั้ง';
          groups.set(key, { key, label, records: [] });
        }
        groups.get(key).records.push(record);
      });
      return [...groups.values()];
    }

    function renderSearchMonthChips() {
      const container = $('searchMonthChips');
      if (!container) return;
      const filter = Object.assign({}, getSearchFilter(), { month: '' });
      const rows = filterLocalRecords(state.allRecords, filter);
      const counts = Array(12).fill(0);
      rows.forEach(record => {
        const match = String(record.InstallDate || '').match(/^\d{4}-(\d{2})/);
        if (match) counts[Number(match[1]) - 1]++;
      });
      const selected = String($('searchMonth').value || '');
      container.innerHTML = `
        <button class="month-chip ${selected ? '' : 'active'}" type="button" data-month="">ทุกเดือน <small>${rows.length}</small></button>
        ${THAI_MONTHS.map((name, index) => `
          <button class="month-chip ${selected === String(index + 1) ? 'active' : ''}" type="button" data-month="${index + 1}">
            ${escapeHtml(name)} <small>${counts[index]}</small>
          </button>
        `).join('')}
      `;
      container.querySelectorAll('button[data-month]').forEach(button => {
        button.addEventListener('click', () => {
          $('searchMonth').value = button.dataset.month;
          applySearchFilters();
        });
      });
    }

    function renderRecordColumn(record, key, duplicateIndex) {
      const duplicate = getDuplicateFields(record, duplicateIndex);
      const cellClass = field => duplicate.includes(field) ? 'duplicate-cell' : '';
      const map = {
        code: `<span class="${cellClass('code')}">${escapeHtml(record.Code96xxx)}</span>`,
        name: `<span class="${cellClass('name')}">${escapeHtml(record.CustomerName)}</span>`,
        date: escapeHtml(record.InstallDate),
        callver: escapeHtml(record.CallVerStatus),
        status: `<span class="badge ${escapeHtml(record.InstallStatus)}">${escapeHtml(record.InstallStatus)}</span>`,
        phone: `<span class="${cellClass('phone')}">${escapeHtml(record.CustomerPhone)}</span>`,
        user: userBadge(record.OwnerUsername)
      };
      return `<td>${map[key] || ''}</td>`;
    }

    function renderNas() {
      const nasRows = filterNasRows(state.nas);
      const visibleNasRows = nasRows.slice(0, state.nasRenderLimit);
      const summary = buildNasSummaryFromRows(nasRows);
      $('nasResultCount').textContent = `${nasRows.length.toLocaleString('th-TH')} รายการ`;
      $('nasTotal').textContent = summary.totalJobs || nasRows.length;
      $('nasUnpaidAmount').textContent = formatMoney(summary.unpaidAmount);
      $('nasTotalAmount').textContent = formatMoney(summary.totalAmount);
      $('nasPaidPercent').textContent = `${summary.paidPercent || 0}%`;
      $('nasUnpaidPercent').textContent = `${summary.unpaidPercent || 0}%`;
      $('nasCalls').textContent = state.callLogs.length;
      $('callLogsTitle').textContent = canSeeAll() ? 'ประวัติการโทรทั้งหมด' : 'ประวัติการโทรของฉัน';

      const body = $('nasBody');
      const table = body.closest('table');
      const columns = nasColumnDefinitions();
      const nasTableKey = JSON.stringify([
        nasRows.length,
        state.nasRenderLimit,
        visibleNasRows.map(item => [item.ID, item.UpdatedAt, item.ArchiveStatus])
      ]);
      if (body.dataset.renderKey !== nasTableKey) {
        body.dataset.renderKey = nasTableKey;
        updateTablePagination('nas', visibleNasRows.length, nasRows.length, 'รายการ NAS');
        table.querySelector('thead').innerHTML = `
        <tr>
          ${columns.map(column => `<th>${escapeHtml(column.label)}</th>`).join('')}
          <th>จัดการ</th>
        </tr>
      `;
      if (!nasRows.length) {
        body.innerHTML = `<tr><td colspan="${columns.length + 1}">ไม่มีรายการ Completed สำหรับ NAS</td></tr>`;
      } else {
        const duplicateIndex = buildDuplicateIndex(visibleNasRows);
        body.innerHTML = visibleNasRows.map(item => `
          <tr>
            ${columns.map(column => renderNasColumn(item, column, duplicateIndex)).join('')}
            <td data-label="จัดการ">
              <div class="nas-row-actions">
                <div class="row-total">
                  <span>TOTAL</span>
                  <strong id="nas-${escapeAttr(item.ID)}-total">${formatMoney(rowBillTotal(item))}</strong>
                </div>
                <button class="btn btn-primary btn-small" type="button" data-nas-save="${escapeAttr(item.ID)}" onclick="saveNasBilling('${escapeAttr(item.ID)}')">บันทึกบิล</button>
              </div>
            </td>
          </tr>
        `).join('');
      }
      }

      const logsBody = $('callLogsBody');
      const logsKey = JSON.stringify(state.callLogs.map(log => [
        log.CalledAt, log.Username, log.UserNickname, log.Code96xxx, log.CustomerName, log.CustomerPhone
      ]));
      if (logsBody.dataset.renderKey === logsKey) return;
      logsBody.dataset.renderKey = logsKey;
      if (!state.callLogs.length) {
        logsBody.innerHTML = '<tr><td colspan="5">ยังไม่มีประวัติการโทร</td></tr>';
        return;
      }
      logsBody.innerHTML = state.callLogs.map(log => `
        <tr>
          <td>${escapeHtml(log.CalledAt)}</td>
          <td>${userBadge(log.Username, log.UserNickname)}</td>
          <td>${escapeHtml(log.Code96xxx)}</td>
          <td>${escapeHtml(log.CustomerName || '')}</td>
          <td>${escapeHtml(log.CustomerPhone)}</td>
        </tr>
      `).join('');
    }

    function filterNasRows(rows) {
      const keyword = String($('nasKeywordFilter') ? $('nasKeywordFilter').value : '').trim().toLowerCase();
      state.nasFilter.dueFrom = $('nasDueFrom').value;
      state.nasFilter.dueTo = $('nasDueTo').value;
      state.nasFilter.amountMin = $('nasAmountMin').value;
      state.nasFilter.amountMax = $('nasAmountMax').value;
      state.nasFilter.sort = $('nasSort').value;
      const filter = state.nasFilter;

      const filtered = rows.filter(item => {
        if (keyword && ![
          item.Code96xxx, item.CustomerName, item.InstallDate, item.CustomerPhone, item.OwnerUsername,
          item.Bill1Status, item.Bill1DueDate, item.Bill1Amount,
          item.Bill2Status, item.Bill2DueDate, item.Bill2Amount,
          item.Bill3Status, item.Bill3DueDate, item.Bill3Amount,
          item.Bill4Status, item.Bill4DueDate, item.Bill4Amount,
          item.ArchiveStatus
        ].join(' ').toLowerCase().includes(keyword)) return false;

        if (filter.users.length && !filter.users.includes(String(item.OwnerUsername || ''))) return false;
        const billStatuses = [1, 2, 3, 4].map(index => String(item[`Bill${index}Status`] || ''));
        if (filter.billStatuses.length && !billStatuses.some(status => filter.billStatuses.includes(status))) return false;
        const archive = String(item.ArchiveStatus || archiveStatus(item));
        if (filter.archiveStatuses.length && !filter.archiveStatuses.includes(archive)) return false;

        const dueDates = [1, 2, 3, 4].map(index => String(item[`Bill${index}DueDate`] || '').slice(0, 10)).filter(Boolean);
        if ((filter.dueFrom || filter.dueTo) && !dueDates.some(date => {
          if (filter.dueFrom && date < filter.dueFrom) return false;
          if (filter.dueTo && date > filter.dueTo) return false;
          return true;
        })) return false;

        const total = rowBillTotal(item);
        if (filter.amountMin !== '' && total < Number(filter.amountMin)) return false;
        if (filter.amountMax !== '' && total > Number(filter.amountMax)) return false;
        return true;
      });

      const comparators = {
        'date-desc': (a, b) => String(b.InstallDate || '').localeCompare(String(a.InstallDate || '')),
        'date-asc': (a, b) => String(a.InstallDate || '').localeCompare(String(b.InstallDate || '')),
        'amount-desc': (a, b) => rowBillTotal(b) - rowBillTotal(a),
        'amount-asc': (a, b) => rowBillTotal(a) - rowBillTotal(b),
        'name-asc': (a, b) => String(a.CustomerName || '').localeCompare(String(b.CustomerName || ''), 'th')
      };
      return filtered.sort(comparators[filter.sort] || comparators['date-desc']);
    }

    function resetNasFilters() {
      state.nasFilter = {
        billStatuses: [], archiveStatuses: [], users: [], dueFrom: '', dueTo: '',
        amountMin: '', amountMax: '', sort: 'date-desc'
      };
      $('nasKeywordFilter').value = '';
      $('nasUserFilter').value = '';
      $('nasMonth').value = String(new Date().getMonth() + 1);
      $('nasYear').value = String(new Date().getFullYear());
      $('nasAmountMin').value = '';
      $('nasAmountMax').value = '';
      $('nasDueFrom').value = '';
      $('nasDueTo').value = '';
      $('nasSort').value = 'date-desc';
      renderFilterFacets();
      loadNas(true);
    }

    function renderNasColumn(item, column, duplicateIndex) {
      const duplicate = getDuplicateFields(item, duplicateIndex);
      const cellClass = field => duplicate.includes(field) ? 'duplicate-cell' : '';
      const map = {
        code: `<td data-label="${escapeAttr(column.label)}"><span class="text-strong nowrap ${cellClass('code')}">${escapeHtml(item.Code96xxx)}</span></td>`,
        name: `<td data-label="${escapeAttr(column.label)}"><span class="${cellClass('name')}">${escapeHtml(item.CustomerName)}</span></td>`,
        date: `<td data-label="${escapeAttr(column.label)}"><span class="nowrap">${escapeHtml(item.InstallDate)}</span></td>`,
        phone: `<td data-label="${escapeAttr(column.label)}"><a class="phone-link ${cellClass('phone')}" href="tel:${escapeAttr(normalizePhone(item.CustomerPhone))}" onclick="callCustomer('${escapeAttr(item.ID)}'); return false;">${escapeHtml(item.CustomerPhone)}</a></td>`,
        user: `<td data-label="${escapeAttr(column.label)}">${userBadge(item.OwnerUsername)}</td>`,
        bill1: `<td data-label="${escapeAttr(column.label)}">${billControl(item, 1)}</td>`,
        bill2: `<td data-label="${escapeAttr(column.label)}">${billControl(item, 2)}</td>`,
        bill3: `<td data-label="${escapeAttr(column.label)}">${billControl(item, 3)}</td>`,
        bill4: `<td data-label="${escapeAttr(column.label)}">${billControl(item, 4)}</td>`,
        archive: `<td data-label="${escapeAttr(column.label)}"><span class="badge ${archiveClass(item.ArchiveStatus)}">${escapeHtml(item.ArchiveStatus || archiveStatus(item))}</span></td>`
      };
      return map[column.key] || '';
    }

    function billControl(item, index) {
      const statusKey = `Bill${index}Status`;
      const dueKey = `Bill${index}DueDate`;
      const amountKey = `Bill${index}Amount`;
      const options = state.options.billStatuses.map(status => `
        <option value="${escapeAttr(status)}" ${item[statusKey] === status ? 'selected' : ''}>${escapeHtml(status)}</option>
      `).join('');
      return `
        <div class="bill-cell">
          <select class="bill-status ${billStatusClass(item[statusKey])}" id="nas-${escapeAttr(item.ID)}-bill${index}-status" onchange="applyBillStatusColor(this)">${options}</select>
          <input id="nas-${escapeAttr(item.ID)}-bill${index}-date" type="date" value="${escapeAttr(item[dueKey] || '')}">
          <input id="nas-${escapeAttr(item.ID)}-bill${index}-amount" type="number" min="0" step="0.01" inputmode="decimal" placeholder="จำนวนเงิน" value="${escapeAttr(item[amountKey] || '')}" oninput="updateRowBillTotal('${escapeAttr(item.ID)}')">
        </div>
      `;
    }

    function rowBillTotal(item) {
      return [1, 2, 3, 4].reduce((total, index) => total + Number(item[`Bill${index}Amount`] || 0), 0);
    }

    function updateRowBillTotal(recordId) {
      const total = [1, 2, 3, 4].reduce((sum, index) => {
        const input = $(`nas-${recordId}-bill${index}-amount`);
        return sum + Number(input && input.value ? input.value : 0);
      }, 0);
      const node = $(`nas-${recordId}-total`);
      if (node) node.textContent = formatMoney(total);
    }

    function billStatusClass(status) {
      return status === 'ชำระแล้ว' ? 'paid' : 'unpaid';
    }

    function applyBillStatusColor(select) {
      select.classList.toggle('paid', select.value === 'ชำระแล้ว');
      select.classList.toggle('unpaid', select.value !== 'ชำระแล้ว');
    }

    function saveNasBilling(recordId) {
      if (state.pendingNasSaves.has(recordId)) return;
      const payload = {
        RecordID: recordId,
        createdBy: $('nasUserFilter').value,
        month: $('nasMonth').value,
        year: $('nasYear').value
      };
      [1, 2, 3, 4].forEach(index => {
        payload[`Bill${index}Status`] = $(`nas-${recordId}-bill${index}-status`).value;
        payload[`Bill${index}DueDate`] = $(`nas-${recordId}-bill${index}-date`).value;
        payload[`Bill${index}Amount`] = $(`nas-${recordId}-bill${index}-amount`).value;
      });
      const button = Array.from(document.querySelectorAll('[data-nas-save]'))
        .find(item => item.dataset.nasSave === String(recordId));
      state.pendingNasSaves.add(recordId);
      if (button) {
        button.disabled = true;
        button.textContent = 'กำลังบันทึก...';
      }
      const finish = () => {
        state.pendingNasSaves.delete(recordId);
        if (button && button.isConnected) {
          button.disabled = false;
          button.textContent = 'บันทึกบิล';
        }
      };
      google.script.run
        .withSuccessHandler(result => {
          finish();
          state.nas = result.nas;
          state.nasSummary = result.nasSummary || buildLocalNasSummary();
          state.nasCache = {};
          renderFilterFacets();
          renderNas();
          toast('บันทึกข้อมูลบิลเรียบร้อย');
        })
        .withFailureHandler(error => {
          finish();
          showError(error);
        })
        .saveNasBilling(state.token, payload);
    }
    function callCustomer(recordId) {
      const item = state.nas.find(row => row.ID === recordId);
      const tel = normalizePhone(item && item.CustomerPhone);
      google.script.run
        .withSuccessHandler(result => {
          state.callLogs = result.callLogs;
          state.nasCache = {};
          renderNas();
        })
        .withFailureHandler(showError)
        .logNasCall(state.token, recordId);
      if (tel) window.location.href = `tel:${tel}`;
    }

    function loadNas(resetLimit = true) {
      if (resetLimit) state.nasRenderLimit = 120;
      const cacheKey = getNasCacheKey();
      const cached = state.nasCache[cacheKey];
      if (cached && Date.now() - cached.time < 60000) {
        state.nasRequestSeq += 1;
        state.loadingNas = false;
        state.nas = cached.nas;
        state.nasSummary = cached.nasSummary;
        state.callLogs = cached.callLogs;
        renderFilterFacets();
        renderNas();
        return;
      }
      const requestSeq = ++state.nasRequestSeq;
      state.loadingNas = true;
      google.script.run
        .withSuccessHandler(result => {
          if (requestSeq !== state.nasRequestSeq) return;
          state.nas = result.nas;
          state.nasSummary = result.nasSummary || buildLocalNasSummary();
          state.callLogs = result.callLogs;
          state.nasCache[cacheKey] = {
            time: Date.now(),
            nas: state.nas,
            nasSummary: state.nasSummary,
            callLogs: state.callLogs
          };
          state.loadingNas = false;
          renderFilterFacets();
          renderNas();
        })
        .withFailureHandler(error => {
          if (requestSeq !== state.nasRequestSeq) return;
          state.loadingNas = false;
          showError(error);
        })
        .getNasData(state.token, {
          createdBy: $('nasUserFilter').value,
          month: $('nasMonth').value,
          year: $('nasYear').value
        });
    }
    function getNasCacheKey() {
      return [
        $('nasUserFilter').value || '',
        $('nasMonth').value || '',
        $('nasYear').value || ''
      ].join('|');
    }

    function renderUsers() {
      const body = $('usersBody');
      const renderKey = JSON.stringify(state.users.map(user => [
        user.Username, user.Name, user.Nickname, user.Role, user.Active
      ]));
      if (body.dataset.renderKey === renderKey) return;
      body.dataset.renderKey = renderKey;
      if (!state.users.length) {
        body.innerHTML = '<tr><td colspan="6">ไม่มีข้อมูล USER</td></tr>';
        return;
      }
      body.innerHTML = state.users.map(user => `
        <tr>
          <td>${userBadge(user.Username, user.Nickname || user.Name)}</td>
          <td>${escapeHtml(user.Name || '')}</td>
          <td>${escapeHtml(user.Nickname || '')}</td>
          <td>${escapeHtml(user.Role)}</td>
          <td>${user.Active ? 'TRUE' : 'FALSE'}</td>
          <td><button class="btn btn-ghost btn-small" type="button" onclick="editUser('${escapeAttr(user.Username)}')">แก้ไข</button></td>
        </tr>
      `).join('');
    }

    function loadUsers() {
      if (state.user.role !== 'ADMIN' || state.users.length || state.loadingUsers) return;
      state.loadingUsers = true;
      google.script.run
        .withSuccessHandler(users => {
          state.users = users;
          state.loadingUsers = false;
          renderUsers();
        })
        .withFailureHandler(error => {
          state.loadingUsers = false;
          showError(error);
        })
        .listUsers(state.token);
    }

    function saveRecord(event) {
      event.preventDefault();
      if (state.savingRecord) return;
      const payload = {
        ID: $('recordId').value,
        Code96xxx: $('code96xxx').value,
        CustomerName: $('customerName').value,
        InstallDate: $('installDate').value,
        CallVerStatus: $('callVerStatus').value,
        InstallStatus: $('installStatus').value,
        CustomerPhone: $('customerPhone').value,
        Note: $('note').value,
        DashboardPeriod: getDashboardPeriodPayload()
      };
      const submissionKey = buildRecordSubmissionKey(payload);
      if (isRecentRecordSubmission(submissionKey)) {
        toast('รายการนี้เพิ่งถูกบันทึกไป กรุณารอครู่หนึ่งเพื่อลดการบันทึกซ้ำ');
        return;
      }
      const duplicateInfo = getDuplicateInfo(payload);
      updateDuplicateWarning(duplicateInfo);
      if (duplicateInfo.hasDuplicate) {
        const ok = confirm(buildDuplicateConfirmText(duplicateInfo));
        if (!ok) return;
      }

      state.recentRecordSubmissions.set(submissionKey, Date.now());
      payload.RequestId = submissionKey;
      setRecordSaving(true);
      google.script.run
        .withSuccessHandler(result => {
          setRecordSaving(false);
          upsertLocalRecord(result.record);
          state.records = filterLocalRecords(state.allRecords, getSearchFilter());
          state.nasCache = {};
          renderRecords();
          resetRecordForm();
          showView('search');
          toast('บันทึกข้อมูลเรียบร้อย');
          loadDashboard(state.dashboardPeriod);
        })
        .withFailureHandler(error => {
          state.recentRecordSubmissions.delete(submissionKey);
          setRecordSaving(false);
          showError(error);
        })
        .saveRecord(state.token, payload);
    }

    function buildRecordSubmissionKey(payload) {
      return [
        state.user && state.user.username,
        payload.ID || 'new',
        normalizeDuplicateValue(payload.Code96xxx),
        normalizeDuplicateValue(payload.CustomerName),
        normalizePhone(payload.CustomerPhone),
        payload.InstallDate || '',
        payload.CallVerStatus || '',
        payload.InstallStatus || '',
        String(payload.Note || '').trim()
      ].join('|');
    }

    function isRecentRecordSubmission(key) {
      const now = Date.now();
      for (const [savedKey, savedAt] of state.recentRecordSubmissions.entries()) {
        if (now - savedAt > 20000) state.recentRecordSubmissions.delete(savedKey);
      }
      const savedAt = state.recentRecordSubmissions.get(key);
      return Boolean(savedAt && now - savedAt <= 20000);
    }

    function setRecordSaving(isSaving) {
      state.savingRecord = isSaving;
      const button = $('saveRecordBtn');
      if (!button) return;
      button.disabled = isSaving;
      button.textContent = isSaving ? 'กำลังบันทึก...' : 'บันทึกข้อมูล';
    }

    function updateDuplicateWarning(existingInfo) {
      const payload = {
        ID: $('recordId').value,
        Code96xxx: $('code96xxx').value,
        CustomerName: $('customerName').value,
        CustomerPhone: $('customerPhone').value
      };
      const info = existingInfo || getDuplicateInfo(payload);
      const warning = $('duplicateWarning');
      ['code96xxx', 'customerName', 'customerPhone'].forEach(id => $(id).classList.remove('duplicate-input'));
      if (!info.hasDuplicate) {
        if (warning) {
          warning.style.display = 'none';
          warning.innerHTML = '';
        }
        return;
      }
      if (info.fields.code.length) $('code96xxx').classList.add('duplicate-input');
      if (info.fields.name.length) $('customerName').classList.add('duplicate-input');
      if (info.fields.phone.length) $('customerPhone').classList.add('duplicate-input');
      if (warning) {
        warning.style.display = 'block';
        warning.innerHTML = `
          <div>พบข้อมูลซ้ำ กรุณาตรวจสอบก่อนบันทึก</div>
          <ul>${duplicateMessages(info).map(message => `<li>${escapeHtml(message)}</li>`).join('')}</ul>
        `;
      }
    }

    function getDuplicateInfo(payload) {
      const excludeId = String(payload.ID || '');
      const code = normalizeDuplicateValue(payload.Code96xxx);
      const name = normalizeDuplicateValue(payload.CustomerName);
      const phone = normalizePhone(payload.CustomerPhone);
      const matches = (field, value) => value
        ? (state.duplicateIndex[field].get(value) || []).filter(record => String(record.ID || '') !== excludeId)
        : [];
      const info = {
        hasDuplicate: false,
        fields: { code: matches('code', code), name: matches('name', name), phone: matches('phone', phone) }
      };
      info.hasDuplicate = Boolean(info.fields.code.length || info.fields.name.length || info.fields.phone.length);
      return info;
    }

    function duplicateMessages(info) {
      const messages = [];
      if (info.fields.code.length) messages.push(`96xxx ซ้ำ ${info.fields.code.length} รายการ: ${duplicateRecordList(info.fields.code)}`);
      if (info.fields.name.length) messages.push(`ชื่อ-นามสกุลซ้ำ ${info.fields.name.length} รายการ: ${duplicateRecordList(info.fields.name)}`);
      if (info.fields.phone.length) messages.push(`เบอร์โทรลูกค้าซ้ำ ${info.fields.phone.length} รายการ: ${duplicateRecordList(info.fields.phone)}`);
      return messages;
    }

    function duplicateRecordList(records) {
      return records.slice(0, 5).map(record => `${record.Code96xxx || '-'} / ${record.CustomerName || '-'} / ${record.CustomerPhone || '-'}`).join(', ');
    }

    function buildDuplicateConfirmText(info) {
      return `พบข้อมูลซ้ำ:\n- ${duplicateMessages(info).join('\n- ')}\n\nยืนยันที่จะบันทึกจริงไหม?`;
    }

    function normalizeDuplicateValue(value) {
      return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
    }

    function searchRecords() {
      applySearchFilters();
    }

    function applySearchFilters() {
      state.records = filterLocalRecords(state.allRecords, getSearchFilter());
      state.recordRenderLimit = 250;
      renderRecords();
    }

    function getSearchFilter() {
      state.searchFilter.keyword = $('keywordFilter').value;
      state.searchFilter.dateFrom = $('searchDateFrom').value;
      state.searchFilter.dateTo = $('searchDateTo').value;
      state.searchFilter.month = $('searchMonth').value;
      state.searchFilter.year = $('searchYear').value;
      state.searchFilter.sort = $('searchSort').value;
      return Object.assign({}, state.searchFilter);
    }

    function resetSearchFilters() {
      state.searchFilter = {
        keyword: '', dateFrom: '', dateTo: '', month: '', year: '',
        statuses: [], callVerStatuses: [], users: [], sort: 'date-desc'
      };
      $('keywordFilter').value = '';
      $('searchDateFrom').value = '';
      $('searchDateTo').value = '';
      $('searchMonth').value = '';
      $('searchYear').value = state.searchFilter.year;
      $('searchSort').value = 'date-desc';
      renderFilterFacets();
      applySearchFilters();
    }

    function upsertLocalRecord(record) {
      if (!record || !record.ID) return;
      const existingIndex = state.allRecords.findIndex(item => item.ID === record.ID);
      if (existingIndex >= 0) {
        state.allRecords.splice(existingIndex, 1, record);
      } else {
        state.allRecords.unshift(record);
      }
      state.allRecords.sort((a, b) => String(b.UpdatedAt || b.CreatedAt).localeCompare(String(a.UpdatedAt || a.CreatedAt)));
      refreshDuplicateIndex();
    }

    function filterLocalRecords(rows, filter) {
      const keyword = String(filter && filter.keyword ? filter.keyword : '').trim().toLowerCase();
      const dateFrom = String(filter && filter.dateFrom || '');
      const dateTo = String(filter && filter.dateTo || '');
      const month = String(filter && filter.month || '');
      const year = String(filter && filter.year || '');
      const statuses = filter && filter.statuses || [];
      const callVerStatuses = filter && filter.callVerStatuses || [];
      const users = filter && filter.users || [];
      const sort = String(filter && filter.sort || 'date-desc');

      const filtered = rows
        .filter(record => !statuses.length || statuses.includes(String(record.InstallStatus || '')))
        .filter(record => !callVerStatuses.length || callVerStatuses.includes(String(record.CallVerStatus || '')))
        .filter(record => !users.length || users.includes(String(record.OwnerUsername || '')))
        .filter(record => {
          const date = String(record.InstallDate || '').slice(0, 10);
          if (dateFrom && (!date || date < dateFrom)) return false;
          if (dateTo && (!date || date > dateTo)) return false;
          if (year && (!date || date.slice(0, 4) !== year)) return false;
          if (month && (!date || String(Number(date.slice(5, 7))) !== month)) return false;
          return true;
        })
        .filter(record => {
          if (!keyword) return true;
          return [
            record.ID,
            record.OwnerUsername,
            record.Code96xxx,
            record.CustomerName,
            record.InstallDate,
            record.CallVerStatus,
            record.InstallStatus,
            record.CustomerPhone,
            record.Note
          ].join(' ').toLowerCase().includes(keyword);
        });

      const comparators = {
        'date-desc': (a, b) => String(b.InstallDate || '').localeCompare(String(a.InstallDate || '')),
        'date-asc': (a, b) => String(a.InstallDate || '').localeCompare(String(b.InstallDate || '')),
        'updated-desc': (a, b) => String(b.UpdatedAt || b.CreatedAt).localeCompare(String(a.UpdatedAt || a.CreatedAt)),
        'code-asc': (a, b) => String(a.Code96xxx || '').localeCompare(String(b.Code96xxx || ''), 'th', { numeric: true }),
        'name-asc': (a, b) => String(a.CustomerName || '').localeCompare(String(b.CustomerName || ''), 'th')
      };
      return filtered.sort(comparators[sort] || comparators['date-desc']);
    }

    function editRecord(id) {
      const record = state.records.find(item => item.ID === id) || (state.dashboard.records || []).find(item => item.ID === id);
      if (!record) return;
      $('recordId').value = record.ID;
      $('code96xxx').value = record.Code96xxx;
      $('customerName').value = record.CustomerName || '';
      $('installDate').value = record.InstallDate;
      $('callVerStatus').value = record.CallVerStatus;
      $('installStatus').value = record.InstallStatus;
      $('customerPhone').value = record.CustomerPhone;
      $('createdByDisplay').value = record.OwnerUsername;
      $('note').value = record.Note;
      $('formTitle').textContent = 'แก้ไขข้อมูล';
      updateDuplicateWarning();
      showView('form');
    }

    function removeRecord(id) {
      if (isStaff()) {
        toast('STAFF ไม่มีสิทธิ์ลบข้อมูล');
        return;
      }
      if (state.pendingDeletes.has(id)) return;
      if (!confirm('ยืนยันลบรายการนี้?')) return;
      const button = Array.from(document.querySelectorAll('[data-record-delete]'))
        .find(item => item.dataset.recordDelete === String(id));
      state.pendingDeletes.add(id);
      if (button) {
        button.disabled = true;
        button.textContent = 'กำลังลบ...';
      }
      const finish = () => {
        state.pendingDeletes.delete(id);
        if (button && button.isConnected) {
          button.disabled = false;
          button.textContent = 'ลบ';
        }
      };
      google.script.run
        .withSuccessHandler(result => {
          finish();
          removeLocalRecord(result.id || id);
          state.records = filterLocalRecords(state.allRecords, getSearchFilter());
          state.nasCache = {};
          renderRecords();
          toast('ลบข้อมูลเรียบร้อย');
          loadDashboard(state.dashboardPeriod);
        })
        .withFailureHandler(error => {
          finish();
          showError(error);
        })
        .deleteRecord(state.token, id, getDashboardPeriodPayload());
    }
    function removeLocalRecord(id) {
      state.allRecords = state.allRecords.filter(item => item.ID !== id);
      state.records = state.records.filter(item => item.ID !== id);
      refreshDuplicateIndex();
    }

    function resetRecordForm() {
      $('recordForm').reset();
      $('recordId').value = '';
      $('createdByDisplay').value = state.user ? state.user.username : '';
      $('installStatus').value = 'Scheduled';
      $('formTitle').textContent = 'คีย์ข้อมูลใหม่';
      updateDuplicateWarning();
    }

    function saveUser(event) {
      event.preventDefault();
      if (state.savingUser) return;
      const payload = {
        Username: $('userUsername').value,
        Name: $('userName').value,
        Nickname: $('userNickname').value,
        Role: $('userRole').value,
        Password: $('userPassword').value,
        Active: $('userActive').value
      };
      const button = $('userForm').querySelector('button[type="submit"]');
      state.savingUser = true;
      if (button) {
        button.disabled = true;
        button.textContent = 'กำลังบันทึก...';
      }
      const finish = () => {
        state.savingUser = false;
        if (button) {
          button.disabled = false;
          button.textContent = 'บันทึก USER';
        }
      };
      google.script.run
        .withSuccessHandler(result => {
          finish();
          state.users = result.users;
          renderUsers();
          clearUserForm();
          toast('บันทึก USER เรียบร้อย');
        })
        .withFailureHandler(error => {
          finish();
          showError(error);
        })
        .saveUser(state.token, payload);
    }
    function editUser(username) {
      const user = state.users.find(item => item.Username === username);
      if (!user) return;
      $('userUsername').value = user.Username;
      $('userName').value = user.Name || '';
      $('userNickname').value = user.Nickname || '';
      $('userRole').value = user.Role;
      $('userPassword').value = '';
      $('userActive').value = user.Active ? 'TRUE' : 'FALSE';
    }

    function clearUserForm() {
      $('userForm').reset();
      $('userActive').value = 'TRUE';
    }

    function repairSystemData() {
      if (!confirm('ต้องการตรวจ/ซ่อมข้อมูลระบบตอนนี้หรือไม่? ระบบจะไม่ลบข้อมูลเดิม')) return;
      const button = $('repairSystemBtn');
      button.disabled = true;
      button.textContent = 'กำลังตรวจ...';
      google.script.run
        .withSuccessHandler(report => {
          button.disabled = false;
          button.textContent = 'ตรวจ/ซ่อมข้อมูลระบบ';
          state.nasCache = {};
          toast(`ตรวจเสร็จ: ซ่อมประวัติโทร ${report.fixedCallLogs || 0} รายการ`);
        })
        .withFailureHandler(error => {
          button.disabled = false;
          button.textContent = 'ตรวจ/ซ่อมข้อมูลระบบ';
          showError(error);
        })
        .repairSystemData(state.token);
    }

    function exportDashboardExcel() {
      exportRowsAsExcel('dashboard', 'Dashboard', state.dashboard.records || [], dashboardExportColumns());
    }

    function exportDashboardPdf() {
      exportRowsAsPdf('Dashboard', state.dashboard.records || [], dashboardExportColumns());
    }

    function exportSearchExcel() {
      exportRowsAsExcel('search', 'Search', state.records || [], searchExportColumns());
    }

    function exportSearchPdf() {
      exportRowsAsPdf('Search', state.records || [], searchExportColumns());
    }

    function exportNasExcel() {
      exportRowsAsExcel('nas', 'NAS', filterNasRows(state.nas || []), nasExportColumns());
    }

    function exportNasPdf() {
      exportRowsAsPdf('NAS', filterNasRows(state.nas || []), nasExportColumns());
    }

    function dashboardExportColumns() {
      return [
        ['96xxx', 'Code96xxx'],
        ['ชื่อ-นามสกุล', 'CustomerName'],
        ['วันที่ติดตั้ง', 'InstallDate'],
        ['Call Ver', 'CallVerStatus'],
        ['สถานะ', 'InstallStatus'],
        ['เบอร์ลูกค้า', 'CustomerPhone'],
        ['USER', 'OwnerUsername']
      ];
    }

    function searchExportColumns() {
      return [
        ['96xxx', 'Code96xxx'],
        ['ชื่อ-นามสกุล', 'CustomerName'],
        ['วันที่ติดตั้ง', 'InstallDate'],
        ['Call Ver', 'CallVerStatus'],
        ['สถานะ', 'InstallStatus'],
        ['เบอร์ลูกค้า', 'CustomerPhone'],
        ['USER', 'OwnerUsername'],
        ['อัปเดต', row => row.UpdatedAt || row.CreatedAt]
      ];
    }

    function nasExportColumns() {
      return [
        ['96xxx', 'Code96xxx'],
        ['ชื่อ-นามสกุล', 'CustomerName'],
        ['วันที่ติดตั้ง', 'InstallDate'],
        ['เบอร์ลูกค้า', 'CustomerPhone'],
        ['USER', 'OwnerUsername'],
        ['บิล1', 'Bill1Status'],
        ['กำหนดชำระบิล1', 'Bill1DueDate'],
        ['จำนวนเงินบิล1', 'Bill1Amount'],
        ['บิล2', 'Bill2Status'],
        ['กำหนดชำระบิล2', 'Bill2DueDate'],
        ['จำนวนเงินบิล2', 'Bill2Amount'],
        ['บิล3', 'Bill3Status'],
        ['กำหนดชำระบิล3', 'Bill3DueDate'],
        ['จำนวนเงินบิล3', 'Bill3Amount'],
        ['บิล4', 'Bill4Status'],
        ['กำหนดชำระบิล4', 'Bill4DueDate'],
        ['จำนวนเงินบิล4', 'Bill4Amount'],
        ['TOTAL', row => rowBillTotal(row)],
        ['จัดเก็บไฟล์', row => row.ArchiveStatus || archiveStatus(row)]
      ];
    }

    function exportRowsAsExcel(prefix, title, rows, columns) {
      const html = buildReportTable(title, rows, columns);
      const blob = new Blob(['\ufeff', html], { type: 'application/vnd.ms-excel;charset=utf-8' });
      downloadBlob(blob, `${prefix}-${dateStamp()}.xls`);
    }

    function exportRowsAsPdf(title, rows, columns) {
      const html = `
        <!doctype html>
        <html lang="th">
        <head>
          <meta charset="utf-8">
          <title>${escapeHtml(title)}</title>
          <style>
            body { font-family: Arial, sans-serif; color: #111827; }
            h1 { font-size: 20px; margin: 0 0 12px; }
            table { width: 100%; border-collapse: collapse; font-size: 11px; }
            th, td { border: 1px solid #d1d5db; padding: 6px; text-align: left; }
            th { background: #f3f4f6; }
          </style>
        </head>
        <body>${buildReportTable(title, rows, columns)}</body>
        </html>
      `;
      const win = window.open('', '_blank');
      win.document.open();
      win.document.write(html);
      win.document.close();
      win.focus();
      setTimeout(() => win.print(), 300);
    }

    function buildReportTable(title, rows, columns) {
      const head = columns.map(([label]) => `<th>${escapeHtml(label)}</th>`).join('');
      const body = rows.length ? rows.map(row => `
        <tr>${columns.map(([, key]) => `<td>${escapeHtml(getExportValue(row, key))}</td>`).join('')}</tr>
      `).join('') : `<tr><td colspan="${columns.length}">ไม่มีข้อมูล</td></tr>`;
      return `<h1>${escapeHtml(title)}</h1><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    }

    function getExportValue(row, key) {
      if (typeof key === 'function') return key(row);
      return row[key] || '';
    }

    function downloadBlob(blob, filename) {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    }

    function dateStamp() {
      const now = new Date();
      return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    }

    function canSeeAll() {
      return ['ADMIN', 'MANAGER'].includes(state.user && state.user.role);
    }

    function isStaff() {
      return Boolean(state.user && state.user.role === 'STAFF');
    }

    function showError(error) {
      toast(error && error.message ? error.message : String(error));
    }

    function toast(message) {
      const node = $('toast');
      node.textContent = message;
      node.style.display = 'block';
      clearTimeout(window.toastTimer);
      window.toastTimer = setTimeout(() => node.style.display = 'none', 3500);
    }

    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      }[char]));
    }

    function escapeAttr(value) {
      return escapeHtml(value).replace(/`/g, '&#96;');
    }

    function normalizePhone(value) {
      return String(value || '').replace(/[^\d+]/g, '');
    }

    function buildDuplicateIndex(rows) {
      const index = { code: new Map(), name: new Map(), phone: new Map() };
      const append = (field, value, record) => {
        if (!value) return;
        const entries = index[field].get(value) || [];
        entries.push(record);
        index[field].set(value, entries);
      };
      rows.forEach(record => {
        append('code', normalizeDuplicateValue(record.Code96xxx), record);
        append('name', normalizeDuplicateValue(record.CustomerName), record);
        append('phone', normalizePhone(record.CustomerPhone), record);
      });
      return index;
    }

    function refreshDuplicateIndex() {
      state.duplicateIndex = buildDuplicateIndex(state.allRecords);
    }

    function getDuplicateFields(record, index) {
      const fields = [];
      const code = normalizeDuplicateValue(record.Code96xxx);
      const name = normalizeDuplicateValue(record.CustomerName);
      const phone = normalizePhone(record.CustomerPhone);
      const hasDuplicates = (field, value) => value && index && (index[field].get(value) || []).length > 1;
      if (hasDuplicates('code', code)) fields.push('code');
      if (hasDuplicates('name', name)) fields.push('name');
      if (hasDuplicates('phone', phone)) fields.push('phone');
      return fields;
    }

    function updateTablePagination(prefix, shown, total, label) {
      const container = $(`${prefix}Pagination`);
      const text = $(`${prefix}PaginationText`);
      if (!container || !text) return;
      const hasMore = shown < total;
      container.hidden = !hasMore;
      text.textContent = hasMore
        ? `แสดง ${shown.toLocaleString('th-TH')} จาก ${total.toLocaleString('th-TH')} ${label}`
        : '';
    }

    function userBadge(username, label) {
      const text = String(label || username || '').trim();
      const user = String(username || text || '').trim().toLowerCase();
      const color = userColor(user);
      return `<span class="user-chip" style="background:${color.bg};color:${color.fg};border-color:${color.border};" title="${escapeAttr(user)}">${escapeHtml(text || '-')}</span>`;
    }

    function userColor(username) {
      const text = String(username || 'user');
      let hash = 0;
      for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash) + text.charCodeAt(i);
      const hue = Math.abs(hash) % 360;
      return {
        bg: `hsl(${hue}, 78%, 92%)`,
        fg: `hsl(${hue}, 72%, 24%)`,
        border: `hsl(${hue}, 65%, 76%)`
      };
    }

    function formatDuration(seconds) {
      const total = Number(seconds || 0);
      if (!total) return '-';
      const minutes = Math.floor(total / 60);
      const rest = total % 60;
      return `${minutes}:${String(rest).padStart(2, '0')}`;
    }

    function getDashboardPeriodPayload() {
      return {
        mode: state.dashboardPeriod,
        month: state.dashboardMonth,
        year: state.dashboardYear,
        createdBy: $('dashboardUserFilter').value
      };
    }

    function archiveStatus(item) {
      return [1, 2, 3, 4].every(index => item[`Bill${index}Status`] === 'ชำระแล้ว') ? 'จัดเก็บไฟล์ได้' : 'รอติดตามบิล';
    }

    function archiveClass(status) {
      return status === 'จัดเก็บไฟล์ได้' ? 'archive-ready' : 'archive-wait';
    }

    function formatMoney(value) {
      return Number(value || 0).toLocaleString('th-TH', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2
      });
    }

    function buildLocalNasSummary() {
      return buildNasSummaryFromRows(state.nas);
    }

    function buildNasSummaryFromRows(rows) {
      const totalJobs = rows.length;
      const totalBills = totalJobs * 4;
      let paidBills = 0;
      let unpaidBills = 0;
      let totalAmount = 0;
      let unpaidAmount = 0;

      rows.forEach(item => {
        [1, 2, 3, 4].forEach(index => {
          const amount = Number(item[`Bill${index}Amount`] || 0);
          totalAmount += amount;
          if (item[`Bill${index}Status`] === 'ชำระแล้ว') {
            paidBills++;
          } else {
            unpaidBills++;
            unpaidAmount += amount;
          }
        });
      });

      return {
        totalJobs,
        totalBills,
        paidBills,
        unpaidBills,
        totalAmount,
        unpaidAmount,
        paidPercent: totalBills ? Math.round((paidBills / totalBills) * 100) : 0,
        unpaidPercent: totalBills ? Math.round((unpaidBills / totalBills) * 100) : 0
      };
    }
   
