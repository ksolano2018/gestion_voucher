document.addEventListener('DOMContentLoaded', () => {
  const apiUrlEl = document.getElementById('api-url');
  const apiUrl = apiUrlEl?.textContent?.trim() || 'http://localhost:8080';

  // Handle Stripe checkout result
  function handleCheckoutResult(){
    const params = new URLSearchParams(window.location.search);
    const checkoutResult = params.get('checkout');
    const purchaseId = params.get('purchase_id');
    const sessionId = params.get('session_id');
    
    if(checkoutResult === 'success' && purchaseId){
      setTimeout(() => {
        verifyPaidPurchase(purchaseId, sessionId);
      }, 500);
    } else if(checkoutResult === 'cancel' && purchaseId){
      setTimeout(() => {
        showLoginMessage(`⚠️ Pago cancelado. Puedes intentar de nuevo cuando estés listo.`, 'warning', 5000);
        // Clean URL
        window.history.replaceState({}, document.title, window.location.pathname);
      }, 500);
    }
  }

  async function verifyPaidPurchase(purchaseId, sessionId){
    const pid = getPartnerIdFromJwt();
    if(!pid){
      showLoginMessage('No se pudo validar el pago: partner no identificado', 'danger', 5000);
      return;
    }

    try {
      const baseUrl = apiUrl.replace(':8080', ':8081') + `/partner/${pid}/purchases/${purchaseId}/status` + (sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : '');
      let data = null;
      let validated = false;

      for(let attempt = 0; attempt < 8; attempt++){
        const resp = await safeFetch(baseUrl, { headers: authHeaders() });
        data = await resp.json();

        if(!resp.ok){
          showLoginMessage('No se pudo validar estado del pago. Intenta recargar.', 'warning', 5000);
          return;
        }

        if(data.is_paid){
          validated = true;
          break;
        }

        if(attempt < 7){
          await new Promise(resolve => setTimeout(resolve, 2500));
        }
      }

      if(validated){
        showLoginMessage(`✅ Pago exitoso validado. Compra #${purchaseId}. Ya puedes gestionar vouchers.`, 'success', 8000);
        saveCart([]);
        renderCartSummary();
        loadPartnerVouchers();
        loadPartnerPayments();
        loadPartnerStats(false);
      } else {
        showLoginMessage(`⏳ Pago aún no confirmado (estado: ${data && (data.stripe_status || data.status) ? (data.stripe_status || data.status) : 'pendiente'}). Si ya pagaste, espera unos segundos y recarga vouchers.`, 'warning', 9000);
      }

      window.history.replaceState({}, document.title, window.location.pathname);
    } catch (e) {
      showLoginMessage('Error validando pago: ' + e.message, 'danger', 5000);
    }
  }
  
  // Handle checkout result on page load (will be called after showLoginMessage is defined)
  const checkoutResultHandler = handleCheckoutResult;

  function el(id){ return document.getElementById(id); }
  function on(id, event, handler){ const node = el(id); if(node && node.addEventListener) node.addEventListener(event, handler); }

  function escapeHTML(str){
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  function sanitizeHTML(dirty){
    if(window.DOMPurify){
      return window.DOMPurify.sanitize(dirty, { ALLOWED_TAGS: ['b','i','em','strong','a','br','span','div'], ALLOWED_ATTR: ['href','class'] });
    }
    return escapeHTML(dirty);
  }

  function toNumber(value){
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  }

  function formatCurrency(value){
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: 'COP',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(toNumber(value));
  }

  function monthLabels(count){
    const now = new Date();
    const labels = [];
    for(let i = count - 1; i >= 0; i--){
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      labels.push({
        key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
        label: d.toLocaleString('es-ES', { month: 'short', year: '2-digit' })
      });
    }
    return labels;
  }

  function isPaymentPaid(payment){
    const status = String(payment && payment.status ? payment.status : '').toUpperCase();
    const stripe = String(payment && payment.stripe_status ? payment.stripe_status : '').toLowerCase();
    return status === 'PAID' || stripe === 'paid' || stripe === 'succeeded';
  }

  // ── Global Toast Notification System ───────────────────────────────────────
  const TOAST_ICONS = { success:'✅', danger:'❌', warning:'⚠️', info:'ℹ️' };
  function showToast(msg, type = 'info', durationMs = 3500){
    const container = document.getElementById('toast-container');
    if(!container) return;
    const item = document.createElement('div');
    item.className = `toast-item ${type}`;
    item.innerHTML = `<span class="toast-icon">${TOAST_ICONS[type]||'ℹ️'}</span>
      <span class="toast-msg">${escapeHTML(String(msg))}</span>
      <button class="toast-close" aria-label="Cerrar">✕</button>`;
    item.querySelector('.toast-close').addEventListener('click', () => dismissToast(item));
    container.appendChild(item);
    const timer = setTimeout(() => dismissToast(item), durationMs);
    item._toastTimer = timer;
  }
  function dismissToast(item){
    clearTimeout(item._toastTimer);
    item.style.opacity = '0';
    item.style.transform = 'translateX(30px)';
    setTimeout(() => item.remove(), 300);
  }
  // ───────────────────────────────────────────────────────────────────────────

  function isPaymentFailed(payment){
    const status = String(payment && payment.status ? payment.status : '').toUpperCase();
    const stripe = String(payment && payment.stripe_status ? payment.stripe_status : '').toLowerCase();
    return status === 'FAILED' || stripe === 'failed' || stripe === 'canceled';
  }

  function renderMetricBars(containerId, rows){
    const container = el(containerId);
    if(!container) return;
    if(!Array.isArray(rows) || rows.length === 0){
      container.innerHTML = '<div class="metric-note">Sin datos aún.</div>';
      return;
    }

    const maxValue = Math.max(...rows.map(r => toNumber(r.value)), 1);
    container.innerHTML = rows.map(row => {
      const value = toNumber(row.value);
      const width = Math.max(2, Math.round((value / maxValue) * 100));
      return `<div class="metric-bar-row">
        <div>
          <div class="d-flex justify-content-between"><span>${escapeHTML(row.label)}</span><span>${escapeHTML(String(row.valueLabel))}</span></div>
          <div class="metric-bar-track"><div class="metric-bar-fill" style="width:${width}%"></div></div>
        </div>
        <span class="metric-badge">${escapeHTML(String(row.badge || row.valueLabel))}</span>
      </div>`;
    }).join('');
  }

  function renderMetricList(containerId, rows, emptyLabel){
    const container = el(containerId);
    if(!container) return;
    if(!Array.isArray(rows) || rows.length === 0){
      container.innerHTML = `<li><span>${escapeHTML(emptyLabel || 'Sin datos')}</span><strong>0</strong></li>`;
      return;
    }
    container.innerHTML = rows.map(row => `<li><span>${escapeHTML(String(row.label))}</span><strong>${escapeHTML(String(row.value))}</strong></li>`).join('');
  }

  // Loading state for buttons
  // ── Confirmación genérica reutilizable ──────────────────────────────────────
  // rows: [{ label, value }]  — value puede ser string, número o HTML seguro
  // alert: texto de advertencia opcional (fondo amarillo sobre la tabla)
  function showConfirmAction({ title, icon = '⚠️', rows = [], alert = '', confirmLabel = 'Confirmar', confirmClass = 'btn-primary', onConfirm }) {
    const modal = document.getElementById('modal-generic-confirm');
    if (!modal) { onConfirm(); return; }

    const titleEl = document.getElementById('generic-confirm-title');
    const iconEl  = document.getElementById('generic-confirm-icon');
    const bodyEl  = document.getElementById('generic-confirm-body');
    const alertEl = document.getElementById('generic-confirm-alert');

    if (titleEl) titleEl.textContent = title;
    if (iconEl)  iconEl.textContent  = icon;

    if (alertEl) {
      alertEl.textContent = alert;
      alertEl.style.display = alert ? '' : 'none';
    }

    if (bodyEl) {
      bodyEl.innerHTML = rows.length
        ? `<table class="table table-sm table-borderless mb-0">
            <tbody>
              ${rows.map(r => `<tr>
                <td class="text-muted pe-3" style="white-space:nowrap;width:40%;font-size:.875rem;">${escapeHTML(String(r.label || ''))}</td>
                <td class="fw-semibold" style="font-size:.875rem;">${escapeHTML(String(r.value !== undefined && r.value !== null && r.value !== '' ? r.value : '—'))}</td>
              </tr>`).join('')}
            </tbody>
          </table>`
        : '';
    }

    // Reemplazar botón para limpiar listeners anteriores
    const oldBtn = document.getElementById('generic-confirm-btn');
    if (oldBtn) {
      const newBtn = oldBtn.cloneNode(false);
      newBtn.textContent = confirmLabel;
      newBtn.className = `btn ${confirmClass}`;
      oldBtn.replaceWith(newBtn);
      newBtn.addEventListener('click', () => {
        bootstrap.Modal.getInstance(modal).hide();
        onConfirm();
      });
    }

    bootstrap.Modal.getOrCreateInstance(modal).show();
  }
  // ────────────────────────────────────────────────────────────────────────────

  function setButtonLoading(btn, loading) {
    if (!btn) return;
    if (loading) {
      btn.dataset.originalText = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>' + btn.textContent;
      btn.style.opacity = '0.7';
    } else {
      btn.disabled = false;
      btn.innerHTML = btn.dataset.originalText || btn.textContent;
      btn.style.opacity = '1';
      delete btn.dataset.originalText;
    }
  }

  const navAdmin = el('nav-admin');
  const navPartner = el('nav-partner');
  const navCart = el('nav-cart');
  const logoutBtn = el('logout-btn');
  const userInfoDisplay = el('user-info-display');
  const userDropdownWrap = el('user-dropdown-wrap');
  const userDropdownTrigger = el('user-dropdown-trigger');

  // User dropdown toggle
  if(userDropdownTrigger){
    userDropdownTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      userDropdownWrap.classList.toggle('open');
    });
  }
  document.addEventListener('click', () => {
    if(userDropdownWrap) userDropdownWrap.classList.remove('open');
  });

  const sAdmin = el('admin');
  const sPartner = el('partner');
  const sCartSummary = el('cart-summary');

  function show(section){
    if(!section) return;
    if(sAdmin) sAdmin.style.display = 'none';
    if(sPartner) sPartner.style.display = 'none';
    if(sCartSummary) sCartSummary.style.display = 'none';
    
    // Remove active class from all nav buttons
    document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
    
    section.style.display = 'block';
    // Trigger animation
    setTimeout(() => {
      section.classList.add('fade-in');
    }, 10);
  }

  if(navAdmin) navAdmin.style.display = 'none';
  if(navPartner) navPartner.style.display = 'none';
  if(userDropdownWrap) userDropdownWrap.style.display = 'none';

  if(navAdmin) navAdmin.onclick = () => {
    show(sAdmin);
    navAdmin.classList.add('active');

    // Al abrir Administración desde la barra superior, re-dispara la sección activa
    // para que cargue datos (ej. Usuarios) sin depender de clic manual en "Actualizar".
    const activeAdminCard = document.querySelector('.admin-menu-item.active');
    if(activeAdminCard){
      activeAdminCard.click();
      return;
    }

    const dashboardCard = document.querySelector('.admin-menu-item[data-target="admin-dashboard"]');
    if(dashboardCard){
      dashboardCard.click();
      return;
    }

    loadAdminDashboard();
  };
  if(navPartner) navPartner.onclick = () => { show(sPartner); navPartner.classList.add('active'); refreshVoucherPricingPreview(); };
  if(navCart) navCart.onclick = () => { show(sCartSummary); navCart.classList.add('active'); };
  on('user-dropdown-go-stats', 'click', () => {
    const t = getToken();
    const d = t ? decodeJwt(t) : null;
    if(userDropdownWrap) userDropdownWrap.classList.remove('open');
    if(!d) return;

    if(d.role === 'partner'){
      show(sPartner);
      if(navPartner) navPartner.classList.add('active');
      const statsCard = document.querySelector('.partner-menu-item[data-target="partner-stats"]');
      if(statsCard){
        statsCard.click();
      } else {
        loadPartnerStats(false);
      }
      return;
    }

    show(sAdmin);
    if(navAdmin) navAdmin.classList.add('active');
    const adminStatsCard = document.querySelector('.admin-menu-item[data-target="admin-stats"]');
    if(adminStatsCard && adminStatsCard.style.display !== 'none'){
      adminStatsCard.click();
    } else {
      loadAdminDashboard();
    }
  });
  function showLoginMessage(msg, type='info', timeout=3500){
    const loginMessageEl = el('login-message');
    if(!loginMessageEl) return;
    const cls = type === 'success' ? 'alert-success' : (type === 'danger' ? 'alert-danger' : 'alert-info');
    const safeMsg = sanitizeHTML(msg);
    loginMessageEl.innerHTML = `<div class="alert ${cls} p-2" role="alert">${safeMsg}</div>`;
    if(timeout > 0) setTimeout(() => { if(loginMessageEl) loginMessageEl.innerHTML = ''; }, timeout);
  }

  function showAdminUserMessage(msg, type='info'){
    const messageEl = el('admin-user-message');
    if(!messageEl) return;
    const cls = type === 'success' ? 'alert-success' : (type === 'danger' ? 'alert-danger' : 'alert-info');
    messageEl.innerHTML = `<div class="alert ${cls} mb-3" role="alert">${sanitizeHTML(msg)}</div>`;
  }

  function clearAdminUserMessage(){
    const messageEl = el('admin-user-message');
    if(messageEl) messageEl.innerHTML = '';
  }

  function showInlineAlert(containerId, msg, type = 'info'){
    const node = el(containerId);
    if(!node) return;
    const cls = type === 'success' ? 'alert-success' : (type === 'danger' ? 'alert-danger' : 'alert-info');
    node.innerHTML = `<div class="alert ${cls} mb-3" role="alert">${sanitizeHTML(msg)}</div>`;
  }

  function clearInlineAlert(containerId){
    const node = el(containerId);
    if(node) node.innerHTML = '';
  }

  function getToken(){ return localStorage.getItem('access_token'); }
  function setToken(t){
    if(t){
      localStorage.setItem('access_token', t);
      if(userDropdownWrap) userDropdownWrap.style.display = 'block';
      showAppScreen();
      showUser();
    } else {
      localStorage.removeItem('access_token');
      if(userDropdownWrap) userDropdownWrap.style.display = 'none';
      showLoginScreen();
    }
  }

  function decodeJwt(token){
    try{
      const p = token.split('.')[1];
      return JSON.parse(atob(p.replace(/-/g,'+').replace(/_/g,'/')));
    }catch(e){
      return null;
    }
  }

  function showUser(){
    const t = getToken();
    if(!t){
      if(userDropdownWrap) userDropdownWrap.style.display = 'none';
      return;
    }
    const d = decodeJwt(t);
    if(d){
      const label = d.role === 'admin' ? 'Admin' : (d.role === 'partner' ? 'Partner' : 'User');
      const emailVal = escapeHTML(d.sub || d.email || 'usuario');
      const nameVal = escapeHTML(d.first_name || d.name || label);
      if(userInfoDisplay) userInfoDisplay.textContent = `${nameVal}`;
      const dropName = el('user-dropdown-name');
      const dropEmail = el('user-dropdown-email');
      if(dropName) dropName.textContent = `${label}: ${nameVal}`;
      if(dropEmail) dropEmail.textContent = emailVal;
      if(userDropdownWrap) userDropdownWrap.style.display = 'block';
    }
  }

  function updateNavByRole(){
    const t = getToken();
    if(!t){
      if(navAdmin) navAdmin.style.display = 'none';
      if(navPartner) navPartner.style.display = 'none';
      if(navCart) navCart.style.display = 'none';
      return;
    }
    const d = decodeJwt(t);
    if(d && d.role){
      const isClientRole = d.role_type === 'client_role';
      const hasPermissions = d.permissions && Object.values(d.permissions).some(v => v && v !== 'none');
      const isAdmin = d.role === 'admin';
      // Roles cliente nunca acceden a Administración, sin importar permisos
      const showAdmin = !isClientRole && (isAdmin || hasPermissions);
      if(navAdmin) navAdmin.style.display = showAdmin ? 'inline-block' : 'none';
      if(navPartner) navPartner.style.display = (d.role === 'partner') ? 'inline-block' : 'none';
      if(navCart) navCart.style.display = (d.role === 'partner') ? 'inline-block' : 'none';

      // Mostrar/ocultar tarjetas del menú admin según permisos
      if(!isAdmin){
        document.querySelectorAll('.admin-menu-item').forEach(card => {
          const target = card.dataset.target;
          const mod = target ? target.replace('admin-', '') : null;
          if(mod && mod !== 'dashboard'){
            const level = (d.permissions || {})[mod];
            card.style.display = (level && level !== 'none') ? '' : 'none';
          }
        });
      } else {
        document.querySelectorAll('.admin-menu-item').forEach(card => card.style.display = '');
      }
    }
  }

  // ── Permisos granulares (leídos del JWT) ──
  let _userPermissions = {};

  function loadUserPermissions() {
    const t = getToken();
    if (!t) { _userPermissions = {}; return; }
    const d = decodeJwt(t);
    _userPermissions = (d && d.permissions) || {};
  }

  function canView(module)  { return ['view','edit'].includes(_userPermissions[module]); }
  function canEdit(module)  { return _userPermissions[module] === 'edit'; }

  function updateFinancialOpsButtons() {
    const showEdit = canEdit('financial_ops');
    const extBtn  = el('admin-purchase-external-btn');
    const compBtn = el('admin-complimentary-btn');
    if (extBtn)  extBtn.style.display  = showEdit ? '' : 'none';
    if (compBtn) compBtn.style.display = showEdit ? '' : 'none';
  }

  const loginContainer = el('login-container');
  const appShellWrapper = el('app-shell-wrapper');
  const firstLoginPasswordSection = el('first-login-password-section');
  const firstLoginUsernameInput = el('first-login-username');

  function showFirstLoginPasswordChange(username){
    if(firstLoginUsernameInput) firstLoginUsernameInput.value = username || '';
    if(firstLoginPasswordSection) firstLoginPasswordSection.style.display = 'block';
  }

  function hideFirstLoginPasswordChange(){
    if(firstLoginPasswordSection) firstLoginPasswordSection.style.display = 'none';
    if(el('first-login-current-password')) el('first-login-current-password').value = '';
    if(el('first-login-new-password')) el('first-login-new-password').value = '';
    if(el('first-login-confirm-password')) el('first-login-confirm-password').value = '';
  }

  function showLoginScreen(){
    document.documentElement.classList.add('no-session');
    if(loginContainer) loginContainer.style.display = 'flex';
    if(appShellWrapper) appShellWrapper.style.display = 'none';
    document.body.classList.remove('authenticated');
    hideFirstLoginPasswordChange();
  }

  function showAppScreen(){
    document.documentElement.classList.remove('no-session');
    if(loginContainer) loginContainer.style.display = 'none';
    if(appShellWrapper) appShellWrapper.style.display = 'block';
    document.body.classList.add('authenticated');
    loadUserPermissions();
    updateNavByRole();
    updateFinancialOpsButtons();
  }

  function authHeaders(){
    const t = getToken();
    return t ? { 'Content-Type':'application/json', 'Authorization': 'Bearer ' + t } : { 'Content-Type':'application/json' };
  }

  let isRefreshing = false;
  let refreshSubscribers = [];

  function subscribeTokenRefresh(cb) {
    refreshSubscribers.push(cb);
  }

  function onTokenRefreshed(newToken) {
    refreshSubscribers.forEach(cb => cb(newToken));
    refreshSubscribers = [];
  }

  async function refreshAccessToken(){
    if(isRefreshing){
      return new Promise((resolve) => {
        subscribeTokenRefresh((newToken) => {
          resolve(newToken);
        });
      });
    }

    isRefreshing = true;
    try {
      const baseApi = apiUrl.replace(':8080', ':8081');
      const resp = await fetch(baseApi + '/oauth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ grant_type: 'refresh_token' })
      });

      const data = await resp.json();
      isRefreshing = false;

      if(resp.ok && data.access_token){
        setToken(data.access_token);
        onTokenRefreshed(data.access_token);
        return data.access_token;
      } else {
        setToken(null);
        showLoginMessage('Sesión expirada. Por favor, inicia sesión de nuevo.', 'warning', 4000);
        return null;
      }
    } catch(e) {
      isRefreshing = false;
      setToken(null);
      showLoginMessage('Error al renovar sesión. Por favor, inicia sesión de nuevo.', 'danger', 4000);
      return null;
    }
  }

  async function safeFetch(url, options = {}){
    const mergedOptions = { cache: 'no-store', ...options };
    let response = await fetch(url, mergedOptions);

    if(response.status === 401){
      const newToken = await refreshAccessToken();
      if(newToken){
        const newOptions = {
          ...mergedOptions,
          headers: {
            ...mergedOptions.headers,
            'Authorization': 'Bearer ' + newToken
          }
        };
        response = await fetch(url, newOptions);
      }
    }

    return response;
  }

  async function safeJson(resp){
    const text = await resp.text();
    try { return JSON.parse(text); }
    catch(e) { throw new Error('Respuesta inesperada del servidor. Verifica que el servicio esté activo.'); }
  }

  // Login handler
  document.addEventListener('click', async (ev) => {
    if(ev.target.id !== 'login-btn') return;
    const loginBtn = ev.target;
    try{
      const username = (el('login-username') || {}).value || '';
      const password = (el('login-password') || {}).value || '';
      if(!username || !password){
        showLoginMessage('Completa usuario y contrasena', 'danger', 3000);
        return;
      }
      setButtonLoading(loginBtn, true);
      const url = apiUrl.replace(':8080', ':8081') + '/oauth/token';
      const resp = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ grant_type:'password', username, password }) });
      const data = await resp.json();
      setButtonLoading(loginBtn, false);
      if(resp.ok && data.must_change_password){
        showFirstLoginPasswordChange(username);
        showLoginMessage('Debes cambiar tu contraseña temporal para continuar.', 'warning', 6000);
        return;
      }
      if(resp.ok && data.access_token){
        setToken(data.access_token);
        const d = decodeJwt(data.access_token) || {};
        if(d.role === 'admin'){
          show(sAdmin);
          // Activar tarjeta dashboard y cargar datos
          document.querySelectorAll('.admin-menu-item').forEach(c => c.classList.remove('active'));
          const dashCard = document.querySelector('.admin-menu-item[data-target="admin-dashboard"]');
          if(dashCard) dashCard.classList.add('active');
          document.querySelectorAll('#admin .content-section').forEach(s => s.classList.remove('active'));
          const dashSection = el('admin-dashboard');
          if(dashSection) dashSection.classList.add('active');
          loadAdminDashboard();
        } else if(d.role === 'partner'){
          show(sPartner);
          loadPartnerStats(false);
          loadCoursesForActivation();
          loadActivationEligibility();
          loadPartnerPayments();
          refreshVoucherPricingPreview();
        }
        showLoginMessage('Bienvenido', 'success', 2000);
      } else {
        showLoginMessage('Login fallido: ' + (data.error || 'Credenciales invalidas'), 'danger', 4000);
      }
    }catch(e){
      setButtonLoading(loginBtn, false);
      showLoginMessage('Error: ' + (e && e.message ? e.message : e), 'danger', 4000);
    }
  });

  on('first-login-change-password-btn', 'click', async () => {
    const btn = el('first-login-change-password-btn');
    const username = (firstLoginUsernameInput || {}).value || (el('login-username') || {}).value || '';
    const currentPassword = (el('first-login-current-password') || {}).value || '';
    const newPassword = (el('first-login-new-password') || {}).value || '';
    const confirmPassword = (el('first-login-confirm-password') || {}).value || '';

    if(!username || !currentPassword || !newPassword || !confirmPassword){
      showLoginMessage('Completa todos los campos para cambiar contraseña', 'danger', 4000);
      return;
    }

    if(newPassword !== confirmPassword){
      showLoginMessage('La nueva contraseña y su confirmación no coinciden', 'danger', 4000);
      return;
    }

    try{
      setButtonLoading(btn, true);
      const resp = await fetch(apiUrl.replace(':8080', ':8081') + '/oauth/change-password-first', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          current_password: currentPassword,
          new_password: newPassword
        })
      });

      const data = await resp.json();
      setButtonLoading(btn, false);

      if(resp.ok){
        hideFirstLoginPasswordChange();
        if(el('login-password')) el('login-password').value = '';
        showLoginMessage('Contraseña actualizada. Inicia sesión con tu nueva contraseña.', 'success', 5000);
      } else {
        showLoginMessage('Error: ' + (data.error || 'No se pudo cambiar la contraseña'), 'danger', 5000);
      }
    }catch(e){
      setButtonLoading(btn, false);
      showLoginMessage('Error: ' + e.message, 'danger', 5000);
    }
  });

  if(logoutBtn) logoutBtn.addEventListener('click', () => { setToken(null); if(userDropdownWrap) userDropdownWrap.classList.remove('open'); });

  // Users sub-navigation
  document.addEventListener('click', (e) => {
    const usersTab = e.target.closest('.users-tab');
    if(usersTab){
      const viewId = usersTab.dataset.view;
      document.querySelectorAll('.users-tab').forEach(t => t.classList.remove('active'));
      usersTab.classList.add('active');
      document.querySelectorAll('.users-view').forEach(v => v.classList.remove('active'));
      const viewEl = el(viewId);
      if(viewEl) viewEl.classList.add('active');
      if(viewId === 'users-roles-view'){
        loadAdminRoles(true).then(() => renderRolesList()).catch((err) => {
          const container = el('roles-list-container');
          if(container) container.innerHTML = `<div class="alert alert-danger mb-0">No se pudieron cargar roles: ${escapeHTML(err.message || 'error desconocido')} <button id="roles-retry-btn" class="btn btn-sm btn-outline-danger ms-2">Reintentar</button></div>`;
          const retryBtn = el('roles-retry-btn');
          if(retryBtn) retryBtn.addEventListener('click', () => {
            loadAdminRoles(true).then(() => renderRolesList()).catch(()=>{});
          });
        });
      }
      if(viewId === 'users-policy-view'){ loadPasswordPolicy(); loadAdminActivationSettings(); }
    }
  });

  // Admin menu
  document.addEventListener('click', (e) => {
    const adminCard = e.target.closest('.admin-menu-item');
    if(adminCard){
      const target = adminCard.dataset.target;
      document.querySelectorAll('.admin-menu-item').forEach(item => item.classList.remove('active'));
      adminCard.classList.add('active');
      document.querySelectorAll('#admin .content-section').forEach(section => section.classList.remove('active'));
      const targetEl = el(target);
      if(targetEl) targetEl.classList.add('active');

      // Auto-load content on section change
      if(target === 'admin-dashboard'){
        loadAdminDashboard();
      }
      if(target === 'admin-purchases'){
        loadAdminPurchases();
      }
      if(target === 'admin-stats'){
        loadPartnersSelect();
      }
      if(target === 'admin-pricing'){
        loadAdminPricingData();
      }
      if(target === 'admin-courses'){
        loadAdminCourses();
      }
      if(target === 'admin-users'){
        loadAdminRoles(true).then(() => { const lb = el('list-users'); if(lb) lb.click(); }).catch(()=>{});
      }
      if(target === 'admin-audit'){
        loadAuditPartnerFilter();
        loadAdminAuditMovements(1);
      }
      if(target === 'admin-reports'){
        loadAdminReports();
      }
      if(target === 'admin-activaciones'){
        loadAdminActivaciones(1);
        loadAdminActivacionesFilterOptions();
      }
    }
    const partnerCard = e.target.closest('.partner-menu-item');
    if(partnerCard){
      const target = partnerCard.dataset.target;
      document.querySelectorAll('.partner-menu-item').forEach(item => item.classList.remove('active'));
      partnerCard.classList.add('active');
      document.querySelectorAll('#partner .content-section').forEach(section => section.classList.remove('active'));
      const targetEl = el(target);
      if(targetEl){ targetEl.classList.add('active'); targetEl.style.display = ''; }
      if(target === 'partner-stats'){
        loadPartnerStats(false);
      }
      if(target === 'partner-vouchers'){
        loadPartnerVouchers();
        loadPartnerPayments();
        refreshVoucherPricingPreview();
      }
      if(target === 'partner-activate'){
        loadCoursesForActivation();
        loadActivationEligibility();
        loadFinalClientsForSelect();
        loadActivationMonthsSelect();
      }
      if(target === 'partner-clients'){
        loadPartnerFinalClients();
      }
    }
  });

  // Cart
  function loadCart(){
    try{ return JSON.parse(localStorage.getItem('cart') || '[]'); }catch(e){ return []; }
  }
  function saveCart(c){ localStorage.setItem('cart', JSON.stringify(c)); updateCartCount(); }
  function updateCartCount(){
    const c = loadCart();
    const count = c.reduce((sum, i) => sum + (i.qty || 0), 0);
    const badge = el('cart-count');
    if(badge) badge.textContent = count;
  }

  function addToCart(item){
    const cart = loadCart();
    const idx = cart.findIndex(i => i.id === item.id);
    const qtyToAdd = item.qty ? parseInt(item.qty, 10) : 1;
    if(idx === -1){
      cart.push({ ...item, qty: qtyToAdd });
    } else {
      cart[idx].qty = (cart[idx].qty || 0) + qtyToAdd;
    }
    saveCart(cart);
    renderCartSummary();
    
    // Animate cart badge
    const badge = el('cart-count');
    if(badge) {
      badge.style.transform = 'scale(1.5)';
      setTimeout(() => { badge.style.transform = 'scale(1)'; }, 300);
    }
  }

  function removeFromCart(itemId){
    let cart = loadCart();
    cart = cart.filter(i => i.id !== itemId);
    saveCart(cart);
    renderCartSummary();
  }

  function changeQty(itemId, qty){
    const cart = loadCart();
    const idx = cart.findIndex(i => i.id === itemId);
    if(idx !== -1){
      cart[idx].qty = qty;
      if(cart[idx].qty <= 0) cart.splice(idx, 1);
      saveCart(cart);
      renderCartSummary();
      refreshVoucherPricingPreview();
    }
  }

  async function fetchPartnerPricingPreview(qty){
    const pid = getPartnerIdFromJwt();
    if(!pid) return null;
    const resp = await safeFetch(apiUrl.replace(':8080', ':8081') + `/partner/${pid}/pricing-preview?qty=${encodeURIComponent(qty)}`, {
      headers: authHeaders()
    });
    const data = await resp.json();
    if(!resp.ok) throw new Error(data.error || 'No se pudo calcular el precio');
    return data;
  }

  async function refreshVoucherPricingPreview(){
    const qtyInput = el('voucher-qty');
    const previewEl = el('partner-pricing-preview');
    const cartNoteEl = el('cart-pricing-note');
    const cart = loadCart();
    const cartVoucher = cart.find(item => item.id === 'voucher-certjoin');
    const qty = cartVoucher ? parseInt(cartVoucher.qty || 1, 10) : Math.max(1, parseInt((qtyInput && qtyInput.value) || '1', 10));

    if(previewEl) previewEl.textContent = 'Calculando total...';
    if(cartNoteEl) cartNoteEl.textContent = 'Calculando precio aplicado...';

    try {
      const pricing = await fetchPartnerPricingPreview(qty);
      if(previewEl){
        const sourceBadge = pricing.pricing_source === 'SPECIAL'
          ? '<span class="badge bg-warning text-dark ms-2" style="font-size:0.7rem;">Precio especial</span>'
          : '<span class="badge bg-secondary ms-2" style="font-size:0.7rem;">Categoría base</span>';
        previewEl.innerHTML = `Total: $${parseFloat(pricing.total_price || 0).toFixed(2)}${sourceBadge}`;
      }
      if(cartNoteEl){
        cartNoteEl.textContent = pricing.cumulative_message || pricing.breakdown_message || '';
      }

      if(cartVoucher){
        const updatedCart = loadCart().map(item => item.id === 'voucher-certjoin'
          ? { ...item, price: pricing.unit_price, pricing_breakdown: pricing.breakdown_message }
          : item
        );
        saveCart(updatedCart);
        const totalEl = el('cart-total');
        if(totalEl) totalEl.textContent = `$${parseFloat(pricing.total_price || 0).toFixed(2)}`;
      }
    } catch (e) {
      if(previewEl) previewEl.textContent = 'No se pudo calcular el precio actual.';
      if(cartNoteEl) cartNoteEl.textContent = 'No se pudo calcular el precio aplicado.';
    }
  }

  function renderCartSummary(){
    const container = el('cart-items-container');
    const cart = loadCart();
    if(!container) return;
    if(!cart || cart.length === 0){
      container.innerHTML = '<div class="text-muted">Tu carrito esta vacio</div>';
      const totalEl = el('cart-total');
      if(totalEl) totalEl.textContent = '$0.00';
      if(el('cart-pricing-note')) el('cart-pricing-note').textContent = '';
      updateCartCount();
      return;
    }
    container.innerHTML = cart.map(it => {
      const safeTitle = escapeHTML(it.title || 'Producto');
      const safePrice = parseFloat(it.price || 0).toFixed(2);
      const safeQty = parseInt(it.qty || 1, 10);
      const safeId = escapeHTML(String(it.id || ''));
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:.4rem .2rem;border-bottom:1px solid #f1f1f1;">
        <div style="flex:1"><div style="font-weight:600">${safeTitle}</div><div class="small-muted">$${safePrice}</div></div>
        <div style="display:flex;gap:.5rem;align-items:center">
          <input type="number" min="1" value="${safeQty}" data-id="${safeId}" class="cart-qty form-control form-control-sm" style="width:70px;" />
          <button class="btn btn-sm btn-outline-danger cart-remove" data-id="${safeId}">Eliminar</button>
        </div>
      </div>`;
    }).join('');

    const total = cart.reduce((s, i) => s + (parseFloat(i.price) || 0) * (i.qty || 0), 0);
    const totalEl = el('cart-total');
    if(totalEl) totalEl.textContent = `$${total.toFixed(2)}`;

    document.querySelectorAll('.cart-remove').forEach(btn => {
      btn.addEventListener('click', () => removeFromCart(btn.dataset.id));
    });
    document.querySelectorAll('.cart-qty').forEach(input => {
      input.addEventListener('change', () => changeQty(input.dataset.id, parseInt(input.value || '1', 10)));
    });

    refreshVoucherPricingPreview();
  }

  on('buy-voucher-btn', 'click', () => {
    const qtyInput = el('voucher-qty');
    const qty = Math.max(1, parseInt((qtyInput && qtyInput.value) || '1', 10));
    addToCart({
      id: 'voucher-certjoin',
      title: 'Voucher CertJOIN',
      price: 0,
      qty
    });
    show(sCartSummary);
    if(navCart) navCart.classList.add('active');
    showLoginMessage('Voucher agregado al carrito', 'success', 2000);
  });

  on('voucher-qty', 'change', () => refreshVoucherPricingPreview());

  on('cart-clear', 'click', () => { saveCart([]); renderCartSummary(); });
  on('cart-checkout', 'click', async () => {
    const btn = el('cart-checkout');
    const cart = loadCart();
    if(!cart || cart.length === 0){
      showLoginMessage('El carrito esta vacio', 'warning', 3000);
      return;
    }
    
    const pid = getPartnerIdFromJwt();
    if(!pid){
      showLoginMessage('No se pudo obtener Partner ID', 'danger', 3000);
      return;
    }
    
    try{
      setButtonLoading(btn, true);
      const qty = cart.reduce((sum, item) => sum + (item.qty || 0), 0);
      
      const payload = {
        qty: qty,
        descriptor: 'Compra de cursos desde carrito',
        payment_method: 'card'
      };
      
      // Usar endpoint de Stripe checkout
      const resp = await safeFetch(apiUrl.replace(':8080', ':8081') + `/partner/${pid}/checkout`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(payload)
      });
      
      const data = await resp.json();
      setButtonLoading(btn, false);
      
      if(resp.ok && data.url){
        showLoginMessage('Redirigiendo a Stripe...', 'success', 2000);
        // Redirigir a Stripe Checkout
        setTimeout(() => {
          window.location.href = data.url;
        }, 1000);
      } else {
        showLoginMessage('Error: ' + (data.error || 'No se pudo procesar'), 'danger', 3000);
      }
    }catch(e){
      setButtonLoading(btn, false);
      showLoginMessage('Error: ' + e.message, 'danger', 3000);
    }
  });

  // Admin actions
  const pricingState = {
    profiles: [],
    partners: []
  };

  function buildPartnerOptions(partners, includePlaceholder = true){
    const options = [];
    if(includePlaceholder) options.push('<option value="">-- Selecciona un partner --</option>');
    return options.concat((partners || []).map(p => `<option value="${p.id}">${escapeHTML(p.name)} (ID: ${p.id})</option>`)).join('');
  }

  async function fetchAdminPartners(){
    const resp = await safeFetch(apiUrl.replace(':8080', ':8081') + '/admin/partners?page=1&limit=1000', {
      headers: authHeaders()
    });
    const result = await resp.json();
    if(!resp.ok) throw new Error(result.error || 'No se pudieron cargar partners');
    return Array.isArray(result.data) ? result.data : [];
  }
  
  let _adminPartnersCache = [];
  let _partnerReportData = null;
  let _adminReportData   = null;

  async function loadPartnersSelect(autoLoadGlobal = true) {
    const selectEl = el('admin-select-partner-id');
    if(!selectEl) return;

    try{
      selectEl.innerHTML = '<option value="">Cargando...</option>';

      const partners = await fetchAdminPartners();
      _adminPartnersCache = partners;
      const globalOption = '<option value="global">🌐 Vista global (todos los partners)</option>';
      const partnerOptions = partners.length
        ? buildPartnerOptions(partners)
        : '<option value="">No hay partners disponibles</option>';
      selectEl.innerHTML = globalOption + partnerOptions;
      if(autoLoadGlobal){
        selectEl.value = 'global';
        await loadAdminStatsByCriterion('global', false);
      }
    }catch(e){
      const globalOption = '<option value="global">🌐 Vista global (todos los partners)</option>';
      selectEl.innerHTML = globalOption + '<option value="">Error al cargar partners</option>';
      if(autoLoadGlobal){
        selectEl.value = 'global';
        await loadAdminStatsByCriterion('global', false);
      }
    }
  }

  function populatePricingPartnerSelect(){
    const selectEl = el('pricing-partner-select');
    if(!selectEl) return;
    if(!pricingState.partners || pricingState.partners.length === 0){
      selectEl.innerHTML = '<option value="">No hay partners disponibles</option>';
      return;
    }
    selectEl.innerHTML = buildPartnerOptions(pricingState.partners);
  }

  function populatePricingProfileSelectors(){
    const profiles = Array.isArray(pricingState.profiles) ? pricingState.profiles : [];
    const specials = profiles.filter(profile => profile.profile_type === 'SPECIAL');

    const specialSelect = el('partner-special-profile-select');
    if(specialSelect){
      specialSelect.innerHTML = '<option value="">Sin perfil especial</option>' +
        specials.map(profile => `<option value="${profile.id}">${escapeHTML(profile.name)}</option>`).join('');
    }

    const editorSelect = el('pricing-profile-editor-select');
    if(editorSelect){
      const specialOpts = specials.map(p => `<option value="${p.id}">${escapeHTML(p.name)}</option>`).join('');
      editorSelect.innerHTML = specials.length
        ? '<option value="">Selecciona un perfil especial</option>' + specialOpts
        : '<option value="">Sin perfiles especiales</option>';
    }
  }

  function renderPricingRulesEditor(rules){
    const tbody = el('pricing-rules-body');
    if(!tbody) return;
    const rows = Array.isArray(rules) && rules.length > 0 ? rules : [{ min_qty: 1, max_qty: '', unit_price: '' }];
    tbody.innerHTML = rows.map(rule => `
      <tr>
        <td><input type="number" min="1" class="form-control pricing-rule-min" value="${escapeHTML(String(rule.min_qty ?? 1))}"></td>
        <td><input type="number" min="1" class="form-control pricing-rule-max" value="${rule.max_qty === null || rule.max_qty === undefined ? '' : escapeHTML(String(rule.max_qty))}" placeholder="Sin límite"></td>
        <td><input type="number" min="0.01" step="0.01" class="form-control pricing-rule-price" value="${escapeHTML(String(rule.unit_price ?? ''))}"></td>
        <td><button type="button" class="btn btn-sm btn-outline-danger remove-pricing-rule">Eliminar</button></td>
      </tr>
    `).join('');

    tbody.querySelectorAll('.remove-pricing-rule').forEach(btn => {
      btn.addEventListener('click', () => {
        const row = btn.closest('tr');
        if(row && tbody.children.length > 1) row.remove();
      });
    });
  }

  function getPricingRulesFromEditor(){
    return Array.from(document.querySelectorAll('#pricing-rules-body tr')).map(row => ({
      min_qty: parseInt(row.querySelector('.pricing-rule-min').value || '0', 10),
      max_qty: row.querySelector('.pricing-rule-max').value === '' ? null : parseInt(row.querySelector('.pricing-rule-max').value || '0', 10),
      unit_price: parseFloat(row.querySelector('.pricing-rule-price').value || '0')
    }));
  }

  function loadPricingProfileIntoEditor(profileId){
    const profile = pricingState.profiles.find(item => String(item.id) === String(profileId));
    if(!profile) return;
    if(el('pricing-profile-name'))        el('pricing-profile-name').value        = profile.name        || '';
    if(el('pricing-profile-description')) el('pricing-profile-description').value = profile.description || '';
    renderPricingRulesEditor(profile.rules || []);
  }

  function renderBasePricingRulesEditor(rules){
    const tbody = el('pricing-base-rules-body');
    if(!tbody) return;
    const rows = Array.isArray(rules) && rules.length > 0 ? rules : [{ min_qty: 1, max_qty: '', unit_price: '' }];
    tbody.innerHTML = rows.map(rule => `
      <tr>
        <td><input type="number" min="1" class="form-control base-rule-min" value="${escapeHTML(String(rule.min_qty ?? 1))}"></td>
        <td><input type="number" min="1" class="form-control base-rule-max" value="${rule.max_qty === null || rule.max_qty === undefined ? '' : escapeHTML(String(rule.max_qty))}" placeholder="Sin límite"></td>
        <td><input type="number" min="0.01" step="0.01" class="form-control base-rule-price" value="${escapeHTML(String(rule.unit_price ?? ''))}"></td>
        <td><button type="button" class="btn btn-sm btn-outline-danger remove-base-rule">Eliminar</button></td>
      </tr>
    `).join('');
    tbody.querySelectorAll('.remove-base-rule').forEach(btn => {
      btn.addEventListener('click', () => {
        const row = btn.closest('tr');
        if(row && tbody.children.length > 1) row.remove();
      });
    });
  }

  function getBasePricingRulesFromEditor(){
    return Array.from(document.querySelectorAll('#pricing-base-rules-body tr')).map(row => ({
      min_qty:    parseInt(row.querySelector('.base-rule-min').value   || '0',   10),
      max_qty:    row.querySelector('.base-rule-max').value === '' ? null : parseInt(row.querySelector('.base-rule-max').value || '0', 10),
      unit_price: parseFloat(row.querySelector('.base-rule-price').value || '0')
    }));
  }

  function loadBasePricingProfileIntoEditor(profileId){
    const profile = pricingState.profiles.find(item => String(item.id) === String(profileId));
    if(!profile) return;
    if(el('pricing-base-profile-name'))        el('pricing-base-profile-name').value        = profile.name        || '';
    if(el('pricing-base-profile-description')) el('pricing-base-profile-description').value = profile.description || '';
    renderBasePricingRulesEditor(profile.rules || []);
  }

  async function fetchPricingProfiles(){
    const resp = await safeFetch(apiUrl.replace(':8080', ':8081') + '/admin/pricing/profiles', { headers: authHeaders() });
    const data = await resp.json();
    if(!resp.ok) throw new Error(data.error || 'No se pudieron cargar perfiles de pricing');
    return Array.isArray(data) ? data : [];
  }

  async function loadPartnerPricingConfig(){
    const partnerId = (el('pricing-partner-select') || {}).value;
    if(!partnerId){
      showInlineAlert('partner-pricing-message', 'Selecciona un partner para cargar su pricing.', 'info');
      return;
    }

    try {
      clearInlineAlert('partner-pricing-message');
      const resp = await safeFetch(apiUrl.replace(':8080', ':8081') + `/admin/partners/${partnerId}/pricing`, { headers: authHeaders() });
      const data = await resp.json();
      if(!resp.ok) throw new Error(data.error || 'No se pudo cargar configuración del partner');

      if(el('partner-special-profile-select')) el('partner-special-profile-select').value = data.partner.special_pricing_profile_id || '';

      const baseName = data.partner.pricing_profile_name || 'Base';
      const specialName = data.partner.special_pricing_profile_name || 'Sin perfil especial';
      if(el('partner-pricing-summary')){
        el('partner-pricing-summary').innerHTML = `
          <div class="alert alert-light border mb-0">
            <div><strong>Categoría base:</strong> ${escapeHTML(baseName)}</div>
            <div><strong>Perfil especial:</strong> ${escapeHTML(specialName)}</div>
          </div>`;
      }
    } catch (e) {
      showInlineAlert('partner-pricing-message', `Error: ${escapeHTML(e.message)}`, 'danger');
    }
  }

  async function loadAdminPricingData(){
    try {
      const [profiles, partners] = await Promise.all([
        fetchPricingProfiles(),
        fetchAdminPartners()
      ]);
      pricingState.profiles = profiles;
      pricingState.partners = partners;
      populatePricingProfileSelectors();
      populatePricingPartnerSelect();

      const specials    = pricingState.profiles.filter(p => p.profile_type === 'SPECIAL');
      const categories  = pricingState.profiles.filter(p => p.profile_type === 'CATEGORY');

      // Auto-cargar la única categoría base
      if(categories.length > 0){
        loadBasePricingProfileIntoEditor(categories[0].id);
      }

      // Auto-seleccionar primer perfil especial
      const selectedProfile = (el('pricing-profile-editor-select') || {}).value;
      if(selectedProfile){
        loadPricingProfileIntoEditor(selectedProfile);
      } else if(specials.length > 0 && el('pricing-profile-editor-select')){
        el('pricing-profile-editor-select').value = specials[0].id;
        loadPricingProfileIntoEditor(specials[0].id);
      }
    } catch (e) {
      showInlineAlert('pricing-profile-message', `Error: ${escapeHTML(e.message)}`, 'danger');
    }
  }

  on('add-pricing-base-rule-row', 'click', () => {
    const tbody = el('pricing-base-rules-body');
    if(!tbody) return;
    const row = document.createElement('tr');
    row.innerHTML = `
      <td><input type="number" min="1" class="form-control base-rule-min" value="1"></td>
      <td><input type="number" min="1" class="form-control base-rule-max" placeholder="Sin límite"></td>
      <td><input type="number" min="0.01" step="0.01" class="form-control base-rule-price"></td>
      <td><button type="button" class="btn btn-sm btn-outline-danger remove-base-rule">Eliminar</button></td>
    `;
    row.querySelector('.remove-base-rule').addEventListener('click', () => {
      if(tbody.children.length > 1) row.remove();
    });
    tbody.appendChild(row);
  });

  on('save-pricing-base-profile', 'click', async () => {
    const baseProfile = (pricingState.profiles || []).find(p => p.profile_type === 'CATEGORY');
    if(!baseProfile){
      showInlineAlert('pricing-base-message', 'No se encontró la categoría base.', 'danger');
      return;
    }
    const profileId   = baseProfile.id;
    const profileName = (el('pricing-base-profile-name') || {}).value || baseProfile.name;
    const rules       = getBasePricingRulesFromEditor();
    try {
      const resp = await safeFetch(
        apiUrl.replace(':8080', ':8081') + '/admin/pricing/profiles/' + encodeURIComponent(profileId),
        {
          method: 'PUT', headers: authHeaders(),
          body: JSON.stringify({
            name: profileName,
            description: (el('pricing-base-profile-description') || {}).value || '',
            rules
          })
        }
      );
      const data = await resp.json();
      if(!resp.ok) throw new Error(data.error || 'No se pudo guardar la categoría base');
      showToast('Reglas de categoría base guardadas correctamente', 'success');
      showInlineAlert('pricing-base-message', 'Reglas guardadas correctamente.', 'success');
      await loadAdminPricingData();
    } catch(e) { showInlineAlert('pricing-base-message', `Error: ${escapeHTML(e.message)}`, 'danger'); }
  });

  on('pricing-profile-editor-select', 'change', (event) => {
    clearInlineAlert('pricing-profile-message');
    loadPricingProfileIntoEditor(event.target.value);
  });

  on('add-pricing-rule-row', 'click', () => {
    const tbody = el('pricing-rules-body');
    if(!tbody) return;
    const row = document.createElement('tr');
    row.innerHTML = `
      <td><input type="number" min="1" class="form-control pricing-rule-min" value="1"></td>
      <td><input type="number" min="1" class="form-control pricing-rule-max" value="" placeholder="Sin límite"></td>
      <td><input type="number" min="0.01" step="0.01" class="form-control pricing-rule-price" value=""></td>
      <td><button type="button" class="btn btn-sm btn-outline-danger remove-pricing-rule">Eliminar</button></td>
    `;
    tbody.appendChild(row);
    row.querySelector('.remove-pricing-rule').addEventListener('click', () => {
      if(tbody.children.length > 1) row.remove();
    });
  });

  on('create-special-profile', 'click', async () => {
    const name        = (el('special-profile-name')        || {}).value || '';
    const description = (el('special-profile-description') || {}).value || '';

    try {
      const resp = await safeFetch(apiUrl.replace(':8080', ':8081') + '/admin/pricing/profiles', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ name, description, profile_type: 'SPECIAL' })
      });
      const data = await resp.json();
      if(!resp.ok) throw new Error(data.error || 'No se pudo crear el perfil especial');

      showToast('Perfil especial creado correctamente', 'success');
      showInlineAlert('special-profile-message', 'Perfil especial creado correctamente.', 'success');
      if(el('special-profile-name'))        el('special-profile-name').value = '';
      if(el('special-profile-description')) el('special-profile-description').value = '';
      await loadAdminPricingData();
      if(el('pricing-profile-editor-select')) {
        el('pricing-profile-editor-select').value = data.id;
        loadPricingProfileIntoEditor(data.id);
      }
    } catch (e) {
      showInlineAlert('special-profile-message', `Error: ${escapeHTML(e.message)}`, 'danger');
    }
  });

  on('save-pricing-profile', 'click', async () => {
    const profileId   = (el('pricing-profile-editor-select') || {}).value;
    const profileName = (el('pricing-profile-name') || {}).value || '';
    const rules       = getPricingRulesFromEditor();
    if(!profileId){
      showInlineAlert('pricing-profile-message', 'Selecciona un perfil para editar.', 'danger');
      return;
    }
    showConfirmAction({
      title: 'Guardar Perfil de Precios', icon: '🏷️',
      rows: [
        { label: 'Perfil:', value: profileName },
        { label: 'Tramos configurados:', value: rules.length },
        { label: 'Rango de precios:', value: rules.length ? `$${Math.min(...rules.map(r=>r.unit_price)).toFixed(2)} – $${Math.max(...rules.map(r=>r.unit_price)).toFixed(2)}` : '—' }
      ],
      confirmLabel: '💾 Guardar Perfil', confirmClass: 'btn-primary',
      onConfirm: async () => {
        try {
          const resp = await safeFetch(apiUrl.replace(':8080', ':8081') + `/admin/pricing/profiles/${profileId}`, {
            method: 'PUT', headers: authHeaders(),
            body: JSON.stringify({
              name: profileName,
              description: (el('pricing-profile-description') || {}).value || '',
              rules
            })
          });
          const data = await resp.json();
          if(!resp.ok) throw new Error(data.error || 'No se pudo guardar el perfil');
          showToast('Reglas de pricing guardadas correctamente', 'success');
          showInlineAlert('pricing-profile-message', 'Reglas guardadas correctamente.', 'success');
          await loadAdminPricingData();
          if(el('pricing-profile-editor-select')) { el('pricing-profile-editor-select').value = profileId; loadPricingProfileIntoEditor(profileId); }
        } catch (e) { showInlineAlert('pricing-profile-message', `Error: ${escapeHTML(e.message)}`, 'danger'); }
      }
    });
  });

  on('load-partner-pricing-config', 'click', () => loadPartnerPricingConfig());
  on('pricing-partner-select', 'change', () => {
    clearInlineAlert('partner-pricing-message');
    if((el('pricing-partner-select') || {}).value) loadPartnerPricingConfig();
  });

  on('save-partner-pricing', 'click', async () => {
    const partnerSel   = el('pricing-partner-select');
    const partnerId    = (partnerSel || {}).value;
    const partnerName  = partnerSel ? (partnerSel.options[partnerSel.selectedIndex] || {}).text || partnerId : partnerId;
    const baseProfile  = (pricingState.profiles || []).find(p => p.profile_type === 'CATEGORY');
    const pricingProfileId = baseProfile ? baseProfile.id : null;
    const specSel      = el('partner-special-profile-select');
    const specialPricingProfileId = (specSel || {}).value;
    const specName     = specSel && specialPricingProfileId ? (specSel.options[specSel.selectedIndex] || {}).text || specialPricingProfileId : 'Sin perfil especial';

    if(!partnerId || !pricingProfileId){
      showInlineAlert('partner-pricing-message', 'No se pudo determinar el partner o la categoría base.', 'danger');
      return;
    }
    showConfirmAction({
      title: 'Actualizar Pricing del Partner', icon: '💰',
      rows: [
        { label: 'Partner:', value: partnerName },
        { label: 'Categoría base:', value: 'Base' },
        { label: 'Perfil especial:', value: specName }
      ],
      confirmLabel: '💾 Guardar Pricing', confirmClass: 'btn-primary',
      onConfirm: async () => {
        try {
          const resp = await safeFetch(apiUrl.replace(':8080', ':8081') + `/admin/partners/${partnerId}/pricing`, {
            method: 'PUT', headers: authHeaders(),
            body: JSON.stringify({
              pricing_profile_id: parseInt(pricingProfileId, 10),
              special_pricing_profile_id: specialPricingProfileId ? parseInt(specialPricingProfileId, 10) : null
            })
          });
          const data = await resp.json();
          if(!resp.ok) throw new Error(data.error || 'No se pudo guardar el pricing del partner');
          showToast('Pricing del partner actualizado correctamente', 'success');
          showInlineAlert('partner-pricing-message', 'Pricing del partner actualizado correctamente.', 'success');
          await loadAdminPricingData();
          if(el('pricing-partner-select')) el('pricing-partner-select').value = partnerId;
          if(el('partner-special-profile-select')) el('partner-special-profile-select').value = data.special_pricing_profile_id || '';
          await loadPartnerPricingConfig();
        } catch (e) { showInlineAlert('partner-pricing-message', `Error: ${escapeHTML(e.message)}`, 'danger'); }
      }
    });
  });

  // ---- Admin Courses CRUD ----
  let _adminCourses = [];
  let _pendingCourseCrudAction = null;

  function resetAdminCourseForm(){
    if(el('admin-course-edit-id')) el('admin-course-edit-id').value = '';
    if(el('admin-course-name')) el('admin-course-name').value = '';
    if(el('admin-course-cancel')) el('admin-course-cancel').style.display = 'none';
    if(el('admin-course-save')) el('admin-course-save').innerHTML = '💾 Guardar';
  }

  function setAdminCoursesMessage(msg, type){
    const node = el('admin-courses-message');
    if(!node) return;
    if(!msg){
      node.innerHTML = '';
      return;
    }
    const cls = type === 'success' ? 'alert-success' : (type === 'danger' ? 'alert-danger' : 'alert-info');
    node.innerHTML = `<div class="alert ${cls} mb-3">${sanitizeHTML(msg)}</div>`;
  }

  function renderAdminCoursesTable(){
    const tbody = el('admin-courses-tbody');
    if(!tbody) return;

    if(!_adminCourses.length){
      tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted p-3">No hay certificaciones registradas</td></tr>';
      return;
    }

    tbody.innerHTML = _adminCourses.map(course => {
      const createdAt  = course.created_at  ? new Date(course.created_at).toLocaleDateString('es-ES')  : '-';
      const updatedAt  = course.updated_at  ? new Date(course.updated_at).toLocaleDateString('es-ES')  : '-';
      const isActive = course.active !== false;
      const statusBadge = isActive
        ? '<span class="badge bg-success">Habilitado</span>'
        : '<span class="badge bg-secondary">Deshabilitado</span>';
      return `<tr>
        <td>${escapeHTML(String(course.id))}</td>
        <td>${escapeHTML(course.name || '')}</td>
        <td>${statusBadge}</td>
        <td>${escapeHTML(createdAt)}</td>
        <td>${escapeHTML(updatedAt)}</td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('.admin-course-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const course = _adminCourses.find(c => String(c.id) === String(btn.dataset.id));
        if(!course) return;
        if(el('admin-course-edit-id')) el('admin-course-edit-id').value = String(course.id);
        if(el('admin-course-name')) el('admin-course-name').value = course.name || '';
        if(el('admin-course-cancel')) el('admin-course-cancel').style.display = '';
        if(el('admin-course-save')) el('admin-course-save').innerHTML = '💾 Guardar cambios';
        setAdminCoursesMessage('Modo edición activado. Modifica el nombre y guarda.', 'info');
      });
    });

    tbody.querySelectorAll('.admin-course-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const course = _adminCourses.find(c => String(c.id) === String(btn.dataset.id));
        if(!course) return;
        _pendingCourseCrudAction = { type: 'delete', id: course.id, name: course.name };
        if(el('confirm-course-crud-text')){
          el('confirm-course-crud-text').innerHTML = `¿Confirmas eliminar la certificación <strong>${escapeHTML(course.name || '')}</strong>?`;
        }
        if(el('btn-confirm-course-crud')) el('btn-confirm-course-crud').className = 'btn btn-danger';
        bootstrap.Modal.getOrCreateInstance(document.getElementById('confirmCourseCrudModal')).show();
      });
    });

    tbody.querySelectorAll('.admin-course-toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const course = _adminCourses.find(c => String(c.id) === String(btn.dataset.id));
        if(!course) return;
        const nextActive = course.active === false;
        _pendingCourseCrudAction = { type: 'toggle', id: course.id, active: nextActive, name: course.name };
        if(el('confirm-course-crud-text')){
          el('confirm-course-crud-text').innerHTML = nextActive
            ? `¿Confirmas habilitar la certificación <strong>${escapeHTML(course.name || '')}</strong>?`
            : `¿Confirmas deshabilitar la certificación <strong>${escapeHTML(course.name || '')}</strong>?`;
        }
        if(el('btn-confirm-course-crud')) el('btn-confirm-course-crud').className = 'btn btn-primary';
        bootstrap.Modal.getOrCreateInstance(document.getElementById('confirmCourseCrudModal')).show();
      });
    });
  }

  async function loadAdminCourses(){
    const btn = el('admin-courses-refresh');
    try {
      if(btn) setButtonLoading(btn, true);
      const resp = await safeFetch(apiUrl.replace(':8080', ':8081') + '/admin/courses', { headers: authHeaders() });
      const data = await safeJson(resp);
      if(!resp.ok) throw new Error(data.error || 'No se pudieron cargar certificaciones');
      _adminCourses = Array.isArray(data) ? data : [];
      renderAdminCoursesTable();
      setAdminCoursesMessage('', 'info');
    } catch (e) {
      setAdminCoursesMessage('Error al cargar certificaciones: ' + escapeHTML(e.message), 'danger');
    } finally {
      if(btn) setButtonLoading(btn, false);
    }
  }

  on('admin-courses-refresh', 'click', () => loadAdminCourses());

  // ── Sincronización desde Moodle ──────────────────────────────────────────────
  on('admin-moodle-sync-courses-btn', 'click', async () => {
    const panel = el('admin-moodle-sync-panel');
    const badge = el('admin-moodle-connection-badge');
    const resultsEl = el('admin-moodle-sync-results');
    const previewList = el('admin-moodle-preview-list');
    if (panel) panel.style.display = '';
    if (previewList) previewList.innerHTML = '';
    if (resultsEl) resultsEl.innerHTML = '';
    if (badge) { badge.textContent = 'Verificando...'; badge.className = 'badge bg-secondary ms-2'; }

    try {
      const base = apiUrl.replace(':8080', ':8081');
      const resp = await safeFetch(`${base}/admin/moodle/test-connection`, { headers: authHeaders() });
      const data = await resp.json();
      if (resp.ok && data.ok) {
        const label = data.mock ? '🟡 Modo Mock' : `🟢 Conectado — ${escapeHTML(data.sitename || '')}`;
        if (badge) { badge.textContent = label; badge.className = data.mock ? 'badge bg-warning text-dark ms-2' : 'badge bg-success ms-2'; }
        if (resultsEl) resultsEl.innerHTML = data.mock
          ? '<div class="text-warning small">⚠️ MOODLE_MOCK=true — los datos mostrados son ficticios. Para conectar al Moodle real, configura MOODLE_URL, MOODLE_TOKEN y MOODLE_MOCK=false en el .env.</div>'
          : `<div class="text-success small">✅ Conectado a <strong>${escapeHTML(data.sitename)}</strong> como <strong>${escapeHTML(data.username)}</strong></div>`;
      } else {
        if (badge) { badge.textContent = '🔴 Sin conexión'; badge.className = 'badge bg-danger ms-2'; }
        if (resultsEl) resultsEl.innerHTML = `<div class="text-danger small">❌ ${escapeHTML(data.error || 'No se pudo conectar a Moodle')}<br><span class="text-muted">Verifica MOODLE_URL y MOODLE_TOKEN en el .env del servidor.</span></div>`;
      }
    } catch(e) {
      if (badge) { badge.textContent = '🔴 Error'; badge.className = 'badge bg-danger ms-2'; }
      if (resultsEl) resultsEl.innerHTML = `<div class="text-danger small">❌ ${escapeHTML(e.message)}</div>`;
    }
  });

  on('admin-moodle-preview-btn', 'click', async () => {
    const previewList = el('admin-moodle-preview-list');
    if (!previewList) return;
    previewList.innerHTML = '<div class="text-muted small">Cargando certificaciones desde Moodle...</div>';
    try {
      const base = apiUrl.replace(':8080', ':8081');
      const resp = await safeFetch(`${base}/admin/moodle/courses`, { headers: authHeaders() });
      const data = await resp.json();
      if (!resp.ok) { previewList.innerHTML = `<div class="text-danger small">❌ ${escapeHTML(data.error || 'Error')}</div>`; return; }
      if (!data.courses.length) { previewList.innerHTML = '<div class="text-muted small">No se encontraron certificaciones en Moodle.</div>'; return; }
      previewList.innerHTML = `
        <div class="small fw-semibold mb-2">${data.total} certificaciones encontradas en Moodle:</div>
        <div class="table-responsive">
          <table class="table table-sm table-bordered mb-0">
            <thead class="table-light"><tr><th>ID Moodle</th><th>Nombre completo</th><th>Shortname</th></tr></thead>
            <tbody>
              ${data.courses.map(c => `<tr>
                <td><code>${escapeHTML(String(c.id))}</code></td>
                <td>${escapeHTML(c.fullname)}</td>
                <td><span class="text-muted">${escapeHTML(c.shortname)}</span></td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>`;
    } catch(e) {
      previewList.innerHTML = `<div class="text-danger small">❌ ${escapeHTML(e.message)}</div>`;
    }
  });

  on('admin-moodle-do-sync-btn', 'click', async () => {
    const previewList = el('admin-moodle-preview-list');
    showConfirmAction({
      title: 'Importar certificaciones desde Moodle', icon: '⬇️',
      rows: [
        { label: 'Acción:', value: 'Crear o actualizar certificaciones' },
        { label: 'Criterio:', value: 'Solo certificaciones visibles en Moodle' },
        { label: 'Existentes:', value: 'Se actualiza el nombre si cambió' }
      ],
      confirmLabel: '⬇ Importar', confirmClass: 'btn-success',
      onConfirm: async () => {
        try {
          const base = apiUrl.replace(':8080', ':8081');
          const resp = await safeFetch(`${base}/admin/moodle/sync-courses`, { method: 'POST', headers: authHeaders() });
          const data = await resp.json();
          if (!resp.ok) { showToast(`❌ ${data.error || 'Error al sincronizar'}`, 'danger'); return; }
          showToast(`✅ Sync completado — ${data.created.length} nuevas, ${data.updated.length} actualizadas, ${(data.deactivated||[]).length} desactivadas`, 'success', 5000);
          if (previewList) {
            const deactHtml = (data.deactivated||[]).length
              ? `<hr class="my-2"><strong>⚠️ Desactivadas (ya no existen en Moodle):</strong> ${data.deactivated.map(c => escapeHTML(c.name)).join(', ')}`
              : '';
            previewList.innerHTML = `
              <div class="alert alert-success mb-0 small">
                <strong>✅ Sincronización completada</strong><br>
                📥 Nuevas: <strong>${data.created.length}</strong> &nbsp;
                🔄 Actualizadas: <strong>${data.updated.length}</strong> &nbsp;
                🔴 Desactivadas: <strong>${(data.deactivated||[]).length}</strong> &nbsp;
                ⏭ Sin cambios: <strong>${data.skipped.length}</strong>
                ${data.created.length ? '<hr class="my-2"><strong>Nuevas:</strong> ' + data.created.map(c => escapeHTML(c.name)).join(', ') : ''}
                ${deactHtml}
              </div>`;
          }
          loadAdminCourses();
        } catch(e) {
          showToast(`❌ ${e.message}`, 'danger');
        }
      }
    });
  });
  // ────────────────────────────────────────────────────────────────────────────

  on('admin-course-cancel', 'click', () => {
    resetAdminCourseForm();
    setAdminCoursesMessage('', 'info');
  });

  on('admin-course-save', 'click', () => {
    const id = ((el('admin-course-edit-id') || {}).value || '').trim();
    const name = ((el('admin-course-name') || {}).value || '').trim();

    if(!name){
      setAdminCoursesMessage('Debes ingresar el nombre de la certificación.', 'danger');
      return;
    }

    if(id){
      _pendingCourseCrudAction = { type: 'update', id: parseInt(id, 10), name };
      if(el('confirm-course-crud-text')){
        el('confirm-course-crud-text').innerHTML = `¿Confirmas actualizar la certificación a <strong>${escapeHTML(name)}</strong>?`;
      }
    } else {
      _pendingCourseCrudAction = { type: 'create', name };
      if(el('confirm-course-crud-text')){
        el('confirm-course-crud-text').innerHTML = `¿Confirmas crear la certificación <strong>${escapeHTML(name)}</strong>?`;
      }
    }

    if(el('btn-confirm-course-crud')) el('btn-confirm-course-crud').className = 'btn btn-primary';
    bootstrap.Modal.getOrCreateInstance(document.getElementById('confirmCourseCrudModal')).show();
  });

  on('btn-confirm-course-crud', 'click', async () => {
    const btn = el('btn-confirm-course-crud');
    if(!_pendingCourseCrudAction) return;

    try {
      setButtonLoading(btn, true);
      const base = apiUrl.replace(':8080', ':8081') + '/admin/courses';
      let resp = null;

      if(_pendingCourseCrudAction.type === 'create'){
        resp = await safeFetch(base, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ name: _pendingCourseCrudAction.name })
        });
      }

      if(_pendingCourseCrudAction.type === 'update'){
        resp = await safeFetch(base + `/${_pendingCourseCrudAction.id}`, {
          method: 'PUT',
          headers: authHeaders(),
          body: JSON.stringify({ name: _pendingCourseCrudAction.name })
        });
      }

      if(_pendingCourseCrudAction.type === 'delete'){
        resp = await safeFetch(base + `/${_pendingCourseCrudAction.id}`, {
          method: 'DELETE',
          headers: authHeaders()
        });
      }

      if(_pendingCourseCrudAction.type === 'toggle'){
        resp = await safeFetch(base + `/${_pendingCourseCrudAction.id}/status`, {
          method: 'PATCH',
          headers: authHeaders(),
          body: JSON.stringify({ active: _pendingCourseCrudAction.active })
        });
      }

      const data = await safeJson(resp);
      if(!resp.ok) throw new Error(data.error || 'No se pudo completar la operación');

      bootstrap.Modal.getInstance(document.getElementById('confirmCourseCrudModal')).hide();

      if(_pendingCourseCrudAction.type === 'create') showToast('Certificación creada correctamente', 'success');
      if(_pendingCourseCrudAction.type === 'update') showToast('Certificación actualizada correctamente', 'success');
      if(_pendingCourseCrudAction.type === 'delete') showToast('Certificación eliminada correctamente', 'success');
      if(_pendingCourseCrudAction.type === 'toggle') showToast(_pendingCourseCrudAction.active ? 'Certificación habilitada correctamente' : 'Certificación deshabilitada correctamente', 'success');

      resetAdminCourseForm();
      await loadAdminCourses();
    } catch (e) {
      setAdminCoursesMessage('Error: ' + escapeHTML(e.message), 'danger');
    } finally {
      _pendingCourseCrudAction = null;
      setButtonLoading(btn, false);
    }
  });
  
  

  function paymentMethodBadge(method) {
    switch ((method || '').toLowerCase()) {
      case 'stripe':        return '<span class="badge bg-primary">💳 Stripe</span>';
      case 'bank_transfer': return '<span class="badge bg-success">🏦 Transferencia</span>';
      case 'cash':          return '<span class="badge bg-warning text-dark">💵 Efectivo</span>';
      case 'invoice':       return '<span class="badge bg-secondary">📄 Factura</span>';
      case 'complimentary': return '<span class="badge" style="background:#fd7e14;color:#fff;">🎁 Cortesía</span>';
      default:              return `<span class="badge bg-light text-dark">${escapeHTML(method || '—')}</span>`;
    }
  }

  // ---- Admin Purchases con filtros ----
  let allPurchasesData = [];
  let currentPurchasesDisplayData = [];
  let currentPurchasesPage = 1;
  const PURCHASES_PAGE_SIZE = 10;

  function renderPurchasesRows(data, page) {
    currentPurchasesDisplayData = Array.isArray(data) ? data : [];
    currentPurchasesPage = page || 1;
    const tbody = el('purchases-table-body');
    if (!tbody) return;
    if (currentPurchasesDisplayData.length === 0) {
      tbody.innerHTML = '<tr><td colspan="10" class="text-center text-muted p-4">No hay compras para los filtros seleccionados</td></tr>';
      renderPurchasesPagination();
      return;
    }
    const start = (currentPurchasesPage - 1) * PURCHASES_PAGE_SIZE;
    const pageData = currentPurchasesDisplayData.slice(start, start + PURCHASES_PAGE_SIZE);
    const canAdjust = canEdit('financial_ops');
    tbody.innerHTML = pageData.map(p => {
      const stripeStatus = (p.stripe_status || '').toLowerCase();
      const purchaseStatus = (p.status || '').toUpperCase();
      const isPaid = purchaseStatus === 'PAID' || stripeStatus === 'paid' || stripeStatus === 'succeeded';
      const isFailed = purchaseStatus === 'FAILED' || stripeStatus === 'failed' || stripeStatus === 'canceled';
      const statusBadge = isPaid
        ? '<span class="badge bg-success">✓ Pagado</span>'
        : (isFailed
          ? '<span class="badge bg-danger">✗ Fallido</span>'
          : '<span class="badge bg-warning text-dark">⏳ Pendiente</span>');
      const created = p.created_at ? new Date(p.created_at).toLocaleDateString('es-ES') : '-';
      const paymentId = p.payment_intent_id ? escapeHTML(p.payment_intent_id.substring(0, 22) + '...') : '-';
      const method =(p.payment_method || 'stripe');
      const isComp = method === 'complimentary';
      const isAdjustable = method !== 'stripe';
      const adjustBtn = (canAdjust && isAdjustable)
        ? `<button class="btn btn-outline-secondary btn-xs py-0 px-1" onclick="openAdjustPurchaseModal(${p.id})">✏️ Ajustar</button>`
        : '';

      // For complimentary: show issuer + reason under the badge
      const compDetailHtml = isComp
        ? `<div class="small mt-1" style="white-space:normal;line-height:1.3;">
             ${p.complimentary_issued_by_name ? `<span class="text-muted">Por: <strong>${escapeHTML(p.complimentary_issued_by_name)}</strong></span><br>` : ''}
             ${p.complimentary_reason ? `<span class="text-muted fst-italic">"${escapeHTML(p.complimentary_reason)}"</span>` : ''}
           </div>`
        : (p.external_reference ? `<div class="small text-muted mt-1">Ref: ${escapeHTML(p.external_reference)}</div>` : '');

      const totalHtml = isComp
        ? '<span class="text-success">$0.00</span>'
        : `<strong>$${parseFloat(p.total_price || 0).toFixed(2)}</strong>`;

      return `<tr>
        <td><strong>${escapeHTML(String(p.id))}</strong></td>
        <td>${escapeHTML(p.partner_name || 'Partner ' + p.partner_id)}<br><small class="text-muted">${escapeHTML(p.partner_email || '')}</small></td>
        <td class="text-center">${escapeHTML(String(p.qty))}</td>
        <td>${totalHtml}</td>
        <td>${statusBadge}</td>
        <td title="${escapeHTML(p.payment_intent_id || 'Sin pago')}"><small class="text-muted">${paymentId}</small></td>
        <td>${created}</td>
        <td><small class="text-muted">${escapeHTML(p.status || '—')}</small></td>
        <td>${paymentMethodBadge(method)}${compDetailHtml}</td>
        <td>${adjustBtn}</td>
      </tr>`;
    }).join('');
    renderPurchasesPagination();
  }

  function renderPurchasesPagination() {
    const container = el('purchases-pagination');
    if (!container) return;
    const total = currentPurchasesDisplayData.length;
    const totalPages = Math.ceil(total / PURCHASES_PAGE_SIZE);
    if (totalPages <= 1) { container.innerHTML = ''; return; }
    let html = '<nav aria-label="Páginas de compras"><ul class="pagination pagination-sm justify-content-center mb-0">';
    html += `<li class="page-item ${currentPurchasesPage === 1 ? 'disabled' : ''}"><a class="page-link" href="#" data-purchases-page="${currentPurchasesPage - 1}">«</a></li>`;
    for (let i = 1; i <= totalPages; i++) {
      html += `<li class="page-item ${i === currentPurchasesPage ? 'active' : ''}"><a class="page-link" href="#" data-purchases-page="${i}">${i}</a></li>`;
    }
    html += `<li class="page-item ${currentPurchasesPage === totalPages ? 'disabled' : ''}"><a class="page-link" href="#" data-purchases-page="${currentPurchasesPage + 1}">»</a></li>`;
    html += '</ul></nav>';
    container.innerHTML = html;
    container.querySelectorAll('[data-purchases-page]').forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        const p = parseInt(a.dataset.purchasesPage);
        if (p >= 1 && p <= totalPages) renderPurchasesRows(currentPurchasesDisplayData, p);
      });
    });
  }

  function applyPurchasesFilter() {
    const partnerId = (el('pf-partner')   || {}).value || '';
    const status    = (el('pf-status')    || {}).value || '';
    const dateFrom  = (el('pf-date-from') || {}).value || '';
    const dateTo    = (el('pf-date-to')   || {}).value || '';
    const method    = (el('pf-method')    || {}).value || '';

    let filtered = allPurchasesData.filter(p => {
      if (partnerId && String(p.partner_id) !== partnerId) return false;

      if (status) {
        const ss = (p.stripe_status || '').toLowerCase();
        const ps = (p.status || '').toUpperCase();
        const isPaid   = ps === 'PAID'   || ss === 'paid'   || ss === 'succeeded';
        const isFailed = ps === 'FAILED' || ss === 'failed' || ss === 'canceled';
        if (status === 'paid'    && !isPaid)            return false;
        if (status === 'failed'  && !isFailed)          return false;
        if (status === 'pending' && (isPaid || isFailed)) return false;
      }

      if (method) {
        const pm = (p.payment_method || 'stripe').toLowerCase();
        if (pm !== method) return false;
      }

      if (dateFrom || dateTo) {
        const created = p.created_at ? new Date(p.created_at) : null;
        if (!created) return false;
        const createdDay = created.toISOString().slice(0, 10);
        if (dateFrom && createdDay < dateFrom) return false;
        if (dateTo   && createdDay > dateTo)   return false;
      }

      return true;
    });

    renderPurchasesRows(filtered);

    const summary = el('pf-summary');
    if (summary) {
      const hasFilter = partnerId || status || dateFrom || dateTo || method;
      if (hasFilter) {
        summary.textContent = `Mostrando ${filtered.length} de ${allPurchasesData.length} compras`;
        summary.style.display = 'block';
      } else {
        summary.style.display = 'none';
      }
    }
  }

  async function loadAuditPartnerFilter(){
    const sel = el('audit-filter-partner-id');
    if(!sel || sel.options.length > 1) return; // ya poblado
    try {
      const partners = await fetchAdminPartners();
      const opts = ['<option value="">Todos</option>'];
      partners.forEach(p => {
        opts.push(`<option value="${p.id}">${escapeHTML(p.name || 'Partner ' + p.id)}</option>`);
      });
      sel.innerHTML = opts.join('');
    } catch(e) {
      // silencioso: el select queda con "Todos"
    }
  }

  let _adminAuditRows = [];
  let _adminAuditPage = 1;
  let _adminAuditPages = 1;

  function getAdminAuditFilters(){
    const source = ((el('audit-filter-source') || {}).value || '').trim();
    const status = ((el('audit-filter-status') || {}).value || '').trim();
    const partnerId = ((el('audit-filter-partner-id') || {}).value || '').trim();
    const purchaseId = ((el('audit-filter-purchase-id') || {}).value || '').trim();
    const startDate = ((el('audit-filter-start-date') || {}).value || '').trim();
    const endDate = ((el('audit-filter-end-date') || {}).value || '').trim();
    const search = ((el('audit-filter-search') || {}).value || '').trim();

    const params = new URLSearchParams();
    if(source) params.set('source', source);
    if(status) params.set('status', status);
    if(partnerId) params.set('partner_id', partnerId);
    if(purchaseId) params.set('purchase_id', purchaseId);
    if(startDate) params.set('start_date', startDate);
    if(endDate) params.set('end_date', endDate);
    if(search) params.set('search', search);

    return params;
  }

  function formatAuditDate(value){
    if(!value) return '-';
    const d = new Date(value);
    if(Number.isNaN(d.getTime())) return '-';
    return d.toLocaleString('es-ES', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function renderAdminAuditPagination(){
    const container = el('admin-audit-pagination');
    if(!container) return;

    if(_adminAuditPages <= 1){
      container.innerHTML = '';
      return;
    }

    const startPage = Math.max(1, _adminAuditPage - 2);
    const endPage   = Math.min(_adminAuditPages, _adminAuditPage + 2);
    let html = '<nav><ul class="pagination pagination-sm justify-content-center mb-0">';
    html += `<li class="page-item ${_adminAuditPage === 1 ? 'disabled' : ''}"><a class="page-link" href="#" data-ap="${_adminAuditPage - 1}">«</a></li>`;
    if(startPage > 1) html += '<li class="page-item disabled"><span class="page-link">…</span></li>';
    for(let i = startPage; i <= endPage; i++){
      html += `<li class="page-item ${i === _adminAuditPage ? 'active' : ''}"><a class="page-link" href="#" data-ap="${i}">${i}</a></li>`;
    }
    if(endPage < _adminAuditPages) html += '<li class="page-item disabled"><span class="page-link">…</span></li>';
    html += `<li class="page-item ${_adminAuditPage === _adminAuditPages ? 'disabled' : ''}"><a class="page-link" href="#" data-ap="${_adminAuditPage + 1}">»</a></li>`;
    html += '</ul></nav>';

    container.innerHTML = html;
    container.querySelectorAll('[data-ap]').forEach(a => {
      a.addEventListener('click', ev => {
        ev.preventDefault();
        const page = parseInt(a.dataset.ap, 10);
        if(page >= 1 && page <= _adminAuditPages){
          loadAdminAuditMovements(page);
        }
      });
    });
  }

  function renderAdminAuditRows(){
    const tbody = el('admin-audit-table-body');
    if(!tbody) return;

    if(!_adminAuditRows.length){
      tbody.innerHTML = '<tr><td colspan="10" class="text-center text-muted p-3">No se encontraron movimientos con los filtros aplicados</td></tr>';
      renderAdminAuditPagination();
      return;
    }

    tbody.innerHTML = _adminAuditRows.map(row => {
      const source = escapeHTML(row.source || '-');
      const movementType = escapeHTML(row.movement_type || '-');
      const category = escapeHTML(row.category || '-');
      const status = escapeHTML(row.status || '-');
      const partnerId = row.partner_id == null ? '-' : escapeHTML(String(row.partner_id));
      const purchaseId = row.purchase_id == null ? '-' : escapeHTML(String(row.purchase_id));
      const userId = row.user_id == null ? '-' : escapeHTML(String(row.user_id));
      const summary = escapeHTML(row.summary || '-');
      const details = escapeHTML(JSON.stringify(row.details || {}, null, 2));

      return `<tr>
        <td><small>${escapeHTML(formatAuditDate(row.occurred_at))}</small></td>
        <td><span class="badge bg-secondary">${source}</span></td>
        <td>${movementType}</td>
        <td>${category}</td>
        <td>${status}</td>
        <td>${partnerId}</td>
        <td>${purchaseId}</td>
        <td>${userId}</td>
        <td>${summary}</td>
        <td>
          <details>
            <summary>Ver</summary>
            <pre class="small mt-2 mb-0">${details}</pre>
          </details>
        </td>
      </tr>`;
    }).join('');

    renderAdminAuditPagination();
  }

  async function loadAdminAuditMovements(page = 1){
    const refreshBtn = el('admin-audit-refresh');
    const applyBtn = el('admin-audit-apply');

    try {
      if(refreshBtn) setButtonLoading(refreshBtn, true);
      if(applyBtn) setButtonLoading(applyBtn, true);

      const params = getAdminAuditFilters();
      params.set('page', String(page));
      params.set('limit', '10');

      const summaryParams = getAdminAuditFilters();
      const baseApi = apiUrl.replace(':8080', ':8081');
      const [movResp, summaryResp] = await Promise.all([
        safeFetch(baseApi + `/admin/audit/movements?${params.toString()}`, { headers: authHeaders() }),
        safeFetch(baseApi + `/admin/audit/movements/summary?${summaryParams.toString()}`, { headers: authHeaders() })
      ]);

      const movData = await movResp.json();
      const summaryData = await summaryResp.json();

      if(!movResp.ok){
        throw new Error(movData.error || 'No se pudieron cargar movimientos de auditoría');
      }
      if(!summaryResp.ok){
        throw new Error(summaryData.error || 'No se pudo cargar resumen de auditoría');
      }

      _adminAuditRows = Array.isArray(movData.movements) ? movData.movements : [];
      _adminAuditPage = (movData.pagination && movData.pagination.page) ? movData.pagination.page : 1;
      _adminAuditPages = (movData.pagination && movData.pagination.pages) ? movData.pagination.pages : 1;

      if(el('audit-total-count')) el('audit-total-count').textContent = String((summaryData.summary && summaryData.summary.total) || 0);
      if(el('audit-last24-count')) el('audit-last24-count').textContent = String((summaryData.summary && summaryData.summary.last_24h) || 0);
      if(el('audit-failed-count')) el('audit-failed-count').textContent = String((summaryData.summary && summaryData.summary.failed) || 0);

      const bySource = Array.isArray(summaryData.by_source) ? summaryData.by_source : [];
      const sourceLabel = bySource.length
        ? bySource.map(item => `${item.source}: ${item.count}`).join(' | ')
        : 'Sin movimientos por fuente';

      const summaryTextEl = el('admin-audit-summary-text');
      if(summaryTextEl){
        summaryTextEl.textContent = `Página ${_adminAuditPage} de ${_adminAuditPages} | ${sourceLabel}`;
      }

      renderAdminAuditRows();
    } catch (e) {
      showLoginMessage('Error cargando auditoría: ' + e.message, 'danger', 4000);
    } finally {
      if(refreshBtn) setButtonLoading(refreshBtn, false);
      if(applyBtn) setButtonLoading(applyBtn, false);
    }
  }

  async function exportAdminAuditCsv(){
    const btn = el('admin-audit-export-csv');
    try {
      if(btn) setButtonLoading(btn, true);
      const params = getAdminAuditFilters();
      const baseApi = apiUrl.replace(':8080', ':8081');
      const url = `${baseApi}/admin/audit/movements/export/csv?${params.toString()}`;

      const resp = await safeFetch(url, {
        method: 'GET',
        headers: {
          Authorization: 'Bearer ' + (getToken() || '')
        }
      });

      if(!resp.ok){
        const text = await resp.text();
        throw new Error(text || 'No se pudo exportar auditoría en CSV');
      }

      const blob = await resp.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = `auditoria_movimientos_${new Date().toISOString().slice(0,10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
      showLoginMessage('CSV de auditoría generado correctamente', 'success', 2500);
    } catch (e) {
      showLoginMessage('Error exportando CSV de auditoría: ' + e.message, 'danger', 4000);
    } finally {
      if(btn) setButtonLoading(btn, false);
    }
  }

  function populatePurchasePartnerFilter(data) {
    const sel = el('pf-partner');
    if (!sel) return;
    const seen = new Set();
    const options = ['<option value="">Todos los partners</option>'];
    data.forEach(p => {
      if (p.partner_id && !seen.has(p.partner_id)) {
        seen.add(p.partner_id);
        const label = escapeHTML(p.partner_name || 'Partner ' + p.partner_id);
        options.push(`<option value="${p.partner_id}">${label}</option>`);
      }
    });
    sel.innerHTML = options.join('');
  }

  async function loadAdminPurchases(){
    const btn = el('list-purchases');
    try {
      setButtonLoading(btn, true);
      const resp = await safeFetch(apiUrl.replace(':8080', ':8081') + '/admin/purchases', { headers: authHeaders() });
      const data = await resp.json();
      setButtonLoading(btn, false);
      if (!Array.isArray(data)) { showLoginMessage('Error al obtener compras', 'danger', 3000); return; }
      allPurchasesData = data;
      populatePurchasePartnerFilter(data);
      // Resetear filtros al recargar
      ['pf-partner','pf-status','pf-date-from','pf-date-to','pf-method'].forEach(id => { const e = el(id); if(e) e.value = ''; });
      const s = el('pf-summary'); if(s) s.style.display = 'none';
      renderPurchasesRows(data);
    } catch(e) {
      setButtonLoading(btn, false);
      showLoginMessage('Error: ' + e.message, 'danger', 3000);
    }
  }

  on('list-purchases', 'click', () => loadAdminPurchases());

  on('pf-apply', 'click', applyPurchasesFilter);

  on('pf-clear', 'click', () => {
    ['pf-partner','pf-status','pf-date-from','pf-date-to','pf-method'].forEach(id => { const e = el(id); if(e) e.value = ''; });
    const s = el('pf-summary'); if(s) s.style.display = 'none';
    renderPurchasesRows(allPurchasesData);
  });

  // ── Helper: poblar selects de partner en modales financieros ──
  async function populateFinancialPartnerSelects() {
    const ids = ['ext-purchase-partner', 'comp-partner', 'adjust-purchase-partner'];
    const anyEmpty = ids.some(id => { const s = el(id); return s && s.options.length <= 1; });
    if (!anyEmpty) return;
    try {
      const partners = await fetchAdminPartners();
      const opts = '<option value="">Selecciona un partner</option>' +
        partners.map(p => `<option value="${p.id}">${escapeHTML(p.name || 'Partner ' + p.id)}</option>`).join('');
      ids.forEach(id => { const s = el(id); if (s) s.innerHTML = opts; });
    } catch(e) { /* silencioso */ }
  }

  // ── Modal Compra Externa ──
  on('admin-purchase-external-btn', 'click', async () => {
    await populateFinancialPartnerSelects();
    ['ext-purchase-qty','ext-purchase-price','ext-purchase-ref','ext-purchase-notes'].forEach(id => { const e = el(id); if(e) e.value = id === 'ext-purchase-qty' ? '1' : ''; });
    const m = el('ext-purchase-method'); if (m) m.value = 'bank_transfer';
    const msg = el('external-purchase-msg'); if (msg) msg.innerHTML = '';
    bootstrap.Modal.getOrCreateInstance(document.getElementById('modal-external-purchase')).show();
  });

  on('modal-external-purchase-submit', 'click', async () => {
    const partnerSel = el('ext-purchase-partner');
    const partnerId  = (partnerSel || {}).value || '';
    const partnerName = partnerSel ? (partnerSel.options[partnerSel.selectedIndex] || {}).text || partnerId : partnerId;
    const qty    = parseInt((el('ext-purchase-qty') || {}).value || '0');
    const price  = parseFloat((el('ext-purchase-price') || {}).value || '0');
    const method = (el('ext-purchase-method') || {}).value || 'bank_transfer';
    const ref    = (el('ext-purchase-ref') || {}).value || '';
    const notes  = (el('ext-purchase-notes') || {}).value || '';
    const msgEl  = el('external-purchase-msg');
    const setMsg = (txt, type='danger') => { if(msgEl) msgEl.innerHTML = `<div class="alert alert-${type} py-1 mb-2">${escapeHTML(txt)}</div>`; };
    if (!partnerId) return setMsg('Selecciona un partner');
    if (!qty || qty < 1) return setMsg('Cantidad inválida');
    if (isNaN(price) || price < 0) return setMsg('Precio inválido');
    const methodLabels = { bank_transfer: '🏦 Transferencia', cash: '💵 Efectivo', invoice: '📄 Factura' };
    showConfirmAction({
      title: 'Registrar Compra Externa', icon: '🛒',
      rows: [
        { label: 'Partner:', value: partnerName },
        { label: 'Cantidad vouchers:', value: qty },
        { label: 'Precio total:', value: `$${price.toFixed(2)}` },
        { label: 'Método de pago:', value: methodLabels[method] || method },
        { label: 'Referencia:', value: ref || '—' },
        { label: 'Notas:', value: notes || '—' }
      ],
      confirmLabel: '✓ Registrar Compra', confirmClass: 'btn-success',
      onConfirm: async () => {
        const btn = el('modal-external-purchase-submit');
        try {
          setButtonLoading(btn, true);
          const base = apiUrl.replace(':8080', ':8081');
          const resp = await safeFetch(`${base}/admin/partners/${partnerId}/purchases/external`, {
            method: 'POST', headers: authHeaders(),
            body: JSON.stringify({ qty, total_price: price, payment_method: method, external_reference: ref || undefined, notes: notes || undefined })
          });
          const data = await resp.json();
          setButtonLoading(btn, false);
          if (!resp.ok) return setMsg(data.error || 'Error al registrar compra');
          bootstrap.Modal.getInstance(document.getElementById('modal-external-purchase')).hide();
          showToast(`✅ Compra externa registrada — ${data.vouchers_created} voucher(s) generados`, 'success');
          loadAdminPurchases();
        } catch(e) { setButtonLoading(btn, false); setMsg(e.message); }
      }
    });
  });

  // ── Modal Dar Cortesía ──
  on('admin-complimentary-btn', 'click', async () => {
    await populateFinancialPartnerSelects();
    const qEl = el('comp-qty'); if (qEl) qEl.value = '1';
    const rEl = el('comp-reason'); if (rEl) rEl.value = '';
    const msg = el('complimentary-msg'); if (msg) msg.innerHTML = '';
    bootstrap.Modal.getOrCreateInstance(document.getElementById('modal-complimentary')).show();
  });

  on('modal-complimentary-submit', 'click', async () => {
    const partnerSel  = el('comp-partner');
    const partnerId   = (partnerSel || {}).value || '';
    const partnerName = partnerSel ? (partnerSel.options[partnerSel.selectedIndex] || {}).text || partnerId : partnerId;
    const qty    = parseInt((el('comp-qty') || {}).value || '0');
    const reason = (el('comp-reason') || {}).value.trim();
    const msgEl  = el('complimentary-msg');
    const setMsg = (txt, type='danger') => { if(msgEl) msgEl.innerHTML = `<div class="alert alert-${type} py-1 mb-2">${escapeHTML(txt)}</div>`; };
    if (!partnerId) return setMsg('Selecciona un partner');
    if (!qty || qty < 1) return setMsg('Cantidad inválida');
    if (!reason) return setMsg('El motivo es obligatorio');
    showConfirmAction({
      title: 'Emitir Vouchers de Cortesía', icon: '🎁',
      rows: [
        { label: 'Partner:', value: partnerName },
        { label: 'Cantidad vouchers:', value: qty },
        { label: 'Precio total:', value: '$0.00 (cortesía)' },
        { label: 'Motivo:', value: reason }
      ],
      confirmLabel: '🎁 Emitir Cortesía', confirmClass: 'btn-warning',
      onConfirm: async () => {
        const btn = el('modal-complimentary-submit');
        try {
          setButtonLoading(btn, true);
          const base = apiUrl.replace(':8080', ':8081');
          const resp = await safeFetch(`${base}/admin/partners/${partnerId}/vouchers/complimentary`, {
            method: 'POST', headers: authHeaders(),
            body: JSON.stringify({ quantity: qty, reason })
          });
          const data = await resp.json();
          setButtonLoading(btn, false);
          if (!resp.ok) return setMsg(data.error || 'Error al emitir cortesía');
          bootstrap.Modal.getInstance(document.getElementById('modal-complimentary')).hide();
          showToast(`🎁 ${data.vouchers_created} voucher(s) de cortesía emitidos`, 'success');
          loadAdminPurchases();
        } catch(e) { setButtonLoading(btn, false); setMsg(e.message); }
      }
    });
  });

  // ── Modal Ajustar Compra ──
  window.openAdjustPurchaseModal = async function(purchaseId) {
    const purchase = allPurchasesData.find(p => p.id === purchaseId);
    if (!purchase) return;
    const isComp = purchase.payment_method === 'complimentary';

    await populateFinancialPartnerSelects();

    // Campos comunes
    const idEl   = el('adjust-purchase-id');         if (idEl)   idEl.value   = purchaseId;
    const disp   = el('adjust-purchase-id-display'); if (disp)   disp.value   = '#' + purchaseId;
    const partSel = el('adjust-purchase-partner');
    if (partSel) partSel.value = purchase.partner_id || '';
    const qtyEl  = el('adjust-purchase-qty');        if (qtyEl)  qtyEl.value  = purchase.qty || 1;
    const msg    = el('adjust-purchase-msg');        if (msg)    msg.innerHTML = '';

    // Mostrar/ocultar grupos según tipo
    const compFields = el('adjust-fields-comp');
    const extFields  = el('adjust-fields-external');
    if (compFields) compFields.style.display = isComp ? '' : 'none';
    if (extFields)  extFields.style.display  = isComp ? 'none' : '';

    // Título del modal
    const titleEl = el('adjust-purchase-modal-title');
    if (titleEl) titleEl.textContent = isComp ? '🎁 Ajustar Cortesía' : '✏️ Ajustar Compra Externa';

    if (isComp) {
      const crEl = el('adjust-purchase-comp-reason'); if (crEl) crEl.value = purchase.complimentary_reason || '';
    } else {
      const price = el('adjust-purchase-price');   if (price) price.value = parseFloat(purchase.total_price || 0).toFixed(2);
      const meth  = el('adjust-purchase-method');  if (meth)  meth.value  = purchase.payment_method || 'bank_transfer';
      const ref   = el('adjust-purchase-ref');     if (ref)   ref.value   = purchase.external_reference || '';
      const notes = el('adjust-purchase-notes');   if (notes) notes.value = purchase.notes || '';
    }

    bootstrap.Modal.getOrCreateInstance(document.getElementById('modal-adjust-purchase')).show();
  };

  on('modal-adjust-purchase-submit', 'click', async () => {
    const purchaseId = (el('adjust-purchase-id') || {}).value || '';
    const msgEl  = el('adjust-purchase-msg');
    const setMsg = (txt, type='danger') => { if(msgEl) msgEl.innerHTML = `<div class="alert alert-${type} py-1 mb-2">${escapeHTML(txt)}</div>`; };
    if (!purchaseId) return setMsg('ID de compra inválido');

    const purchase = allPurchasesData.find(p => String(p.id) === String(purchaseId));
    const isComp = purchase && purchase.payment_method === 'complimentary';

    const partnerId = parseInt((el('adjust-purchase-partner') || {}).value || '', 10);
    const qty       = parseInt((el('adjust-purchase-qty') || {}).value || '', 10);
    const body      = {};
    const confirmRows = [{ label: 'Compra ID:', value: '#' + purchaseId }];

    if (!isNaN(partnerId) && partnerId > 0) {
      body.partner_id = partnerId;
      const partSel = el('adjust-purchase-partner');
      const partName = partSel ? (partSel.options[partSel.selectedIndex] || {}).text : partnerId;
      confirmRows.push({ label: 'Partner:', value: partName });
    }
    if (!isNaN(qty) && qty > 0) { body.qty = qty; confirmRows.push({ label: 'Cantidad:', value: qty }); }

    if (isComp) {
      const reason = (el('adjust-purchase-comp-reason') || {}).value.trim();
      if (!reason) return setMsg('El motivo de cortesía es requerido');
      body.complimentary_reason = reason;
      confirmRows.push({ label: 'Motivo:', value: reason });
    } else {
      const price  = parseFloat((el('adjust-purchase-price') || {}).value || '');
      const method = (el('adjust-purchase-method') || {}).value || '';
      const ref    = (el('adjust-purchase-ref') || {}).value.trim();
      const notes  = (el('adjust-purchase-notes') || {}).value.trim();
      const methodLabels = { bank_transfer: '🏦 Transferencia', cash: '💵 Efectivo', invoice: '📄 Factura' };
      if (!isNaN(price)) { body.total_price = price; confirmRows.push({ label: 'Precio total:', value: `$${price.toFixed(2)}` }); }
      if (method) { body.payment_method = method; confirmRows.push({ label: 'Método pago:', value: methodLabels[method] || method }); }
      if (ref)    { body.external_reference = ref;  confirmRows.push({ label: 'Referencia:', value: ref }); }
      if (notes)  { body.notes = notes;             confirmRows.push({ label: 'Notas:', value: notes }); }
    }

    showConfirmAction({
      title: isComp ? `Ajustar Cortesía #${purchaseId}` : `Ajustar Compra #${purchaseId}`,
      icon: isComp ? '🎁' : '✏️',
      rows: confirmRows,
      confirmLabel: '💾 Guardar Ajuste', confirmClass: 'btn-primary',
      onConfirm: async () => {
        const btn = el('modal-adjust-purchase-submit');
        try {
          setButtonLoading(btn, true);
          const base = apiUrl.replace(':8080', ':8081');
          const resp = await safeFetch(`${base}/admin/purchases/${purchaseId}/adjust`, {
            method: 'PUT', headers: authHeaders(),
            body: JSON.stringify(body)
          });
          const data = await resp.json();
          setButtonLoading(btn, false);
          if (!resp.ok) return setMsg(data.error || 'Error al ajustar compra');
          bootstrap.Modal.getInstance(document.getElementById('modal-adjust-purchase')).hide();
          showToast('✅ Compra ajustada correctamente', 'success');
          loadAdminPurchases();
        } catch(e) { setButtonLoading(btn, false); setMsg(e.message); }
      }
    });
  });

  // ──────────────────────────────────────────────────────────
  // MÓDULO REPORTERÍA
  // ──────────────────────────────────────────────────────────

  // Datos en memoria para exportar tras generar
  const _rptData = { compras: [], vouchers: {}, activaciones: [], partners: [], tendencia: [] };

  // Helper: construye URLSearchParams de fecha + partner opcional
  function rptParams(startId, endId, partnerIdId){
    const p = new URLSearchParams();
    const s = (el(startId)    || {}).value || '';
    const e = (el(endId)      || {}).value || '';
    const pid = partnerIdId ? ((el(partnerIdId) || {}).value || '') : '';
    if(s)   p.set('start_date', s);
    if(e)   p.set('end_date', e);
    if(pid) p.set('partner_id', pid);
    return p;
  }

  // Muestra mensaje temporal dentro de un módulo
  function rptMsg(id, msg, type = 'danger'){
    const n = el(id);
    if(n) n.innerHTML = msg ? `<div class="alert alert-${type} py-1 mb-2">${escapeHTML(msg)}</div>` : '';
  }

  // Popula selects de partner en los tabs (solo una vez)
  let _rptPartnersLoaded = false;
  async function rptLoadPartners(){
    if(_rptPartnersLoaded) return;
    try {
      const partners = await fetchAdminPartners();
      const opts = ['<option value="">Todos los partners</option>',
        ...(partners || []).map(p => `<option value="${p.id}">${escapeHTML(p.name || 'Partner '+p.id)}</option>`)
      ].join('');
      ['rpt-compras-partner','rpt-vouchers-partner'].forEach(id => {
        const s = el(id); if(s) s.innerHTML = opts;
      });
      _rptPartnersLoaded = true;
    } catch(e){ /* silencioso */ }
  }

  // Formato numérico
  const rptFmt      = n => (n == null || isNaN(n)) ? '0' : Number(n).toLocaleString('es-CL');
  const rptFmtMoney = n => '$' + rptFmt(n);

  // ── TAB switching ───────────────────────────────────────
  document.addEventListener('click', ev => {
    const btn = ev.target.closest('[data-rpt-tab]');
    if(!btn) return;
    const tab = btn.dataset.rptTab;
    document.querySelectorAll('#rpt-tabs .nav-link').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.rpt-panel').forEach(p => p.style.display = 'none');
    const panel = el('rpt-panel-' + tab);
    if(panel) panel.style.display = '';
    // Cargar partners cuando sea necesario
    if(tab === 'compras' || tab === 'vouchers') rptLoadPartners();
  });

  // ── GENERAR: COMPRAS ────────────────────────────────────
  on('rpt-compras-generate', 'click', async () => {
    const btn = el('rpt-compras-generate');
    rptMsg('rpt-compras-msg', '');
    setButtonLoading(btn, true);
    try {
      const base = apiUrl.replace(':8080', ':8081');
      const p = rptParams('rpt-compras-start', 'rpt-compras-end', 'rpt-compras-partner');
      p.set('page', '1'); p.set('limit', '1000');
      const resp = await safeFetch(base + '/admin/reports/purchases?' + p.toString(), { headers: authHeaders() });
      const data = await safeJson(resp);
      if(!resp.ok) throw new Error(data.error || 'Error al obtener compras');
      const rows = data.purchases || [];
      _rptData.compras = rows;
      const tbody = el('rpt-compras-tbody');
      if(tbody){
        if(!rows.length){
          tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted p-3">Sin resultados para el período seleccionado</td></tr>';
        } else {
          const statusColors = { COMPLETED:'success', PENDING:'warning', CANCELLED:'danger' };
          tbody.innerHTML = rows.map(r => `<tr>
            <td><small>${r.id}</small></td>
            <td>${escapeHTML(r.partner_name||'-')}</td>
            <td class="text-end">${r.qty||0}</td>
            <td class="text-end fw-semibold">${rptFmtMoney(r.total_price||0)}</td>
            <td><span class="badge bg-${statusColors[r.status]||'secondary'}">${escapeHTML(r.status||'-')}</span></td>
            <td><small class="text-muted">${escapeHTML(r.stripe_status||'-')}</small></td>
            <td class="text-end">${r.vouchers_used||0}</td>
            <td><small>${r.created_at ? new Date(r.created_at).toLocaleDateString('es-ES') : '-'}</small></td>
          </tr>`).join('');
        }
      }
      const preview = el('rpt-compras-preview');
      if(preview) preview.style.display = '';
      rptMsg('rpt-compras-msg', `${rows.length} registros encontrados`, 'success');
    } catch(e) {
      rptMsg('rpt-compras-msg', e.message);
    } finally {
      setButtonLoading(btn, false);
    }
  });

  // ── GENERAR: VOUCHERS ───────────────────────────────────
  on('rpt-vouchers-generate', 'click', async () => {
    const btn = el('rpt-vouchers-generate');
    rptMsg('rpt-vouchers-msg', '');
    setButtonLoading(btn, true);
    try {
      const base = apiUrl.replace(':8080', ':8081');
      const p = rptParams('rpt-vouchers-start', 'rpt-vouchers-end', 'rpt-vouchers-partner');
      const resp = await safeFetch(base + '/admin/reports/summary?' + p.toString(), { headers: authHeaders() });
      const data = await safeJson(resp);
      if(!resp.ok) throw new Error(data.error || 'Error al obtener vouchers');
      const s = data.summary || {};
      const rows = [
        { metrica: 'Total Vouchers Vendidos',    valor: s.total_vouchers_sold    || s.total_vouchers || 0 },
        { metrica: 'Vouchers Disponibles',        valor: s.available_vouchers     || 0 },
        { metrica: 'Vouchers Usados/Consumidos',  valor: s.consumed_vouchers      || s.used_vouchers  || 0 },
        { metrica: 'Vouchers Expirados',          valor: s.expired_vouchers       || 0 },
        { metrica: 'Total Activaciones',          valor: s.total_activations      || 0 },
        { metrica: 'Total Compras asociadas',     valor: s.total_purchases        || 0 },
        { metrica: 'Ingresos Totales',            valor: rptFmtMoney(s.total_revenue || 0) },
      ];
      _rptData.vouchers = { rows, s };
      const tbody = el('rpt-vouchers-tbody');
      if(tbody) tbody.innerHTML = rows.map(r => `<tr>
        <td>${escapeHTML(r.metrica)}</td>
        <td class="text-end fw-semibold">${escapeHTML(String(r.valor))}</td>
      </tr>`).join('');
      const preview = el('rpt-vouchers-preview');
      if(preview) preview.style.display = '';
      rptMsg('rpt-vouchers-msg', 'Datos cargados', 'success');
    } catch(e) {
      rptMsg('rpt-vouchers-msg', e.message);
    } finally {
      setButtonLoading(btn, false);
    }
  });

  // ── GENERAR: ACTIVACIONES ───────────────────────────────
  on('rpt-activaciones-generate', 'click', async () => {
    const btn = el('rpt-activaciones-generate');
    rptMsg('rpt-activaciones-msg', '');
    setButtonLoading(btn, true);
    try {
      const base = apiUrl.replace(':8080', ':8081');
      const p = rptParams('rpt-activaciones-start', 'rpt-activaciones-end', null);
      p.set('limit', '100');
      const resp = await safeFetch(base + '/admin/reports/top-courses?' + p.toString(), { headers: authHeaders() });
      const data = await safeJson(resp);
      if(!resp.ok) throw new Error(data.error || 'Error al obtener activaciones');
      const rows = data.top_courses || [];
      _rptData.activaciones = rows;
      const tbody = el('rpt-activaciones-tbody');
      if(tbody){
        if(!rows.length){
          tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted p-3">Sin resultados</td></tr>';
        } else {
          tbody.innerHTML = rows.map((r,i) => `<tr>
            <td>${i+1}</td>
            <td>${escapeHTML(r.course_name||'-')}</td>
            <td class="text-end">${r.total_activations||0}</td>
            <td class="text-end">${r.partners_count||0}</td>
          </tr>`).join('');
        }
      }
      const preview = el('rpt-activaciones-preview');
      if(preview) preview.style.display = '';
      rptMsg('rpt-activaciones-msg', `${rows.length} certificaciones encontradas`, 'success');
    } catch(e) {
      rptMsg('rpt-activaciones-msg', e.message);
    } finally {
      setButtonLoading(btn, false);
    }
  });

  // ── GENERAR: PARTNERS ───────────────────────────────────
  on('rpt-partners-generate', 'click', async () => {
    const btn = el('rpt-partners-generate');
    rptMsg('rpt-partners-msg', '');
    setButtonLoading(btn, true);
    try {
      const base = apiUrl.replace(':8080', ':8081');
      const p = rptParams('rpt-partners-start', 'rpt-partners-end', null);
      p.set('limit', '100');
      const resp = await safeFetch(base + '/admin/reports/top-partners?' + p.toString(), { headers: authHeaders() });
      const data = await safeJson(resp);
      if(!resp.ok) throw new Error(data.error || 'Error al obtener partners');
      const rows = data.top_partners || [];
      _rptData.partners = rows;
      const tbody = el('rpt-partners-tbody');
      if(tbody){
        if(!rows.length){
          tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted p-3">Sin resultados</td></tr>';
        } else {
          tbody.innerHTML = rows.map((r,i) => `<tr>
            <td>${i+1}</td>
            <td>${escapeHTML(r.partner_name||'-')}</td>
            <td class="text-end">${r.total_purchases||0}</td>
            <td class="text-end">${r.vouchers_sold||0}</td>
            <td class="text-end fw-semibold">${rptFmtMoney(r.total_revenue||0)}</td>
          </tr>`).join('');
        }
      }
      const preview = el('rpt-partners-preview');
      if(preview) preview.style.display = '';
      rptMsg('rpt-partners-msg', `${rows.length} partners encontrados`, 'success');
    } catch(e) {
      rptMsg('rpt-partners-msg', e.message);
    } finally {
      setButtonLoading(btn, false);
    }
  });

  // ── GENERAR: TENDENCIA ──────────────────────────────────
  on('rpt-tendencia-generate', 'click', async () => {
    const btn = el('rpt-tendencia-generate');
    rptMsg('rpt-tendencia-msg', '');
    setButtonLoading(btn, true);
    try {
      const base = apiUrl.replace(':8080', ':8081');
      const p = rptParams('rpt-tendencia-start', 'rpt-tendencia-end', null);
      const resp = await safeFetch(base + '/admin/reports/monthly?' + p.toString(), { headers: authHeaders() });
      const data = await safeJson(resp);
      if(!resp.ok) throw new Error(data.error || 'Error al obtener tendencia');
      const rows = data.monthly || [];
      _rptData.tendencia = rows;
      const tbody = el('rpt-tendencia-tbody');
      if(tbody){
        if(!rows.length){
          tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted p-3">Sin resultados</td></tr>';
        } else {
          tbody.innerHTML = rows.map(r => `<tr>
            <td>${escapeHTML(r.month||'-')}</td>
            <td class="text-end">${r.purchases||0}</td>
            <td class="text-end">${r.vouchers_sold||0}</td>
            <td class="text-end fw-semibold">${rptFmtMoney(r.revenue||0)}</td>
          </tr>`).join('');
        }
      }
      const preview = el('rpt-tendencia-preview');
      if(preview) preview.style.display = '';
      rptMsg('rpt-tendencia-msg', `${rows.length} meses encontrados`, 'success');
    } catch(e) {
      rptMsg('rpt-tendencia-msg', e.message);
    } finally {
      setButtonLoading(btn, false);
    }
  });

  // ── HELPERS EXCEL/PDF ───────────────────────────────────

  // Aplica anchos de columna a una hoja SheetJS
  function _xlsxSetColWidths(ws, widths){
    ws['!cols'] = widths.map(w => ({ wch: w }));
  }

  // Carga el logo una sola vez y lo cachea en base64 para jsPDF
  let _logoBase64 = null;
  async function _loadLogo(){
    if(_logoBase64) return _logoBase64;
    try {
      const resp = await fetch('/static/assets/certjoin-logo.png');
      if(!resp.ok) return null;
      const blob = await resp.blob();
      return await new Promise(resolve => {
        const reader = new FileReader();
        reader.onloadend = () => { _logoBase64 = reader.result; resolve(_logoBase64); };
        reader.onerror   = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    } catch(e){ return null; }
  }

  // ── EXPORTAR EXCEL ──────────────────────────────────────
  function rptExportExcel(module){
    const XLSX = window.XLSX;
    if(!XLSX){ showLoginMessage('Librería Excel no disponible', 'danger', 3000); return; }
    const wb   = XLSX.utils.book_new();
    const fecha = new Date().toISOString().slice(0,10);
    const now   = new Date().toLocaleDateString('es-ES');

    const drLabel = mod => {
      const s = (el(`rpt-${mod}-start`) || {}).value;
      const e = (el(`rpt-${mod}-end`)   || {}).value;
      if(!s && !e) return 'Todo el período';
      const fmt = d => new Date(d).toLocaleDateString('es-ES');
      if(s && e) return `${fmt(s)} – ${fmt(e)}`;
      return s ? `Desde ${fmt(s)}` : `Hasta ${fmt(e)}`;
    };

    const mkMeta = (title, mod) => [
      ['CertJOIN Platform'],
      [title],
      [`Generado: ${now}`],
      [`Período: ${drLabel(mod)}`],
      [],
    ];

    if(module === 'compras'){
      const rows = _rptData.compras;
      if(!rows.length){ showLoginMessage('Genera el reporte primero', 'warning', 2500); return; }
      const ws = XLSX.utils.aoa_to_sheet([
        ...mkMeta('Reporte de Compras', 'compras'),
        ['ID','Partner','Cantidad','Total ($)','Estado','Estado Stripe','Vouchers Usados','Fecha'],
        ...rows.map(r => [
          r.id, r.partner_name||'-', r.qty||0,
          parseFloat(r.total_price||0), r.status||'-',
          r.stripe_status||'-', r.vouchers_used||0,
          r.created_at ? new Date(r.created_at).toLocaleDateString('es-ES') : '-'
        ])
      ]);
      _xlsxSetColWidths(ws, [8,28,12,14,14,16,16,13]);
      XLSX.utils.book_append_sheet(wb, ws, 'Compras');

    } else if(module === 'vouchers'){
      const rows = (_rptData.vouchers || {}).rows || [];
      if(!rows.length){ showLoginMessage('Genera el reporte primero', 'warning', 2500); return; }
      const ws = XLSX.utils.aoa_to_sheet([
        ...mkMeta('Reporte de Vouchers', 'vouchers'),
        ['Métrica','Valor'],
        ...rows.map(r => [r.metrica, String(r.valor)])
      ]);
      _xlsxSetColWidths(ws, [34,18]);
      XLSX.utils.book_append_sheet(wb, ws, 'Vouchers');

    } else if(module === 'activaciones'){
      const rows = _rptData.activaciones;
      if(!rows.length){ showLoginMessage('Genera el reporte primero', 'warning', 2500); return; }
      const ws = XLSX.utils.aoa_to_sheet([
        ...mkMeta('Reporte de Activaciones', 'activaciones'),
        ['#','Certificación','Activaciones','Partners'],
        ...rows.map((r,i) => [i+1, r.course_name||'-', r.total_activations||0, r.partners_count||0])
      ]);
      _xlsxSetColWidths(ws, [5,36,14,12]);
      XLSX.utils.book_append_sheet(wb, ws, 'Activaciones');

    } else if(module === 'partners'){
      const rows = _rptData.partners;
      if(!rows.length){ showLoginMessage('Genera el reporte primero', 'warning', 2500); return; }
      const ws = XLSX.utils.aoa_to_sheet([
        ...mkMeta('Reporte de Partners', 'partners'),
        ['#','Partner','Compras','Vouchers Vendidos','Ingresos ($)'],
        ...rows.map((r,i) => [i+1, r.partner_name||'-', r.total_purchases||0, r.vouchers_sold||0, parseFloat(r.total_revenue||0)])
      ]);
      _xlsxSetColWidths(ws, [5,30,12,18,16]);
      XLSX.utils.book_append_sheet(wb, ws, 'Partners');

    } else if(module === 'tendencia'){
      const rows = _rptData.tendencia;
      if(!rows.length){ showLoginMessage('Genera el reporte primero', 'warning', 2500); return; }
      const ws = XLSX.utils.aoa_to_sheet([
        ...mkMeta('Reporte de Tendencia Mensual', 'tendencia'),
        ['Mes','Compras','Vouchers Vendidos','Ingresos ($)'],
        ...rows.map(r => [r.month||'-', r.purchases||0, r.vouchers_sold||0, parseFloat(r.revenue||0)])
      ]);
      _xlsxSetColWidths(ws, [18,12,18,16]);
      XLSX.utils.book_append_sheet(wb, ws, 'Tendencia');
    }
    XLSX.writeFile(wb, `reporte_${module}_${fecha}.xlsx`);
  }

  // ── EXPORTAR PDF ────────────────────────────────────────
  async function rptExportPdf(module){
    const { jsPDF } = window.jspdf || {};
    if(!jsPDF){ showLoginMessage('Librería PDF no disponible', 'danger', 3000); return; }

    const fecha    = new Date().toISOString().slice(0,10);
    const logoData = await _loadLogo();

    const startEl = el(`rpt-${module}-start`);
    const endEl   = el(`rpt-${module}-end`);
    const s = startEl?.value, e = endEl?.value;
    const fmtD = d => new Date(d).toLocaleDateString('es-ES', {day:'2-digit', month:'short', year:'numeric'});
    const dateRange = (s || e)
      ? `Período: ${s ? fmtD(s) : '—'} al ${e ? fmtD(e) : '—'}`
      : 'Período: Todo el tiempo';

    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const titleMap = {
      compras:     'Reporte de Compras',
      vouchers:    'Reporte de Vouchers',
      activaciones:'Reporte de Activaciones',
      partners:    'Reporte de Partners',
      tendencia:   'Tendencia Mensual',
    };

    const startY = _pdfHeader(doc, titleMap[module] || 'Reporte', { logoData, dateRange });
    const tBase = {
      startY,
      styles: { fontSize: 8, cellPadding: 2.5 },
      headStyles: { fillColor: [15,52,120], textColor: 255, fontStyle: 'bold', fontSize: 8.5 },
      alternateRowStyles: { fillColor: [240,246,255] },
      tableLineColor: [200,200,200], tableLineWidth: 0.1,
    };

    let head = [], body = [];
    if(module === 'compras'){
      const rows = _rptData.compras;
      if(!rows.length){ showLoginMessage('Genera el reporte primero', 'warning', 2500); return; }
      head = [['ID','Partner','Cantidad','Total ($)','Estado','Stripe','Usados','Fecha']];
      body = rows.map(r => [
        r.id, r.partner_name||'-', r.qty||0,
        '$'+parseFloat(r.total_price||0).toFixed(2),
        r.status||'-', r.stripe_status||'-', r.vouchers_used||0,
        r.created_at ? new Date(r.created_at).toLocaleDateString('es-ES') : '-'
      ]);
    } else if(module === 'vouchers'){
      const rows = (_rptData.vouchers||{}).rows||[];
      if(!rows.length){ showLoginMessage('Genera el reporte primero', 'warning', 2500); return; }
      head = [['Métrica','Valor']];
      body = rows.map(r => [r.metrica, String(r.valor)]);
    } else if(module === 'activaciones'){
      const rows = _rptData.activaciones;
      if(!rows.length){ showLoginMessage('Genera el reporte primero', 'warning', 2500); return; }
      head = [['#','Certificación','Activaciones','Partners']];
      body = rows.map((r,i) => [i+1, r.course_name||'-', r.total_activations||0, r.partners_count||0]);
    } else if(module === 'partners'){
      const rows = _rptData.partners;
      if(!rows.length){ showLoginMessage('Genera el reporte primero', 'warning', 2500); return; }
      head = [['#','Partner','Compras','Vouchers','Ingresos ($)']];
      body = rows.map((r,i) => [i+1, r.partner_name||'-', r.total_purchases||0,
        r.vouchers_sold||0, '$'+parseFloat(r.total_revenue||0).toFixed(2)]);
    } else if(module === 'tendencia'){
      const rows = _rptData.tendencia;
      if(!rows.length){ showLoginMessage('Genera el reporte primero', 'warning', 2500); return; }
      head = [['Mes','Compras','Vouchers','Ingresos ($)']];
      body = rows.map(r => [r.month||'-', r.purchases||0, r.vouchers_sold||0,
        '$'+parseFloat(r.revenue||0).toFixed(2)]);
    }

    doc.autoTable({ head, body, ...tBase });
    _pdfFooter(doc);
    doc.save(`reporte_${module}_${fecha}.pdf`);
  }

  // Event listeners de descarga
  ['compras','vouchers','activaciones','partners','tendencia'].forEach(mod => {
    on(`rpt-${mod}-excel`, 'click', () => rptExportExcel(mod));
    on(`rpt-${mod}-pdf`,   'click', () => rptExportPdf(mod));
  });

  // Compatibilidad: loadAdminReports llama al primer tab si se invoca desde el menú
  function loadAdminReports(){
    rptLoadPartners();
  }

  // ── Admin: Activaciones con estado Moodle ───────────────────────────────────

  let _adminActPage    = 1;
  let _adminActTotal   = 0;
  const ACT_PAGE_SIZE  = 20;

  function moodleStatusBadge(ms, moodleError, moodleCompletedAt) {
    ms = (ms || '').toUpperCase();
    if(ms === 'COMPLETED'){
      const dateStr = moodleCompletedAt
        ? new Date(moodleCompletedAt).toLocaleDateString('es-ES', { day:'2-digit', month:'2-digit', year:'numeric' })
        : '';
      const title = dateStr ? `Completado el ${dateStr}` : 'Certificación completada';
      return `<span class="badge bg-primary" title="${escapeHTML(title)}" style="cursor:default;">🎓 Completado</span>${dateStr ? `<div class="small text-muted mt-1">${dateStr}</div>` : ''}`;
    }
    if(ms === 'COURSE_COMPLETED') return '<span class="badge bg-info text-white">📖 Curso Completado</span>';
    if(ms === 'ENROLLED') return '<span class="badge bg-success">✓ Matriculado</span>';
    if(ms === 'MOCKED')   return '<span class="badge bg-info text-white">Simulado</span>';
    if(ms === 'FAILED')   return `<span class="badge bg-danger" title="${escapeHTML(moodleError||'')}" style="cursor:help;">✗ Error</span>`;
    if(ms === 'PENDING')  return '<span class="badge bg-warning text-dark">⏳ Pendiente</span>';
    if(ms === 'SKIPPED')  return '<span class="badge bg-secondary">Sin mapear</span>';
    return '<span class="text-muted">—</span>';
  }

  async function loadAdminActivaciones(page) {
    _adminActPage = page || 1;
    const tbody = el('admin-activaciones-tbody');
    if(!tbody) return;
    tbody.innerHTML = '<tr><td colspan="10" class="text-center text-muted p-3">Cargando...</td></tr>';

    const partner  = (el('admin-act-filter-partner')  || {}).value  || '';
    const moodle   = (el('admin-act-filter-moodle')   || {}).value  || '';
    const courseId = (el('admin-act-filter-course')   || {}).value  || '';
    const offset   = (_adminActPage - 1) * ACT_PAGE_SIZE;

    const params = new URLSearchParams({ limit: ACT_PAGE_SIZE, offset });
    if(partner)  params.set('partner_id',    partner);
    if(moodle)   params.set('moodle_status', moodle);
    if(courseId) params.set('course_id',     courseId);

    try {
      const resp = await safeFetch(apiUrl.replace(':8080', ':8081') + `/admin/activations?${params}`, { headers: authHeaders() });
      const data = await safeJson(resp);
      if(!resp.ok) { tbody.innerHTML = `<tr><td colspan="10" class="text-center text-danger p-3">${escapeHTML(data.error||'Error')}</td></tr>`; return; }

      _adminActTotal = data.total || 0;
      const rows = data.activations || [];

      if(rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" class="text-center text-muted p-3">No hay activaciones para los filtros seleccionados</td></tr>';
        renderAdminActPagination();
        return;
      }

      tbody.innerHTML = rows.map(a => {
        const fecha      = a.activated_at ? new Date(a.activated_at).toLocaleString('es-ES', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '-';
        const partner    = escapeHTML(a.partner_name || '-');
        const voucher    = `<code>${escapeHTML(a.voucher_code||'')}</code>`;
        const cursoMoodle = a.moodle_course_id ? ` <small class="text-muted">#${a.moodle_course_id}</small>` : '';
        const curso      = `${escapeHTML(a.course_name||'-')}${cursoMoodle}`;
        const estudiante = `<div>${escapeHTML(a.user_name||'-')}</div><div class="small text-muted">${escapeHTML(a.user_email||'')}</div>`;
        const cliente    = escapeHTML(a.final_client||'-');
        let expiraBadge = '<span class="text-muted small">—</span>';
        if(a.expires_at){
          const expDate = new Date(a.expires_at);
          const isExpired = expDate < new Date();
          const expStr = expDate.toLocaleDateString('es-ES');
          expiraBadge = isExpired
            ? `<span class="badge bg-danger" title="Caducó el ${expStr}">⏰ Caducado</span><div class="small text-muted">${expStr}</div>`
            : `<span class="badge bg-success text-white">${expStr}</span>`;
        }
        const moodleBadge = moodleStatusBadge(a.moodle_status, a.moodle_error, a.moodle_completed_at);
        let moodleId = a.moodle_user_id ? `<small class="text-muted">${a.moodle_user_id}</small>` : '—';
        if(a.moodle_username) {
          moodleId += `<div class="small text-muted mt-1" title="Usuario Moodle">👤 ${escapeHTML(a.moodle_username)}</div>`;
        }
        if(a.moodle_temp_password) {
          moodleId += `<div class="small text-warning mt-1" title="Contraseña inicial (cambiar en primer acceso)">🔑 ${escapeHTML(a.moodle_temp_password)}</div>`;
        }

        let acciones = '—';
        const ms = (a.moodle_status || '').toUpperCase();
        if(ms === 'FAILED' || ms === 'PENDING') {
          acciones = `<button class="btn btn-xs btn-outline-warning py-0 px-1" style="font-size:0.75rem;" data-retry-id="${a.activation_id}" title="Reintentar matrícula Moodle">↺ Retry</button>`;
        }
        if(ms === 'FAILED' && a.moodle_error) {
          acciones += ` <span class="d-block small text-danger mt-1" style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHTML(a.moodle_error)}">${escapeHTML(a.moodle_error.slice(0,40))}…</span>`;
        }

        return `<tr>
          <td style="white-space:nowrap;">${fecha}</td>
          <td>${partner}</td>
          <td>${voucher}</td>
          <td>${curso}</td>
          <td>${estudiante}</td>
          <td>${cliente}</td>
          <td>${expiraBadge}</td>
          <td>${moodleBadge}</td>
          <td>${moodleId}</td>
          <td>${acciones}</td>
        </tr>`;
      }).join('');

      // Retry buttons
      tbody.querySelectorAll('[data-retry-id]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const actId = btn.dataset.retryId;
          btn.disabled = true;
          btn.textContent = '⏳';
          try {
            const r = await safeFetch(apiUrl.replace(':8080', ':8081') + `/admin/moodle/enrollments/${actId}/retry`, { method:'POST', headers: authHeaders() });
            const d = await safeJson(r);
            if(r.ok && d.ok) showToast(`Retry exitoso — estado: ${d.moodle_status}`, 'success');
            else             showToast(d.error || 'Error en retry', 'danger');
            loadAdminActivaciones(_adminActPage);
          } catch(e) {
            showToast('Error: ' + e.message, 'danger');
            btn.disabled = false;
            btn.textContent = '↺ Retry';
          }
        });
      });

      renderAdminActPagination();
    } catch(e) {
      tbody.innerHTML = `<tr><td colspan="9" class="text-center text-danger p-3">${escapeHTML(e.message)}</td></tr>`;
    }
  }

  function renderAdminActPagination() {
    const container = el('admin-activaciones-pagination');
    if(!container) return;
    const totalPages = Math.ceil(_adminActTotal / ACT_PAGE_SIZE);
    if(totalPages <= 1) { container.innerHTML = `<small class="text-muted">Total: ${_adminActTotal} activaciones</small>`; return; }
    let html = `<div class="d-flex align-items-center gap-3"><small class="text-muted">Total: ${_adminActTotal}</small><nav><ul class="pagination pagination-sm mb-0">`;
    html += `<li class="page-item ${_adminActPage===1?'disabled':''}"><a class="page-link" href="#" data-ap="${_adminActPage-1}">«</a></li>`;
    const start = Math.max(1, _adminActPage - 2);
    const end   = Math.min(totalPages, _adminActPage + 2);
    if(start > 1) html += `<li class="page-item disabled"><span class="page-link">…</span></li>`;
    for(let i = start; i <= end; i++) html += `<li class="page-item ${i===_adminActPage?'active':''}"><a class="page-link" href="#" data-ap="${i}">${i}</a></li>`;
    if(end < totalPages) html += `<li class="page-item disabled"><span class="page-link">…</span></li>`;
    html += `<li class="page-item ${_adminActPage===totalPages?'disabled':''}"><a class="page-link" href="#" data-ap="${_adminActPage+1}">»</a></li>`;
    html += '</ul></nav></div>';
    container.innerHTML = html;
    container.querySelectorAll('[data-ap]').forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        const p = parseInt(a.dataset.ap);
        if(p >= 1 && p <= totalPages) loadAdminActivaciones(p);
      });
    });
  }

  async function loadAdminActivacionesFilterOptions() {
    try {
      const [partnersResp, coursesResp] = await Promise.all([
        safeFetch(apiUrl.replace(':8080', ':8081') + '/admin/partners', { headers: authHeaders() }),
        safeFetch(apiUrl.replace(':8080', ':8081') + '/admin/courses',  { headers: authHeaders() })
      ]);
      const partners = await safeJson(partnersResp);
      const courses  = await safeJson(coursesResp);

      const pSel = el('admin-act-filter-partner');
      if(pSel && Array.isArray(partners)) {
        const opts = partners.map(p => `<option value="${p.id}">${escapeHTML(p.name)}</option>`).join('');
        pSel.innerHTML = '<option value="">Todos los partners</option>' + opts;
      }

      const cSel = el('admin-act-filter-course');
      if(cSel && Array.isArray(courses)) {
        const opts = courses.map(c => `<option value="${c.id}">${escapeHTML(c.name)}</option>`).join('');
        cSel.innerHTML = '<option value="">Todas las certificaciones</option>' + opts;
      }
    } catch(e) { /* filtros opcionales, no bloquear */ }
  }

  on('admin-activaciones-refresh',      'click', () => loadAdminActivaciones(1));
  on('admin-act-filter-btn',            'click', () => loadAdminActivaciones(1));
  on('admin-moodle-sync-completions',   'click', async (e) => {
    const btn = e.target;
    btn.disabled = true;
    const orig = btn.innerHTML;
    btn.innerHTML = '⏳ Sincronizando...';
    try {
      // El sync manual siempre fuerza (ignora ventana de 4 h) para reflejar cambios inmediatos
      const url   = apiUrl.replace(':8080', ':8081') + '/admin/moodle/sync-completions?force=true';
      const r = await safeFetch(url, { method: 'POST', headers: authHeaders() });
      const d = await safeJson(r);
      if(r.ok && d.ok) {
        showToast(`Sync completado — revisados: ${d.checked}, curso completado: ${d.course_completed ?? 0}, aprobados: ${d.completed}, errores: ${d.errors}`, 'success');
        loadAdminActivaciones(_adminActPage);
      } else {
        showToast(d.error || 'Error en sync', 'danger');
      }
    } catch(ex) {
      showToast('Error: ' + ex.message, 'danger');
    } finally {
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  });

  on('admin-audit-refresh', 'click', () => loadAdminAuditMovements(_adminAuditPage || 1));
  on('admin-audit-apply', 'click', () => loadAdminAuditMovements(1));
  on('admin-audit-export-csv', 'click', exportAdminAuditCsv);
  on('admin-audit-clear', 'click', () => {
    ['audit-filter-source','audit-filter-status','audit-filter-partner-id','audit-filter-purchase-id','audit-filter-start-date','audit-filter-end-date','audit-filter-search'].forEach(id => {
      const node = el(id);
      if(node) node.value = '';
    });
    loadAdminAuditMovements(1);
  });

  // ===== DASHBOARD =====
  let _dashboardLoadRequestId = 0;

  async function loadAdminDashboard(){
    const requestId = ++_dashboardLoadRequestId;
    const btn = el('btn-refresh-dashboard');
    if(btn) setButtonLoading(btn, true);
    try{
      const base = apiUrl.replace(':8080', ':8081');
      const hdrs = authHeaders();

      const fetchJsonSafe = async (url) => {
        try {
          const resp = await safeFetch(url, { headers: hdrs });
          let data = null;
          try {
            data = await safeJson(resp);
          } catch (parseError) {
            data = null;
          }
          return { ok: resp.ok, data };
        } catch (e) {
          return { ok: false, data: null };
        }
      };

      const [sumResult, monthlyResult, topPartnersResult, topCoursesResult] = await Promise.all([
        fetchJsonSafe(base + '/admin/reports/summary'),
        fetchJsonSafe(base + '/admin/reports/monthly'),
        fetchJsonSafe(base + '/admin/reports/top-partners?limit=10'),
        fetchJsonSafe(base + '/admin/reports/top-courses?limit=10')
      ]);

      // Ignora respuestas viejas si el usuario disparó otra carga después.
      if(requestId !== _dashboardLoadRequestId) return;

      const sum = sumResult.data || {};
      const monthly = monthlyResult.data || [];
      const topPartners = topPartnersResult.data || [];
      const topCourses = topCoursesResult.data || [];

      const s = sum.summary || sum || {};
      const fmt = n => isNaN(n) ? '—' : Number(n).toLocaleString('es-CL');
      const fmtMoney = n => isNaN(n) ? '—' : '$' + Number(n).toLocaleString('es-CL');
      if(el('dash-kpi-revenue'))       el('dash-kpi-revenue').textContent       = fmtMoney(s.paid_revenue || s.total_revenue || 0);
      if(el('dash-kpi-purchases'))     el('dash-kpi-purchases').textContent     = fmt(s.total_purchases || 0);
      if(el('dash-kpi-vouchers-sold')) el('dash-kpi-vouchers-sold').textContent = fmt(s.total_vouchers_sold || s.total_vouchers || 0);
      if(el('dash-kpi-vouchers-used')) el('dash-kpi-vouchers-used').textContent = fmt(s.consumed_vouchers || s.used_vouchers || 0);
      if(el('dash-kpi-activations'))   el('dash-kpi-activations').textContent   = fmt(s.total_activations || 0);
      if(el('dash-kpi-partners'))      el('dash-kpi-partners').textContent      = fmt(s.total_partners || s.active_partners || 0);
      if(el('dash-kpi-stripe-revenue'))   el('dash-kpi-stripe-revenue').textContent   = fmtMoney(s.stripe_revenue || 0);
      if(el('dash-kpi-external-revenue')) el('dash-kpi-external-revenue').textContent = fmtMoney(s.external_revenue || 0);
      if(el('dash-kpi-comp-vouchers'))    el('dash-kpi-comp-vouchers').textContent    = fmt(s.complimentary_vouchers || 0);
      const monthlyData = Array.isArray(monthly) ? monthly : (monthly.monthly || monthly.data || []);
      const monthBody = el('dash-monthly-body');
      if(monthBody){
        if(!monthlyData.length){
          monthBody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">Sin datos</td></tr>';
        } else {
          monthBody.innerHTML = monthlyData.map(r => `<tr>
            <td>${escapeHTML(String(r.month || ''))}</td>
            <td class="text-end">${fmtMoney(r.revenue || r.total_revenue || 0)}</td>
            <td class="text-end">${fmt(r.purchases || r.total_purchases || 0)}</td>
            <td class="text-end">${fmt(r.vouchers_sold || r.total_vouchers || 0)}</td>
            <td class="text-end">${fmt(r.activations || r.total_activations || 0)}</td>
          </tr>`).join('');
        }
      }
      const tpData = Array.isArray(topPartners) ? topPartners : (topPartners.top_partners || topPartners.data || []);
      const tpBody = el('dash-top-partners-body');
      if(tpBody){
        if(!tpData.length){
          tpBody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">Sin datos</td></tr>';
        } else {
          tpBody.innerHTML = tpData.map((r,i) => `<tr>
            <td>${i+1}</td>
            <td>${escapeHTML(r.partner_name || '-')}</td>
            <td class="text-end">${fmtMoney(r.total_revenue || 0)}</td>
            <td class="text-end">${fmt(r.total_purchases || 0)}</td>
          </tr>`).join('');
        }
      }
      const tcData = Array.isArray(topCourses) ? topCourses : (topCourses.top_courses || topCourses.data || []);
      const tcBody = el('dash-top-courses-body');
      if(tcBody){
        if(!tcData.length){
          tcBody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">Sin datos</td></tr>';
        } else {
          tcBody.innerHTML = tcData.map((r,i) => `<tr>
            <td>${i+1}</td>
            <td>${escapeHTML(r.course_name || r.course_id || '-')}</td>
            <td class="text-end">${fmt(r.total_activations || 0)}</td>
            <td class="text-end">${fmt(r.partners_count || r.total_vouchers || 0)}</td>
          </tr>`).join('');
        }
      }

      const failedBlocks = [sumResult, monthlyResult, topPartnersResult, topCoursesResult].filter(r => !r.ok).length;
      if(failedBlocks > 0){
        showLoginMessage(`Dashboard cargado parcialmente (${failedBlocks} bloque${failedBlocks > 1 ? 's' : ''} con error)`, 'warning', 2500);
      }
    } catch(e) {
      console.error('Error loading dashboard:', e);
      showLoginMessage('No se pudo cargar el dashboard. Intenta actualizar.', 'danger', 3000);
    } finally {
      if(requestId === _dashboardLoadRequestId && btn) setButtonLoading(btn, false);
    }
  }

  on('btn-refresh-dashboard', 'click', () => loadAdminDashboard());

  // ===== ROLES Y PERMISOS =====
  // Config dinámica de módulos y tipos cargada desde el backend
  let _rolesConfig = null;
  let _adminRoles  = [];

  async function loadRolesConfig() {
    if (_rolesConfig) return _rolesConfig;
    try {
      const resp = await safeFetch(apiUrl.replace(':8080', ':8081') + '/admin/roles/config', { headers: authHeaders() });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      _rolesConfig = await safeJson(resp);
    } catch(e) {
      console.error('❌ No se pudo cargar configuración de roles:', e.message);
      _rolesConfig = null;
    }
    return _rolesConfig;
  }

  // Devuelve los módulos visibles para un role_type dado
  function modulesForType(roleType) {
    if (!_rolesConfig || !Array.isArray(_rolesConfig.modules)) return [];
    return _rolesConfig.modules.filter(m => Array.isArray(m.types) && m.types.includes(roleType));
  }

  function renderPermTable(tbody, roleType, prefix, currentPerms = {}) {
    if (!tbody) return;
    const modules = modulesForType(roleType);
    if (!modules.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="text-center text-danger py-3 small">
        No se pudieron cargar los módulos. Recarga la página o reinicia el servicio.
      </td></tr>`;
      return;
    }
    tbody.innerHTML = modules.map(m => {
      const cur = currentPerms[m.key] || 'none';
      return `<tr>
        <td>${escapeHTML(moduleLabel(m))}</td>
        <td class="text-center"><input type="radio" name="${prefix}_${m.key}" value="none" ${cur==='none'?'checked':''}></td>
        <td class="text-center"><input type="radio" name="${prefix}_${m.key}" value="view" ${cur==='view'?'checked':''}></td>
        <td class="text-center"><input type="radio" name="${prefix}_${m.key}" value="edit" ${cur==='edit'?'checked':''}></td>
      </tr>`;
    }).join('');
  }

  const PERM_MODULE_ICONS = {
    dashboard: '🏠', purchases: '🛒', users: '👤', courses: '📚',
    pricing: '🏷️', stats: '📊', audit: '🧾', reports: '📈', financial_ops: '💰'
  };
  function moduleLabel(mod) {
    return (PERM_MODULE_ICONS[mod.key] || '') + ' ' + mod.label;
  }

  function ensureRoleOption(selectId, roleValue, roleLabel){
    const select = el(selectId);
    if(!select || !roleValue) return;
    if([...select.options].some(o => o.value === roleValue)) return;
    const option = document.createElement('option');
    option.value = roleValue;
    option.textContent = roleLabel || roleValue;
    select.appendChild(option);
  }

  function fillRoleSelect(selectId, currentValue = ''){
    const select = el(selectId);
    if(!select) return;
    const options = _adminRoles.map(r => `<option value="${escapeHTML(r.name)}">${escapeHTML(r.display_name || r.name)}</option>`).join('');
    select.innerHTML = options;
    if(currentValue) ensureRoleOption(selectId, currentValue, currentValue);
    select.value = currentValue || (_adminRoles[0] ? _adminRoles[0].name : '');
  }

  // ── POLÍTICA DE CONTRASEÑAS ─────────────────────────────
  async function loadPasswordPolicy(){
    const base = apiUrl.replace(':8080', ':8081');
    try {
      const resp = await safeFetch(base + '/admin/password-policy', { headers: authHeaders() });
      const data = await safeJson(resp);
      if(!resp.ok) return;
      const days = data.expiry_days || 0;
      // Sincronizar select con valor actual
      const presets = ['0','30','60','90','180','365'];
      const sel = el('policy-expiry-preset');
      if(sel){
        if(presets.includes(String(days))) sel.value = String(days);
        else if(days > 0){ sel.value = 'custom'; const ci = el('policy-expiry-custom'); if(ci){ ci.value = days; } const cw = el('policy-expiry-custom-wrap'); if(cw) cw.style.display = ''; }
        else sel.value = '0';
      }
      const display = el('policy-active-display');
      if(display) display.textContent = days === 0 ? 'Sin caducidad (contraseñas no expiran automáticamente)' : `Las contraseñas caducan cada ${days} días`;
    } catch(e){ /* silencioso */ }
  }

  on('btn-save-policy', 'click', async () => {
    const btn = el('btn-save-policy');
    setButtonLoading(btn, true);
    const msgEl = el('policy-msg');
    if(msgEl) msgEl.innerHTML = '';
    try {
      const presetSel = el('policy-expiry-preset');
      let days = 0;
      if(presetSel){
        if(presetSel.value === 'custom'){
          days = parseInt((el('policy-expiry-custom') || {}).value || '0') || 0;
          if(days < 1){ if(msgEl) msgEl.innerHTML = '<div class="alert alert-danger py-1 small mb-0">Ingresa un número de días válido (mínimo 1).</div>'; setButtonLoading(btn, false); return; }
        } else {
          days = parseInt(presetSel.value) || 0;
        }
      }
      const base = apiUrl.replace(':8080', ':8081');
      const resp = await safeFetch(base + '/admin/password-policy', { method:'PUT', headers: authHeaders(), body: JSON.stringify({ expiry_days: days }) });
      const data = await safeJson(resp);
      if(!resp.ok) throw new Error(data.error || 'Error al guardar');
      showToast(days === 0 ? 'Política actualizada: sin caducidad.' : `Política actualizada: contraseñas caducan cada ${days} días.`, 'success');
      const display = el('policy-active-display');
      if(display) display.textContent = days === 0 ? 'Sin caducidad (contraseñas no expiran automáticamente)' : `Las contraseñas caducan cada ${days} días`;
    } catch(e){
      if(msgEl) msgEl.innerHTML = `<div class="alert alert-danger py-1 small mb-0">${escapeHTML(e.message)}</div>`;
    } finally {
      setButtonLoading(btn, false);
    }
  });

  async function loadAdminActivationSettings(){
    try {
      const resp = await safeFetch(apiUrl.replace(':8080', ':8081') + '/admin/settings/activation', { headers: authHeaders() });
      if(!resp.ok) return;
      const data = await resp.json();
      const inp = el('max-activation-months-input');
      if(inp) inp.value = data.max_activation_months || 12;
      const msg = el('max-activation-months-msg');
      if(msg) msg.textContent = `Configuración actual: ${data.max_activation_months || 12} meses`;
    } catch(e){ /* silencioso */ }
  }

  on('btn-save-max-activation-months', 'click', async () => {
    const btn = el('btn-save-max-activation-months');
    const inp = el('max-activation-months-input');
    const msg = el('max-activation-months-msg');
    const months = parseInt((inp || {}).value || '12');
    if(!months || months < 1 || months > 120){
      if(msg) msg.innerHTML = '<span class="text-danger">Ingresa un valor entre 1 y 120 meses.</span>';
      return;
    }
    setButtonLoading(btn, true);
    try {
      const resp = await safeFetch(apiUrl.replace(':8080', ':8081') + '/admin/settings/activation', {
        method: 'PUT', headers: authHeaders(), body: JSON.stringify({ max_activation_months: months })
      });
      const data = await safeJson(resp);
      if(!resp.ok) throw new Error(data.error || 'Error al guardar');
      showToast(`Configuración actualizada: máximo ${months} meses de activación.`, 'success');
      if(msg) msg.innerHTML = `<span class="text-success">Configuración guardada: ${months} meses.</span>`;
    } catch(e){
      if(msg) msg.innerHTML = `<span class="text-danger">${escapeHTML(e.message)}</span>`;
    } finally {
      setButtonLoading(btn, false);
    }
  });

  async function loadAdminRoles(force = false){
    const token = getToken();
    if(!token){
      throw new Error('Sesión no disponible. Inicia sesión nuevamente.');
    }
    if(!force && _adminRoles.length) return _adminRoles;
    await loadRolesConfig();
    const resp = await safeFetch(apiUrl.replace(':8080', ':8081') + '/admin/roles', { headers: authHeaders() });
    const data = await safeJson(resp);
    if(!resp.ok) throw new Error(data.error || 'No se pudieron cargar roles');
    _adminRoles = Array.isArray(data) ? data : [];
    fillRoleSelect('admin-user-role');
    fillRoleSelect('edit-user-role');
    return _adminRoles;
  }

  function renderRolesList(){
    const container = el('roles-list-container');
    if(!container) return;
    if(!_adminRoles.length){
      container.innerHTML = '<div class="text-muted small p-3">Cargando roles...</div>';
      loadAdminRoles(true).then(() => renderRolesList()).catch((err) => {
        container.innerHTML = `<div class="alert alert-danger mb-0">No se pudieron cargar roles: ${escapeHTML(err.message || 'error desconocido')} <button id="roles-retry-btn" class="btn btn-sm btn-outline-danger ms-2">Reintentar</button></div>`;
        const retryBtn = el('roles-retry-btn');
        if(retryBtn) retryBtn.addEventListener('click', () => {
          loadAdminRoles(true).then(() => renderRolesList()).catch(()=>{});
        });
      });
      return;
    }
    const typeLabels = (_rolesConfig && _rolesConfig.type_labels) || { system_role: 'Sistema', client_role: 'Cliente' };
    container.innerHTML = `<div class="table-responsive"><table class="table table-hover align-middle">
      <thead style="font-size:0.78rem;text-transform:uppercase;letter-spacing:0.05em;background:rgba(249,115,22,0.06);">
        <tr><th>Rol</th><th>Nombre técnico</th><th>Tipo</th><th>Estado</th><th>Acciones</th></tr>
      </thead>
      <tbody>
        ${_adminRoles.map(r => {
          const curType = r.role_type || 'system_role';
          const typeLabel = typeLabels[curType] || curType;
          const typeBadge = curType === 'system_role'
            ? `<span class="badge bg-secondary">${escapeHTML(typeLabel)}</span>`
            : `<span class="badge bg-info text-white">${escapeHTML(typeLabel)}</span>`;
          return `<tr>
            <td><strong>${escapeHTML(r.display_name||r.name)}</strong></td>
            <td><code style="font-size:0.82rem;">${escapeHTML(r.name)}</code></td>
            <td>${typeBadge}</td>
            <td>${r.active ? '<span class="badge bg-success">Activo</span>' : '<span class="badge bg-danger">Inactivo</span>'}</td>
            <td class="d-flex gap-2 flex-wrap">
              <button class="btn btn-sm btn-outline-primary role-edit-btn"
                data-role-name="${escapeHTML(r.name)}"
                data-role-type="${escapeHTML(curType)}"
                data-role-display="${escapeHTML(r.display_name||r.name)}">
                ✏️ Editar
              </button>
              <button class="btn btn-sm btn-outline-secondary role-manage-btn"
                data-role-name="${escapeHTML(r.name)}"
                data-role-type="${escapeHTML(curType)}"
                data-role-display="${escapeHTML(r.display_name||r.name)}">
                🔐 Permisos
              </button>
              ${r.name === 'admin' ? '' : `<button class="btn btn-sm btn-outline-danger role-delete-btn"
                data-role-name="${escapeHTML(r.name)}"
                data-role-display="${escapeHTML(r.display_name||r.name)}">
                🗑️ Eliminar
              </button>`}
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table></div>`;

    container.querySelectorAll('.role-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const roleName    = btn.dataset.roleName;
        const roleType    = btn.dataset.roleType;
        const roleDisplay = btn.dataset.roleDisplay;
        const msgEl = el('edit-role-modal-msg');
        if (msgEl) msgEl.innerHTML = '';
        el('edit-role-name').value      = roleName;
        el('edit-role-technical').value = roleName;
        el('edit-role-display').value   = roleDisplay;
        el('edit-role-type').value      = roleType;
        bootstrap.Modal.getOrCreateInstance(document.getElementById('editRoleModal')).show();
      });
    });


    container.querySelectorAll('.role-manage-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const roleObj = _adminRoles.find(r => r.name === btn.dataset.roleName);
        if(roleObj) openPermissionsModal(roleObj.name, roleObj.permissions||{}, roleObj.role_type||'system_role', `Rol: ${roleObj.display_name||roleObj.name}`);
      });
    });

    container.querySelectorAll('.role-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const roleName    = btn.dataset.roleName;
        const roleDisplay = btn.dataset.roleDisplay;
        showConfirmAction({
          title: 'Eliminar Rol', icon: '🗑️',
          rows: [{ label: 'Rol:', value: roleDisplay }],
          confirmLabel: '🗑️ Eliminar', confirmClass: 'btn-danger',
          onConfirm: async () => {
            try {
              const resp = await safeFetch(
                apiUrl.replace(':8080', ':8081') + '/admin/roles/' + encodeURIComponent(roleName),
                { method: 'DELETE', headers: authHeaders() }
              );
              const data = await safeJson(resp);
              if(!resp.ok) throw new Error(data.error || 'No se pudo eliminar el rol');
              showToast(`Rol "${roleDisplay}" eliminado correctamente`, 'success');
              await loadAdminRoles(true);
              renderRolesList();
            } catch(e) {
              showToast(e.message, 'danger');
            }
          }
        });
      });
    });
  }

  function cleanupModalBackdrops() {
    document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
    document.body.classList.remove('modal-open');
    document.body.style.overflow = '';
    document.body.style.paddingRight = '';
  }

  // Resetear footer de confirmación al cerrar el modal de permisos
  const _permModalEl = document.getElementById('modalUserPermissions');
  if (_permModalEl) {
    _permModalEl.addEventListener('hidden.bs.modal', () => showPermConfirmFooter(false));
  }

  async function openPermissionsModal(roleName, permissions, roleType = 'system_role', contextLabel = ''){
    cleanupModalBackdrops();
    showPermConfirmFooter(false);
    el('perm-modal-role-name').value       = roleName;
    el('perm-modal-role-type').value       = roleType;
    el('perm-modal-user-info').textContent = contextLabel || `Rol: ${roleName}`;
    el('perm-modal-msg').innerHTML         = '';

    const typeLabels  = (_rolesConfig && _rolesConfig.type_labels) || { system_role: 'Sistema', client_role: 'Cliente' };
    const typeBadgeEl = el('perm-modal-role-type-badge');
    if (typeBadgeEl) {
      typeBadgeEl.textContent = typeLabels[roleType] || roleType;
      typeBadgeEl.className   = roleType === 'system_role' ? 'badge bg-secondary ms-2' : 'badge bg-info text-white ms-2';
    }

    await loadRolesConfig();
    renderPermTable(el('perm-modules-table'), roleType, 'perm', permissions || {});
    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalUserPermissions')).show();
  }

  function showPermConfirmFooter(show) {
    const normal  = el('perm-modal-footer-normal');
    const confirm = el('perm-modal-footer-confirm');
    if (normal)  normal.style.display  = show ? 'none' : '';
    if (confirm) confirm.style.display = show ? '' : 'none';
  }

  // "Guardar permisos" — muestra confirmación inline (sin segundo modal)
  on('btn-save-permissions', 'click', () => showPermConfirmFooter(true));
  on('btn-cancel-save-perms', 'click', () => showPermConfirmFooter(false));

  on('btn-do-save-perms', 'click', async () => {
    const btn      = el('btn-do-save-perms');
    const roleName = (el('perm-modal-role-name').value || '').trim();
    const roleType = (el('perm-modal-role-type') || {}).value || 'system_role';
    const msgEl    = el('perm-modal-msg');
    const permissions = {};
    modulesForType(roleType).forEach(m => {
      const checked = document.querySelector(`input[name="perm_${m.key}"]:checked`);
      permissions[m.key] = checked ? checked.value : 'none';
    });
    if (!Object.keys(permissions).length) {
      showToast('No hay módulos cargados. Recarga la página.', 'danger');
      showPermConfirmFooter(false);
      return;
    }
    try {
      setButtonLoading(btn, true);
      const resp = await safeFetch(
        apiUrl.replace(':8080', ':8081') + '/admin/roles/' + encodeURIComponent(roleName) + '/permissions',
        { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ permissions }) }
      );
      const data = await safeJson(resp);
      setButtonLoading(btn, false);
      showPermConfirmFooter(false);
      if(resp.ok){
        if(msgEl) msgEl.innerHTML = '<div class="alert alert-success py-1">Permisos guardados.</div>';
        showToast(`Permisos del rol "${roleName}" guardados correctamente`, 'success');
        bootstrap.Modal.getInstance(document.getElementById('modalUserPermissions'))?.hide();
        await loadAdminRoles(true);
        renderRolesList();
      } else {
        showToast(data.error || 'Error al guardar permisos', 'danger');
        if(msgEl) msgEl.innerHTML = `<div class="alert alert-danger py-1">${escapeHTML(data.error || 'Error al guardar')}</div>`;
      }
    } catch(e) {
      setButtonLoading(btn, false);
      showPermConfirmFooter(false);
      showToast('Error: ' + e.message, 'danger');
    }
  });

  // "Nuevo Rol" — abre modal con campos + permisos
  function buildNewRolePermTable(roleType = 'client_role'){
    renderPermTable(el('new-role-perm-table'), roleType, 'nr_perm');
  }

  on('btn-save-edit-role', 'click', async () => {
    const btn         = el('btn-save-edit-role');
    const msgEl       = el('edit-role-modal-msg');
    const roleName    = (el('edit-role-name')?.value || '').trim();
    const displayName = (el('edit-role-display')?.value || '').trim();
    const roleType    = el('edit-role-type')?.value || 'system_role';
    if (msgEl) msgEl.innerHTML = '';
    if (!displayName) {
      if (msgEl) msgEl.innerHTML = '<div class="alert alert-danger py-2">El nombre visible es obligatorio.</div>';
      return;
    }
    setButtonLoading(btn, true);
    try {
      const resp = await safeFetch(
        apiUrl.replace(':8080', ':8081') + '/admin/roles/' + encodeURIComponent(roleName),
        { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ display_name: displayName, role_type: roleType }) }
      );
      const data = await safeJson(resp);
      if (!resp.ok) throw new Error(data.error || 'Error al guardar');
      setButtonLoading(btn, false);
      bootstrap.Modal.getInstance(document.getElementById('editRoleModal'))?.hide();
      showToast(`Rol "${displayName}" actualizado correctamente`, 'success');
      await loadAdminRoles(true);
      renderRolesList();
    } catch(e) {
      setButtonLoading(btn, false);
      if (msgEl) msgEl.innerHTML = `<div class="alert alert-danger py-2">${escapeHTML(e.message)}</div>`;
    }
  });

  on('btn-open-create-role', 'click', async () => {
    const msgEl = el('create-role-modal-msg');
    if(msgEl) msgEl.innerHTML = '';
    await loadRolesConfig();
    if (!_rolesConfig) {
      if(msgEl) msgEl.innerHTML = '<div class="alert alert-danger py-2">No se pudo cargar la configuración de módulos. Reinicia el servicio e intenta de nuevo.</div>';
      bootstrap.Modal.getOrCreateInstance(document.getElementById('createRoleModal')).show();
      return;
    }
    const typeEl = el('new-role-type');
    if (typeEl) typeEl.value = 'client_role';
    buildNewRolePermTable('client_role');
    if(el('new-role-name')) el('new-role-name').value = '';
    if(el('new-role-display-name')) el('new-role-display-name').value = '';
    bootstrap.Modal.getOrCreateInstance(document.getElementById('createRoleModal')).show();
  });

  // Reconstruir tabla de permisos al cambiar el tipo
  on('new-role-type', 'change', () => {
    const roleType = (el('new-role-type') || {}).value || 'client_role';
    buildNewRolePermTable(roleType);
  });

  on('btn-confirm-create-role', 'click', async () => {
    const btn = el('btn-confirm-create-role');
    const msgEl = el('create-role-modal-msg');
    const roleName    = ((el('new-role-name')||{}).value||'').trim().toLowerCase();
    const displayName = ((el('new-role-display-name')||{}).value||'').trim();
    const roleType    = ((el('new-role-type')||{}).value||'client_role');
    if(!roleName || !displayName){
      if(msgEl) msgEl.innerHTML = '<div class="alert alert-danger py-2">Completa el nombre técnico y el nombre visible.</div>';
      return;
    }
    if (!_rolesConfig) {
      if(msgEl) msgEl.innerHTML = '<div class="alert alert-danger py-2">Configuración de módulos no cargada. Recarga la página.</div>';
      return;
    }
    const permissions = {};
    modulesForType(roleType).forEach(m => {
      const checked = document.querySelector(`input[name="nr_perm_${m.key}"]:checked`);
      permissions[m.key] = checked ? checked.value : 'none';
    });
    try {
      setButtonLoading(btn, true);
      const resp = await safeFetch(apiUrl.replace(':8080', ':8081') + '/admin/roles', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ name: roleName, display_name: displayName, role_type: roleType, permissions })
      });
      const data = await safeJson(resp);
      if(!resp.ok){ setButtonLoading(btn, false); if(msgEl) msgEl.innerHTML = `<div class="alert alert-danger py-2">${escapeHTML(data.error||'No se pudo crear el rol')}</div>`; return; }
      setButtonLoading(btn, false);
      bootstrap.Modal.getInstance(document.getElementById('createRoleModal')).hide();
      showToast(`Rol "${displayName}" (${roleType === 'system_role' ? 'Sistema' : 'Cliente'}) creado`, 'success');
      await loadAdminRoles(true);
      renderRolesList();
    } catch(e) {
      setButtonLoading(btn, false);
      if(msgEl) msgEl.innerHTML = `<div class="alert alert-danger py-2">${escapeHTML(e.message)}</div>`;
    }
  });

  on('admin-user-role', 'change', () => {
    const note = el('new-user-partner-pricing-note');
    if (note) note.style.display = (el('admin-user-role') || {}).value === 'partner' ? '' : 'none';
  });

  on('create-user', 'click', async () => {
    const firstName = ((el('admin-user-first-name') || {}).value || '').trim();
    const lastName  = ((el('admin-user-last-name')  || {}).value || '').trim();
    const email     = (el('admin-user-email')    || {}).value || '';
    const password  = (el('admin-user-password') || {}).value || '';
    const role      = (el('admin-user-role')     || {}).value || 'user';
    clearAdminUserMessage();
    if(!email || !password){ showLoginMessage('Completa email y contraseña', 'danger', 3000); return; }
    const expirySelect = (el('new-user-expiry-days') || {}).value || '0';
    let passwordExpiresDays = 0;
    if(expirySelect === 'none')        passwordExpiresDays = -1;
    else if(expirySelect === 'custom') passwordExpiresDays = parseInt((el('new-user-expiry-custom') || {}).value || '0') || 0;
    else                               passwordExpiresDays = parseInt(expirySelect) || 0;
    const expiryLabel = expirySelect === '0' ? 'Política global' : expirySelect === 'none' ? 'Sin caducidad' : expirySelect === 'custom' ? `${passwordExpiresDays} días` : `${expirySelect} días`;

    showConfirmAction({
      title: 'Crear Nuevo Usuario', icon: '👤',
      rows: [
        { label: 'Nombre completo:', value: [firstName, lastName].filter(Boolean).join(' ') || '—' },
        { label: 'Email:', value: email },
        { label: 'Rol:', value: role },
        { label: 'Caducidad contraseña:', value: expiryLabel },
        { label: 'Primer inicio:', value: 'Deberá cambiar contraseña' }
      ],
      confirmLabel: '✓ Crear Usuario', confirmClass: 'btn-primary',
      onConfirm: async () => {
    const btn = el('create-user');
    try{
      await loadAdminRoles();
      setButtonLoading(btn, true);
      const payload = { email, password, role, must_change_password: true };
      if(firstName) payload.first_name = firstName;
      if(lastName)  payload.last_name  = lastName;
      if(passwordExpiresDays !== 0) payload.password_expires_days = passwordExpiresDays < 0 ? 0 : passwordExpiresDays;
      const resp = await safeFetch(apiUrl.replace(':8080', ':8081') + '/admin/users', { method:'POST', headers: authHeaders(), body: JSON.stringify(payload) });

      let data = {};
      try {
        data = await resp.json();
      } catch(jsonError) {
        console.error('Error parsing JSON:', jsonError);
      }

      setButtonLoading(btn, false);
      if(resp.ok){
        clearAdminUserMessage();
        showToast('Usuario creado correctamente. Deberá cambiar su contraseña al primer inicio.', 'success');
        if(el('admin-user-first-name'))      el('admin-user-first-name').value = '';
        if(el('admin-user-last-name'))       el('admin-user-last-name').value  = '';
        if(el('new-user-expiry-days'))       el('new-user-expiry-days').value  = '0';
        if(el('new-user-expiry-custom'))     el('new-user-expiry-custom').value = '';
        if(el('new-user-expiry-custom-wrap')) el('new-user-expiry-custom-wrap').style.display = 'none';
        if(el('new-user-expiry-info'))       el('new-user-expiry-info').textContent = '';
        el('admin-user-email').value = '';
        el('admin-user-password').value = '';
        const newUserModalEl = document.getElementById('newUserModal');
        if(newUserModalEl){ const m = bootstrap.Modal.getInstance(newUserModalEl); if(m) m.hide(); }
        const listBtn = el('list-users');
        if(listBtn) listBtn.click();
      } else {
        let errorMsg = data.error || 'No se pudo crear el usuario';
        if(data.details && Array.isArray(data.details)) {
          const validationErrors = data.details.map(err => `• ${escapeHTML(err.msg || 'Dato inválido')}`).join('<br>');
          errorMsg = `<strong>Errores de validación:</strong><br>${validationErrors}`;
        }
        showAdminUserMessage(errorMsg, 'danger');
      }
    }catch(e){
      setButtonLoading(btn, false);
      showAdminUserMessage('Error: ' + escapeHTML(e.message), 'danger');
    }
      } // end onConfirm
    }); // end showConfirmAction
  });

  // Colores de avatar por rol
  const ROLE_AVATAR_COLORS = {
    admin: '#1e3a5f', gerente: '#3b1a78', partner: '#14532d',
    supervisor: '#134e4a', 'op.tanqueo': '#78350f', 'op.viajes': '#1c3347'
  };
  function avatarColor(role){ return ROLE_AVATAR_COLORS[(role||'').toLowerCase()] || '#374151'; }
  function roleBadgeClass(role){
    const r = (role||'').toLowerCase();
    if(r === 'admin') return 'role-admin';
    if(r === 'gerente') return 'role-gerente';
    if(r === 'partner') return 'role-partner';
    if(r === 'supervisor') return 'role-supervisor';
    if(r.includes('tanqueo')) return 'role-op-tanqueo';
    if(r.includes('viajes')) return 'role-op-viajes';
    return 'role-default';
  }
  function formatDate(d){ if(!d) return '—'; try{ return new Date(d).toLocaleDateString('es-ES',{day:'2-digit',month:'short',year:'numeric'}); }catch(e){ return d; } }

  let _allUsersData = [];

  function filterAndRenderUsers(){
    const search = ((el('users-search-input')||{}).value||'').toLowerCase();
    const roleFilter = ((el('users-role-filter')||{}).value||'').toLowerCase();
    let filtered = _allUsersData;
    if(search) filtered = filtered.filter(u => {
      const name = ((u.first_name||'')+' '+(u.last_name||'')).toLowerCase();
      const email = (u.email||'').toLowerCase();
      return name.includes(search) || email.includes(search);
    });
    if(roleFilter) filtered = filtered.filter(u => (u.role||'').toLowerCase() === roleFilter);
    renderUsersTable(filtered);
    const showingLabel = el('users-showing-label');
    if(showingLabel) showingLabel.textContent = filtered.length < _allUsersData.length
      ? `Mostrando ${filtered.length} de ${_allUsersData.length} usuarios`
      : `Mostrando ${filtered.length} de ${filtered.length} usuarios`;
  }

  function renderUsersTable(data){
    const tbody = el('users-table-body');
    if(!tbody) return;
    if(!data.length){
      tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted p-4">No hay usuarios que coincidan</td></tr>';
      return;
    }
    tbody.innerHTML = data.map(u => {
      const safeFirst  = escapeHTML(u.first_name || '');
      const safeLast   = escapeHTML(u.last_name  || '');
      const fullName   = [safeFirst, safeLast].filter(Boolean).join(' ') || escapeHTML(u.email || '');
      const initials   = (safeFirst.charAt(0) + safeLast.charAt(0)).toUpperCase() || (u.email||'?').substring(0,2).toUpperCase();
      const safeEmail  = escapeHTML(u.email || '');
      const safeRole   = escapeHTML(u.role  || '');
      const roleDisplay = escapeHTML((_adminRoles.find(r=>r.name===u.role)||{}).display_name || u.role || '');
      const userId     = escapeHTML(String(u.id || ''));
      const rawPartnerId = u.partner_id ? String(u.partner_id) : '';
      const isActive   = u.active !== false;
      const mustChange = u.must_change_password;
      const since      = formatDate(u.created_at);
      const permData   = escapeHTML(JSON.stringify(u.role_permissions || {}));
      const bgColor    = avatarColor(u.role);
      const badgeClass = roleBadgeClass(u.role);
      // Calcular estado de caducidad
      const now = new Date();
      const expiresAt = u.password_expires_at ? new Date(u.password_expires_at) : null;
      const isExpired  = expiresAt && expiresAt < now;
      const daysLeft   = expiresAt && !isExpired ? Math.ceil((expiresAt - now) / 86400000) : null;
      const expiryBadge = isExpired
        ? '<div class="status-badge-expired">Contraseña expirada</div>'
        : daysLeft !== null && daysLeft <= 15
          ? `<div class="status-badge-warn">Caduca en ${daysLeft}d</div>`
          : '';
      const statusHtml = isActive
        ? `<div class="status-dot">Activo</div>${mustChange ? '<div class="status-badge-warn">Cambio pendiente</div>' : ''}${expiryBadge}`
        : `<div class="status-dot inactive" style="color:#ef4444;">Inactivo</div>`;
      const toggleLabel = isActive ? 'Desactivar' : 'Activar';
      const toggleClass = isActive ? 'btn-outline-warning' : 'btn-outline-success';
      return `<tr>
        <td>
          <div class="d-flex align-items-center gap-2">
            <div class="user-avatar" style="background:${bgColor};">${initials}</div>
            <div>
              <div class="fw-semibold" style="font-size:0.9rem;">${fullName}</div>
              <div class="text-muted" style="font-size:0.78rem;">${safeEmail}</div>
            </div>
          </div>
        </td>
        <td><span class="role-badge ${badgeClass}">${roleDisplay || safeRole}</span></td>
        <td>${statusHtml}</td>
        <td style="font-size:0.85rem;color:var(--muted);">${since}</td>
        <td>
          <div class="d-flex gap-1 flex-wrap">
            <button class="btn btn-sm btn-outline-primary edit-user-btn"
              data-user-id="${userId}" data-user-email="${safeEmail}" data-user-role="${safeRole}"
              data-user-partner-id="${escapeHTML(rawPartnerId)}"
              data-user-first-name="${safeFirst}" data-user-last-name="${safeLast}">✏️ Editar</button>
            <button class="btn btn-sm ${toggleClass} toggle-user-btn"
              data-user-id="${userId}" data-user-email="${safeEmail}" data-user-name="${fullName}"
              data-user-active="${isActive}" data-user-role="${safeRole}">${toggleLabel}</button>
            <button class="btn btn-sm btn-outline-secondary force-change-btn"
              data-user-id="${userId}" data-user-name="${fullName}" data-user-email="${safeEmail}">🔑 Forzar cambio</button>
            <button class="btn btn-sm btn-outline-danger delete-user-btn"
              data-user-id="${userId}" data-user-email="${safeEmail}" data-user-name="${fullName}"
              data-user-role="${safeRole}">🗑️ Eliminar</button>
          </div>
        </td>
      </tr>`;
    }).join('');
    attachUserTableEvents();
  }

  function attachUserTableEvents(){
    document.querySelectorAll('.edit-user-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        openEditUserModal(btn.dataset.userId, btn.dataset.userEmail, btn.dataset.userRole,
          btn.dataset.userPartnerId||'', btn.dataset.userFirstName||'', btn.dataset.userLastName||'');
      });
    });
    document.querySelectorAll('.toggle-user-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const isActive = btn.dataset.userActive === 'true';

        // Protección: no desactivar si es el último admin activo
        if (isActive && btn.dataset.userRole === 'admin') {
          const activeAdmins = _allUsersData.filter(u => u.role === 'admin' && u.active !== false);
          if (activeAdmins.length <= 1) {
            showToast('⚠️ No puedes desactivar al único administrador activo del sistema. Crea otro admin primero.', 'danger', 4000);
            return;
          }
        }

        const title = isActive ? 'Desactivar usuario' : 'Activar usuario';
        const text = isActive
          ? `¿Desactivar a <strong>${escapeHTML(btn.dataset.userName||btn.dataset.userEmail)}</strong>? No podrá iniciar sesión.`
          : `¿Activar a <strong>${escapeHTML(btn.dataset.userName||btn.dataset.userEmail)}</strong>? Podrá volver a iniciar sesión.`;
        el('toggleUserModalTitle').textContent = title;
        el('toggleUserModalText').innerHTML = text;
        el('toggle-user-id').value = btn.dataset.userId;
        el('toggle-user-active').value = String(!isActive);
        const btnConfirm = el('btn-confirm-toggle-user');
        if(btnConfirm) btnConfirm.className = isActive ? 'btn btn-warning' : 'btn btn-success';
        bootstrap.Modal.getOrCreateInstance(document.getElementById('toggleUserModal')).show();
      });
    });
    document.querySelectorAll('.force-change-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const info = el('force-change-user-info');
        if(info) info.textContent = `${btn.dataset.userName||''} — ${btn.dataset.userEmail||''}`;
        el('force-change-user-id').value = btn.dataset.userId;
        bootstrap.Modal.getOrCreateInstance(document.getElementById('forceChangeModal')).show();
      });
    });
    document.querySelectorAll('.delete-user-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        // Protección: no eliminar si es el último admin activo
        if (btn.dataset.userRole === 'admin') {
          const activeAdmins = _allUsersData.filter(u => u.role === 'admin' && u.active !== false);
          if (activeAdmins.length <= 1) {
            showToast('⚠️ No puedes eliminar al único administrador del sistema. Crea otro admin primero.', 'danger', 4000);
            return;
          }
        }
        const info = el('delete-user-info');
        if(info) info.textContent = `${btn.dataset.userName||''} — ${btn.dataset.userEmail||''}`;
        el('delete-user-id').value = btn.dataset.userId;
        bootstrap.Modal.getOrCreateInstance(document.getElementById('deleteUserModal')).show();
      });
    });
  }

  // Btn open new user modal
  // Selector de caducidad en modal nuevo usuario
  document.addEventListener('change', ev => {
    const sel = ev.target;
    if(sel.id !== 'new-user-expiry-days') return;
    const customWrap = el('new-user-expiry-custom-wrap');
    const info       = el('new-user-expiry-info');
    if(sel.value === 'custom'){
      if(customWrap) customWrap.style.display = '';
    } else {
      if(customWrap) customWrap.style.display = 'none';
    }
    if(info){
      if(sel.value === '0')      info.textContent = 'Se aplicará la caducidad configurada en la política global del sistema.';
      else if(sel.value === 'none') info.textContent = 'La contraseña no caducará para este usuario.';
      else if(sel.value === 'custom') info.textContent = '';
      else info.textContent = `La contraseña caducará a los ${sel.value} días del primer inicio de sesión.`;
    }
  });

  // Selector de caducidad en política global
  document.addEventListener('change', ev => {
    const sel = ev.target;
    if(sel.id !== 'policy-expiry-preset') return;
    const wrap = el('policy-expiry-custom-wrap');
    if(wrap) wrap.style.display = sel.value === 'custom' ? '' : 'none';
  });

  on('btn-open-new-user', 'click', () => {
    loadAdminRoles(true).catch(()=>{});
    // Resetear validador al abrir
    const pwdInput = el('admin-user-password');
    if(pwdInput) { pwdInput.value = ''; pwdInput.dispatchEvent(new Event('input')); }
    bootstrap.Modal.getOrCreateInstance(document.getElementById('newUserModal')).show();
  });

  // Validador de contraseña en tiempo real
  (function setupPasswordValidator() {
    const input   = el('admin-user-password');
    const rulesEl = el('admin-user-password-rules');
    const createBtn = el('create-user');
    if (!input || !rulesEl) return;

    const rules = [
      { id: 'pwd-rule-length',  test: v => v.length >= 8,            label: 'Mínimo 8 caracteres' },
      { id: 'pwd-rule-upper',   test: v => /[A-Z]/.test(v),          label: 'Al menos una mayúscula' },
      { id: 'pwd-rule-lower',   test: v => /[a-z]/.test(v),          label: 'Al menos una minúscula' },
      { id: 'pwd-rule-number',  test: v => /[0-9]/.test(v),          label: 'Al menos un número' },
      { id: 'pwd-rule-special', test: v => /[!@#$%^&*]/.test(v),     label: 'Al menos un carácter especial' }
    ];

    const strengthBar  = el('admin-user-pwd-strength-bar');
    const strengthLabel = el('pwd-strength-label');
    const bars = [1,2,3,4,5].map(i => document.getElementById('pwd-bar-' + i));

    const LEVELS = [
      { min: 0, max: 0, label: '',        color: '#e9ecef' },
      { min: 1, max: 1, label: 'Débil',   color: '#ef4444' },
      { min: 2, max: 2, label: 'Débil',   color: '#ef4444' },
      { min: 3, max: 3, label: 'Regular', color: '#f97316' },
      { min: 4, max: 4, label: 'Buena',   color: '#3b82f6' },
      { min: 5, max: 5, label: 'Fuerte',  color: '#22c55e' }
    ];

    input.addEventListener('input', () => {
      const val = input.value;
      const hasValue = val.length > 0;
      rulesEl.style.display = hasValue ? '' : 'none';
      if (strengthBar) strengthBar.style.display = hasValue ? '' : 'none';

      let passed = 0;
      let allOk = true;
      rules.forEach(rule => {
        const ok = rule.test(val);
        if (ok) passed++; else allOk = false;
        const li = document.getElementById(rule.id);
        if (!li) return;
        const icon = li.querySelector('.rule-icon');
        if (icon) icon.textContent = ok ? '✅' : '❌';
        li.style.color = ok ? '#198754' : '#6c757d';
      });

      // Actualizar barra de fuerza
      const level = LEVELS[passed] || LEVELS[0];
      bars.forEach((bar, i) => {
        if (bar) bar.style.background = i < passed ? level.color : '#e9ecef';
      });
      if (strengthLabel) {
        strengthLabel.textContent = level.label;
        strengthLabel.style.color = level.color;
      }

      // Deshabilitar botón hasta que todos los requisitos se cumplan
      if (createBtn) {
        createBtn.disabled = !allOk;
        createBtn.title = allOk ? '' : 'Completa todos los requisitos de contraseña';
      }
    });
  })();

  // Search/filter
  ['users-search-input','users-role-filter'].forEach(id => {
    const el2 = el(id);
    if(el2) el2.addEventListener('input', filterAndRenderUsers);
  });

  // Confirm deactivate/activate
  on('btn-confirm-toggle-user', 'click', async () => {
    const btn = el('btn-confirm-toggle-user');
    const userId = (el('toggle-user-id')||{}).value;
    const newActive = (el('toggle-user-active')||{}).value === 'true';
    if(!userId) return;
    try{
      setButtonLoading(btn, true);
      const resp = await safeFetch(apiUrl.replace(':8080', ':8081') + `/admin/users/${userId}`, {
        method:'PUT', headers: authHeaders(), body: JSON.stringify({ active: newActive })
      });
      setButtonLoading(btn, false);
      const data = await resp.json();
      if(resp.ok){
        bootstrap.Modal.getInstance(document.getElementById('toggleUserModal')).hide();
        showToast(newActive ? 'Usuario activado' : 'Usuario desactivado', 'success');
        el('list-users').click();
      } else {
        showToast('Error: ' + (data.error||'No se pudo actualizar'), 'danger');
      }
    }catch(e){
      setButtonLoading(btn, false);
      showLoginMessage('Error: ' + e.message, 'danger', 3000);
    }
  });

  // Confirm force password change
  on('btn-confirm-force-change', 'click', async () => {
    const btn = el('btn-confirm-force-change');
    const userId = (el('force-change-user-id')||{}).value;
    if(!userId) return;
    try{
      setButtonLoading(btn, true);
      const resp = await safeFetch(apiUrl.replace(':8080', ':8081') + `/admin/users/${userId}`, {
        method:'PUT', headers: authHeaders(), body: JSON.stringify({ must_change_password: true })
      });
      setButtonLoading(btn, false);
      const data = await resp.json();
      if(resp.ok){
        bootstrap.Modal.getInstance(document.getElementById('forceChangeModal')).hide();
        showToast('Se forzará el cambio de contraseña en el próximo login', 'success');
        el('list-users').click();
      } else {
        showLoginMessage('Error: ' + (data.error||'No se pudo actualizar'), 'danger', 3000);
      }
    }catch(e){
      setButtonLoading(btn, false);
      showLoginMessage('Error: ' + e.message, 'danger', 3000);
    }
  });

  // Confirm delete
  on('btn-confirm-delete-user', 'click', async () => {
    const btn = el('btn-confirm-delete-user');
    const userId = (el('delete-user-id')||{}).value;
    if(!userId) return;
    try{
      setButtonLoading(btn, true);
      await deleteUser(userId);
      setButtonLoading(btn, false);
      bootstrap.Modal.getInstance(document.getElementById('deleteUserModal')).hide();
    }catch(e){
      setButtonLoading(btn, false);
      showLoginMessage('Error: ' + e.message, 'danger', 3000);
    }
  });

  on('list-users', 'click', async () => {
    const btn = el('list-users');
    try{
      setButtonLoading(btn, true);
      const resp = await safeFetch(apiUrl.replace(':8080', ':8081') + '/admin/users', { headers: authHeaders() });
      const data = await resp.json();
      setButtonLoading(btn, false);
      if(!Array.isArray(data)){
        showLoginMessage('Error al cargar usuarios', 'danger', 3000);
        return;
      }
      _allUsersData = data;
      // Populate role filter
      const roleFilter = el('users-role-filter');
      if(roleFilter){
        const currentVal = roleFilter.value;
        const uniqueRoles = [...new Set(data.map(u => u.role).filter(Boolean))];
        roleFilter.innerHTML = '<option value="">Todos los roles</option>' +
          uniqueRoles.map(r => {
            const display = escapeHTML((_adminRoles.find(x=>x.name===r)||{}).display_name || r);
            return `<option value="${escapeHTML(r)}">${display}</option>`;
          }).join('');
        roleFilter.value = currentVal;
      }
      const active = data.filter(u => u.active !== false).length;
      const countLabel = el('users-count-label');
      if(countLabel) countLabel.textContent = `${data.length} registrados · ${active} activos`;
      filterAndRenderUsers();
    }catch(e){
      setButtonLoading(btn, false);
      showLoginMessage('Error: ' + e.message, 'danger', 3000);
    }
  });

  // Funciones para gestión de usuarios
  function openEditUserModal(userId, email, role, partnerId = '', firstName = '', lastName = ''){
    ensureRoleOption('edit-user-role', role, role);
    if(el('edit-user-first-name')) el('edit-user-first-name').value = firstName;
    if(el('edit-user-last-name'))  el('edit-user-last-name').value  = lastName;
    el('edit-user-email').value    = email;
    el('edit-user-password').value = '';
    el('edit-user-role').value     = role;
    el('edit-user-message').innerHTML = '';

    el('save-user-changes').dataset.userId           = userId;
    el('save-user-changes').dataset.currentRole      = role      || '';
    el('save-user-changes').dataset.originalFirstName = firstName || '';
    el('save-user-changes').dataset.originalLastName  = lastName  || '';

    const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('editUserModal'));
    modal.show();
  }

  on('save-user-changes', 'click', async () => {
    const btn = el('save-user-changes');
    const userId    = btn.dataset.userId;
    const firstName = (el('edit-user-first-name') ? el('edit-user-first-name').value.trim() : '');
    const lastName  = (el('edit-user-last-name')  ? el('edit-user-last-name').value.trim()  : '');
    const password  = el('edit-user-password').value || '';
    const newRole   = el('edit-user-role').value || '';
    const originalFirstName = btn.dataset.originalFirstName || '';
    const originalLastName  = btn.dataset.originalLastName  || '';
    const messageEl = el('edit-user-message');

    const nameChanged = firstName !== originalFirstName || lastName !== originalLastName;
    if(!password && !newRole && !nameChanged){
      messageEl.innerHTML = '<div class="alert alert-warning">No hay cambios para guardar</div>';
      return;
    }

    const changes = [];
    if (nameChanged)  changes.push({ label: 'Nombre completo:', value: [firstName, lastName].filter(Boolean).join(' ') });
    if (newRole)      changes.push({ label: 'Nuevo rol:', value: newRole });
    if (password)     changes.push({ label: 'Contraseña:', value: '(nueva contraseña)' });

    showConfirmAction({
      title: 'Guardar cambios de usuario', icon: '✏️',
      rows: [{ label: 'Usuario ID:', value: '#' + userId }, ...changes],
      confirmLabel: '✓ Guardar cambios', confirmClass: 'btn-primary',
      onConfirm: async () => {
    try{
      setButtonLoading(btn, true);
      const payload = {};
      if(password) payload.password = password;
      if(newRole)  payload.role = newRole;
      if(nameChanged){ payload.first_name = firstName; payload.last_name = lastName; }
      
      const resp = await fetch(apiUrl.replace(':8080', ':8081') + `/admin/users/${userId}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify(payload)
      });
      
      const data = await resp.json();
      setButtonLoading(btn, false);
      
      if(resp.ok){
        showToast('Usuario actualizado correctamente', 'success');
        messageEl.innerHTML = '<div class="alert alert-success">✓ Usuario actualizado correctamente</div>';
        setTimeout(() => {
          bootstrap.Modal.getInstance(document.getElementById('editUserModal')).hide();
          const listBtn = el('list-users');
          if(listBtn) listBtn.click();
        }, 1500);
      } else {
        messageEl.innerHTML = `<div class="alert alert-danger">Error: ${escapeHTML(data.error || 'No se pudo actualizar')}</div>`;
      }
    }catch(e){
      setButtonLoading(btn, false);
      messageEl.innerHTML = `<div class="alert alert-danger">Error: ${escapeHTML(e.message)}</div>`;
    }
      } // end onConfirm
    }); // end showConfirmAction
  });

  async function deleteUser(userId){
    try{
      const resp = await fetch(apiUrl.replace(':8080', ':8081') + `/admin/users/${userId}`, {
        method: 'DELETE',
        headers: authHeaders()
      });
      
      const data = await resp.json();
      if(resp.ok){
        showToast('Usuario eliminado correctamente', 'success');
        const listBtn = el('list-users');
        if(listBtn) listBtn.click();
      } else {
        showToast('Error: ' + (data.error || 'No se pudo eliminar'), 'danger');
      }
    }catch(e){
      showLoginMessage('Error: ' + e.message, 'danger', 3000);
    }
  }

  if(getToken()){
    loadAdminRoles().catch(() => {});
  }

  let _adminVouchersAllData = [];
  let _adminVouchersData    = [];
  let _adminVouchersPage    = 1;
  const ADMIN_VOUCHERS_PAGE_SIZE = 10;

  function renderAdminVouchersPage(page){
    _adminVouchersPage = page || 1;
    const tbody = el('admin-vouchers-tbody');
    if(!tbody) return;
    if(!_adminVouchersData.length){
      tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted p-3">Sin vouchers para los criterios seleccionados</td></tr>';
      renderAdminVouchersPagination();
      return;
    }
    const start = (_adminVouchersPage - 1) * ADMIN_VOUCHERS_PAGE_SIZE;
    const pageData = _adminVouchersData.slice(start, start + ADMIN_VOUCHERS_PAGE_SIZE);
    tbody.innerHTML = pageData.map(v => {
      const status = (v.status || '').toUpperCase();
      let badge;
      if(status === 'CONSUMED')       badge = '<span class="badge bg-secondary">Consumido</span>';
      else if(status === 'AVAILABLE') badge = '<span class="badge bg-success">Disponible</span>';
      else                            badge = `<span class="badge bg-light text-dark">${escapeHTML(v.status || '')}</span>`;
      const created    = v.created_at  ? new Date(v.created_at).toLocaleDateString('es-ES')  : '-';
      const consumedAt = v.consumed_at ? new Date(v.consumed_at).toLocaleDateString('es-ES') : '-';
      return `<tr>
        <td><code>${escapeHTML(v.code || '')}</code></td>
        <td>${badge}</td>
        <td>${escapeHTML(v.course_name || '-')}</td>
        <td>${escapeHTML(v.consumed_by || '-')}</td>
        <td>${escapeHTML(v.final_client || '-')}</td>
        <td>${consumedAt}</td>
        <td>${escapeHTML(String(v.purchase_id || '-'))}</td>
        <td>${created}</td>
      </tr>`;
    }).join('');
    renderAdminVouchersPagination();
  }

  function renderAdminVouchersPagination(){
    const container = el('admin-vouchers-pagination');
    if(!container) return;
    const total = _adminVouchersData.length;
    const totalPages = Math.ceil(total / ADMIN_VOUCHERS_PAGE_SIZE);
    if(totalPages <= 1){ container.innerHTML = ''; return; }
    let html = '<nav><ul class="pagination pagination-sm justify-content-center mb-0">';
    html += `<li class="page-item ${_adminVouchersPage === 1 ? 'disabled' : ''}"><a class="page-link" href="#" data-avp="${_adminVouchersPage - 1}">«</a></li>`;
    for(let i = 1; i <= totalPages; i++){
      html += `<li class="page-item ${i === _adminVouchersPage ? 'active' : ''}"><a class="page-link" href="#" data-avp="${i}">${i}</a></li>`;
    }
    html += `<li class="page-item ${_adminVouchersPage === totalPages ? 'disabled' : ''}"><a class="page-link" href="#" data-avp="${_adminVouchersPage + 1}">»</a></li>`;
    html += '</ul></nav>';
    container.innerHTML = html;
    container.querySelectorAll('[data-avp]').forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        const p = parseInt(a.dataset.avp);
        if(p >= 1 && p <= totalPages) renderAdminVouchersPage(p);
      });
    });
  }

  function applyAdminVouchersFilter(){
    const text      = ((el('avf-text')      || {}).value || '').toLowerCase().trim();
    const status    = ((el('avf-status')    || {}).value || '').toUpperCase();
    const course    = ((el('avf-course')    || {}).value || '');
    const dateFrom  = ((el('avf-date-from') || {}).value || '');
    const dateTo    = ((el('avf-date-to')   || {}).value || '');

    _adminVouchersData = _adminVouchersAllData.filter(v => {
      if(status && (v.status || '').toUpperCase() !== status) return false;
      if(course  && (v.course_name || '') !== course)          return false;
      if(text){
        const haystack = [v.code, v.consumed_by, v.final_client].map(s => (s || '').toLowerCase()).join(' ');
        if(!haystack.includes(text)) return false;
      }
      if(dateFrom || dateTo){
        const d = v.created_at ? new Date(v.created_at).toISOString().slice(0,10) : null;
        if(!d) return false;
        if(dateFrom && d < dateFrom) return false;
        if(dateTo   && d > dateTo)   return false;
      }
      return true;
    });

    const summaryEl = el('avf-summary');
    if(summaryEl){
      const hasFilter = text || status || course || dateFrom || dateTo;
      if(hasFilter){
        summaryEl.textContent = `Mostrando ${_adminVouchersData.length} de ${_adminVouchersAllData.length} vouchers`;
        summaryEl.style.display = '';
      } else {
        summaryEl.style.display = 'none';
      }
    }
    renderAdminVouchersPage(1);
  }

  function buildAdminVouchersFilterBar(vouchers){
    const courses = [...new Set(vouchers.map(v => v.course_name).filter(Boolean))].sort();
    const courseOptions = courses.map(c => `<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`).join('');
    return `
      <div class="card shadow-sm mb-3">
        <div class="card-body py-2">
          <div class="row g-2 align-items-end">
            <div class="col-md-3">
              <label class="form-label mb-1 small">Buscar (código / usuario / cliente)</label>
              <input id="avf-text" type="text" class="form-control form-control-sm" placeholder="Escribe para buscar…">
            </div>
            <div class="col-md-2">
              <label class="form-label mb-1 small">Estado</label>
              <select id="avf-status" class="form-select form-select-sm">
                <option value="">Activos</option>
                <option value="AVAILABLE">Disponible</option>
              </select>
            </div>
            <div class="col-md-3">
              <label class="form-label mb-1 small">Certificación</label>
              <select id="avf-course" class="form-select form-select-sm">
                <option value="">Todas las certificaciones</option>
                ${courseOptions}
              </select>
            </div>
            <div class="col-md-2">
              <label class="form-label mb-1 small">Creado desde</label>
              <input id="avf-date-from" type="date" class="form-control form-control-sm">
            </div>
            <div class="col-md-2">
              <label class="form-label mb-1 small">Creado hasta</label>
              <input id="avf-date-to" type="date" class="form-control form-control-sm">
            </div>
          </div>
          <div class="d-flex gap-2 mt-2">
            <button id="avf-apply" class="btn btn-sm btn-primary">🔍 Filtrar</button>
            <button id="avf-clear" class="btn btn-sm btn-outline-secondary">✕ Limpiar</button>
            <span id="avf-summary" class="small text-muted align-self-center ms-1" style="display:none;"></span>
          </div>
        </div>
      </div>`;
  }

  function wireAdminVouchersFilterEvents(){
    const applyBtn = el('avf-apply');
    const clearBtn = el('avf-clear');
    if(applyBtn) applyBtn.addEventListener('click', applyAdminVouchersFilter);
    if(clearBtn) clearBtn.addEventListener('click', () => {
      ['avf-text','avf-status','avf-course','avf-date-from','avf-date-to'].forEach(id => { const e = el(id); if(e) e.value = ''; });
      const s = el('avf-summary'); if(s) s.style.display = 'none';
      _adminVouchersData = [..._adminVouchersAllData];
      renderAdminVouchersPage(1);
    });
    const textInput = el('avf-text');
    if(textInput) textInput.addEventListener('keydown', e => { if(e.key === 'Enter') applyAdminVouchersFilter(); });
  }

  async function loadAdminStatsByCriterion(pid, showSuccessMessage = true){
    const btn = el('admin-load-stats');
    if(!pid){
      showLoginMessage('Selecciona un criterio de búsqueda', 'danger', 3000);
      return;
    }

    const isGlobal = String(pid) === 'global';

    try{
      setButtonLoading(btn, true);
      const baseApi = apiUrl.replace(':8080', ':8081');

      let stats = { total: 0, available: 0, used: 0 };
      let vouchers = [];
      let partnerInfo = null;

      if(isGlobal){
        const summaryResp = await safeFetch(baseApi + '/admin/reports/summary', { headers: authHeaders() });
        const summaryData = await summaryResp.json();
        const s = (summaryData && (summaryData.summary || summaryData)) || {};
        const total = Number(s.total_vouchers_sold || s.total_vouchers || 0);
        const used = Number(s.consumed_vouchers || s.used_vouchers || 0);
        stats = {
          total,
          used,
          available: Math.max(total - used, 0),
          total_partners:          Number(s.total_partners          || s.active_partners || 0),
          total_purchases:         Number(s.total_purchases         || 0),
          total_revenue:           Number(s.total_revenue           || 0),
          completed_courses:       Number(s.completed_courses       || 0),
          total_activations:       Number(s.total_activations       || 0),
          enrolled_courses:        Number(s.enrolled_courses        || 0),
          completed_unique_courses:Number(s.completed_unique_courses|| 0)
        };
      } else {
        const [statsResp, vouchersResp] = await Promise.all([
          safeFetch(baseApi + `/admin/partners/${pid}/stats`, { headers: authHeaders() }),
          safeFetch(baseApi + `/partner/${pid}/vouchers`,     { headers: authHeaders() })
        ]);

        stats = await statsResp.json();
        const allVouchers = vouchersResp.ok ? await vouchersResp.json() : [];
        vouchers = Array.isArray(allVouchers)
          ? allVouchers.filter(v => {
              const status = String(v.status || '').toUpperCase();
              return status === 'AVAILABLE' || status === 'ACTIVE';
            })
          : [];
        partnerInfo = _adminPartnersCache.find(p => String(p.id) === String(pid)) || null;
      }

      setButtonLoading(btn, false);

      if(el('admin-stat-total-vouchers'))     el('admin-stat-total-vouchers').textContent     = stats.total     || 0;
      if(el('admin-stat-available-vouchers')) el('admin-stat-available-vouchers').textContent = stats.available || 0;
      if(el('admin-stat-used-vouchers'))      el('admin-stat-used-vouchers').textContent      = stats.used      || 0;
      const adminCompleted = Number(stats.completed_courses || 0);
      const adminUsed      = Number(stats.used || stats.consumed_vouchers || 0);
      const adminCompRate  = adminUsed > 0 ? (adminCompleted / adminUsed * 100) : 0;
      if(el('admin-stat-completed-courses')) el('admin-stat-completed-courses').textContent = adminCompleted;
      if(el('admin-stat-completion-rate'))   el('admin-stat-completion-rate').textContent   = `${adminCompRate.toFixed(1)}%`;

      _adminVouchersAllData = Array.isArray(vouchers) ? vouchers : [];
      _adminVouchersData    = [..._adminVouchersAllData];

      _adminReportData = { stats, vouchers: _adminVouchersAllData, partnerInfo, pid };

      const resultEl = el('admin-stats-result');
      if(resultEl){
        if(isGlobal){
          const fmtMoney = n => '$' + Number(n || 0).toLocaleString('es-CL');
          const gCompleted   = Number(stats.completed_courses || 0);
          const gActivations = Number(stats.total_activations || 0);
          const gEnrolled    = Number(stats.enrolled_courses  || 0);
          const gCompRate    = gActivations > 0 ? (gCompleted / gActivations * 100) : 0;
          const compBarW     = Math.max(gCompleted > 0 ? 2 : 0, Math.min(100, gCompRate));
          resultEl.innerHTML = `
            <div class="card shadow-sm mb-3">
              <div class="card-body py-3 px-3">
                <div class="d-flex flex-wrap align-items-center gap-3 mb-3">
                  <span class="badge bg-primary">Vista global</span>
                  <span class="text-muted small">Datos consolidados de todos los partners</span>
                </div>
                <div class="row g-3">
                  <div class="col-6 col-md-3"><small class="text-muted d-block">Partners activos</small><strong>${stats.total_partners || 0}</strong></div>
                  <div class="col-6 col-md-3"><small class="text-muted d-block">Compras totales</small><strong>${stats.total_purchases || 0}</strong></div>
                  <div class="col-6 col-md-3"><small class="text-muted d-block">Ingresos totales</small><strong>${fmtMoney(stats.total_revenue || 0)}</strong></div>
                  <div class="col-6 col-md-3"><small class="text-muted d-block">Activaciones</small><strong>${gActivations}</strong></div>
                </div>
                <hr class="my-3">
                <div class="row g-3 align-items-center">
                  <div class="col-6 col-md-3">
                    <small class="text-muted d-block">🎓 Certificaciones completadas</small>
                    <strong class="fs-5" style="color:#059669;">${gCompleted}</strong>
                  </div>
                  <div class="col-6 col-md-3">
                    <small class="text-muted d-block">✅ En proceso (matriculados)</small>
                    <strong class="fs-5" style="color:#0d6efd;">${gEnrolled}</strong>
                  </div>
                  <div class="col-md-6">
                    <small class="text-muted d-block mb-1">Tasa de completación (completados / activaciones)</small>
                    <div class="d-flex align-items-center gap-2">
                      <div style="flex:1;background:#d1fae5;border-radius:4px;height:10px;overflow:hidden;">
                        <div style="width:${compBarW}%;height:100%;background:#059669;transition:width .4s;"></div>
                      </div>
                      <span class="fw-bold" style="color:#059669;min-width:44px;">${gCompRate.toFixed(1)}%</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>`;
          return;
        }

        const baseProfile    = partnerInfo && (partnerInfo.pricing_profile_name    || partnerInfo.pricing_profile_code);
        const specialProfile = partnerInfo && (partnerInfo.special_pricing_profile_name || partnerInfo.special_pricing_profile_code);

        const categoryBadge = baseProfile
          ? `<span class="badge bg-primary me-1">${escapeHTML(partnerInfo.pricing_profile_name || partnerInfo.pricing_profile_code)}</span>`
          : '<span class="text-muted small">Sin categoría asignada</span>';
        const specialBadge = specialProfile
          ? `<span class="badge bg-warning text-dark">${escapeHTML(partnerInfo.special_pricing_profile_name || partnerInfo.special_pricing_profile_code)} <small>(especial)</small></span>`
          : '';

        const partnerCard = partnerInfo ? `
          <div class="card shadow-sm mb-3">
            <div class="card-body py-2 px-3 d-flex flex-wrap align-items-center gap-3">
              <div>
                <span class="text-muted small d-block">Partner</span>
                <strong>${escapeHTML(partnerInfo.name || '')}</strong>
                <span class="text-muted small ms-1">(ID: ${escapeHTML(String(partnerInfo.id))})</span>
              </div>
              <div class="vr d-none d-md-block"></div>
              <div>
                <span class="text-muted small d-block">Email</span>
                <span>${escapeHTML(partnerInfo.email || '-')}</span>
              </div>
              <div class="vr d-none d-md-block"></div>
              <div>
                <span class="text-muted small d-block">Categoría de precio</span>
                ${categoryBadge} ${specialBadge}
              </div>
            </div>
          </div>` : '';

        // Panel de completaciones por curso para la vista por partner
        const partnerAllVouchers = await (async () => {
          try {
            const r = await safeFetch(apiUrl.replace(':8080',':8081') + `/partner/${pid}/vouchers`, { headers: authHeaders() });
            return r.ok ? await r.json() : [];
          } catch { return []; }
        })();
        const completedByCourseParter = {};
        (Array.isArray(partnerAllVouchers) ? partnerAllVouchers : []).forEach(v => {
          if ((v.moodle_status || '').toUpperCase() === 'COMPLETED') {
            const key = escapeHTML((v.course_name || 'Sin certificación').trim());
            completedByCourseParter[key] = (completedByCourseParter[key] || 0) + 1;
          }
        });
        const completedCoursesRows = Object.entries(completedByCourseParter)
          .sort((a,b) => b[1] - a[1])
          .map(([name, cnt]) => `<li><span>${name}</span><strong>🎓 ${cnt}</strong></li>`)
          .join('') || '<li><span class="text-muted">Sin completaciones aún</span><strong>0</strong></li>';
        const pCompleted  = Number(stats.completed_courses || 0);
        const pConsumed   = Number(stats.used || 0);
        const pCompRate   = pConsumed > 0 ? (pCompleted / pConsumed * 100) : 0;
        const pCompBarW   = Math.max(pCompleted > 0 ? 2 : 0, Math.min(100, pCompRate));

        resultEl.innerHTML = `
          ${partnerCard}
          <div class="row g-3 mb-3">
            <div class="col-md-4">
              <div class="card h-100 border-0 shadow-sm">
                <div class="card-body text-center py-3">
                  <div class="fs-1 mb-1">🎓</div>
                  <div class="h4 mb-0" style="color:#059669;">${pCompleted}</div>
                  <div class="text-muted small">Certificaciones completadas</div>
                </div>
              </div>
            </div>
            <div class="col-md-4">
              <div class="card h-100 border-0 shadow-sm">
                <div class="card-body text-center py-3">
                  <div class="fs-1 mb-1">📈</div>
                  <div class="h4 mb-0" style="color:#7c3aed;">${pCompRate.toFixed(1)}%</div>
                  <div class="text-muted small">Tasa de completación</div>
                  <div class="mt-2" style="background:#e9ecef;border-radius:4px;height:8px;overflow:hidden;">
                    <div style="width:${pCompBarW}%;height:100%;background:#7c3aed;transition:width .4s;"></div>
                  </div>
                </div>
              </div>
            </div>
            <div class="col-md-4">
              <div class="card h-100 border-0 shadow-sm">
                <div class="card-body py-3">
                  <div class="small fw-semibold mb-2">🏆 Completados por certificación</div>
                  <ul class="metric-list mb-0">${completedCoursesRows}</ul>
                </div>
              </div>
            </div>
          </div>
          <div class="alert alert-success mb-3">Estadísticas cargadas — ${_adminVouchersAllData.length} vouchers activos encontrados.</div>
          ${buildAdminVouchersFilterBar(_adminVouchersAllData)}
          <div class="card shadow-sm">
            <div class="card-body p-0">
              <div class="d-flex align-items-center justify-content-between px-3 pt-3 pb-2">
                <h6 class="mb-0">Detalle de Vouchers Activos del Partner</h6>
                <span class="badge bg-secondary">${_adminVouchersAllData.length} total</span>
              </div>
              <div class="table-responsive">
                <table class="table table-sm table-hover mb-0">
                  <thead class="table-light">
                    <tr>
                      <th>Código</th><th>Estado</th><th>Certificación</th><th>Usuario</th>
                      <th>Cliente final</th><th>Consumido</th><th>Compra ID</th><th>Creado</th>
                    </tr>
                  </thead>
                  <tbody id="admin-vouchers-tbody"></tbody>
                </table>
              </div>
              <div id="admin-vouchers-pagination" class="px-3 py-2"></div>
            </div>
          </div>`;
        wireAdminVouchersFilterEvents();
        renderAdminVouchersPage(1);
      }

      if(showSuccessMessage){
        showLoginMessage(isGlobal ? 'Vista global cargada' : 'Estadísticas del partner cargadas', 'success', 1800);
      }
    }catch(e){
      setButtonLoading(btn, false);
      showLoginMessage('Error: ' + e.message, 'danger', 3000);
    }
  }

  on('admin-load-stats', 'click', async () => {
    const pid = (el('admin-select-partner-id') || {}).value;
    await loadAdminStatsByCriterion(pid, true);
  });

  // Partner actions
  function getPartnerIdFromJwt(){
    const t = getToken();
    if(!t) return null;
    const d = decodeJwt(t);
    return (d && d.partner_id) ? d.partner_id : null;
  }

  async function loadPartnerStats(showMessage){
    const pid = getPartnerIdFromJwt();
    if(!pid){
      if(showMessage) showLoginMessage('No se pudo obtener Partner ID', 'danger', 3000);
      return;
    }
    const btn = el('load-stats');
    try{
      if(btn) setButtonLoading(btn, true);
      const baseApi = apiUrl.replace(':8080', ':8081');
      const [statsResp, paymentsResp, vouchersResp] = await Promise.all([
        safeFetch(baseApi + `/partner/${pid}/stats`, { headers: authHeaders() }),
        safeFetch(baseApi + `/partner/${pid}/payments`, { headers: authHeaders() }),
        safeFetch(baseApi + `/partner/${pid}/vouchers`, { headers: authHeaders() })
      ]);

      const data = await statsResp.json();
      const payments = paymentsResp.ok ? await paymentsResp.json() : [];
      const vouchers = vouchersResp.ok ? await vouchersResp.json() : [];

      if(!statsResp.ok){
        throw new Error(data.error || 'No se pudieron cargar estadísticas');
      }

      _partnerReportData = { stats: data, payments: Array.isArray(payments) ? payments : [], vouchers: Array.isArray(vouchers) ? vouchers : [], pid };
      updateVoucherSummaryStrip();

      if(btn) setButtonLoading(btn, false);
      if(el('stat-total-vouchers')) el('stat-total-vouchers').textContent = data.total || 0;
      if(el('stat-available-vouchers')) el('stat-available-vouchers').textContent = data.available || 0;
      if(el('stat-used-vouchers')) el('stat-used-vouchers').textContent = data.used || 0;

      const paidPayments = Array.isArray(payments) ? payments.filter(isPaymentPaid) : [];
      const failedPayments = Array.isArray(payments) ? payments.filter(isPaymentFailed) : [];
      const pendingPayments = Array.isArray(payments) ? payments.filter(p => !isPaymentPaid(p) && !isPaymentFailed(p)) : [];
      const totalRevenue = paidPayments.reduce((sum, p) => sum + toNumber(p.total_price), 0);
      const avgTicket = paidPayments.length > 0 ? (totalRevenue / paidPayments.length) : 0;
      const usageRate = data.total > 0 ? ((data.used / data.total) * 100) : 0;

      if(el('stat-usage-rate')) el('stat-usage-rate').textContent = `${usageRate.toFixed(1)}%`;
      if(el('stat-paid-purchases')) el('stat-paid-purchases').textContent = paidPayments.length;
      if(el('stat-total-revenue')) el('stat-total-revenue').textContent = formatCurrency(totalRevenue);
      if(el('stat-avg-ticket')) el('stat-avg-ticket').textContent = formatCurrency(avgTicket);
      if(el('stat-pending-purchases')) el('stat-pending-purchases').textContent = pendingPayments.length;

      const consumedVouchers = Array.isArray(vouchers) ? vouchers.filter(v => String(v.status || '').toUpperCase() === 'CONSUMED') : [];
      const lastActivation = consumedVouchers
        .filter(v => v.consumed_at)
        .sort((a,b) => new Date(b.consumed_at) - new Date(a.consumed_at))[0];
      if(el('stat-last-activation')){
        el('stat-last-activation').textContent = lastActivation && lastActivation.consumed_at
          ? new Date(lastActivation.consumed_at).toLocaleDateString('es-ES')
          : '-';
      }

      // ── Cursos completados ──
      const completedCount   = Number(data.completed_courses || 0);
      const completionRate   = consumedVouchers.length > 0 ? (completedCount / consumedVouchers.length * 100) : 0;
      if(el('stat-completed-courses')) el('stat-completed-courses').textContent = completedCount;
      if(el('stat-completion-rate'))   el('stat-completion-rate').textContent   = `${completionRate.toFixed(1)}%`;

      if(el('bar-usage')) el('bar-usage').style.width = `${Math.max(2, Math.min(100, usageRate))}%`;
      if(el('bar-usage-label')) el('bar-usage-label').textContent = `${usageRate.toFixed(1)}%`;

      if(el('bar-completion')) el('bar-completion').style.width = `${Math.max(completedCount > 0 ? 2 : 0, Math.min(100, completionRate))}%`;
      if(el('bar-completion-label')) el('bar-completion-label').textContent = `${completionRate.toFixed(1)}%`;

      renderMetricList('purchase-status-list', [
        { label: 'Pagadas', value: paidPayments.length },
        { label: 'Pendientes', value: pendingPayments.length },
        { label: 'Fallidas', value: failedPayments.length }
      ], 'Sin compras');

      const monthlyMap = {};
      const months = monthLabels(6);
      months.forEach(m => { monthlyMap[m.key] = 0; });
      paidPayments.forEach(p => {
        const dt = p.created_at ? new Date(p.created_at) : null;
        if(!dt || Number.isNaN(dt.getTime())) return;
        const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
        if(Object.prototype.hasOwnProperty.call(monthlyMap, key)){
          monthlyMap[key] += toNumber(p.total_price);
        }
      });

      renderMetricBars('monthly-paid-bars', months.map(m => ({
        label: m.label,
        value: monthlyMap[m.key],
        valueLabel: formatCurrency(monthlyMap[m.key]),
        badge: monthlyMap[m.key] > 0 ? 'Activo' : '0'
      })));

      const byCourse = {};
      consumedVouchers.forEach(v => {
        const key = (v.course_name || 'Sin certificación').trim();
        byCourse[key] = (byCourse[key] || 0) + 1;
      });
      const topCourses = Object.entries(byCourse)
        .map(([name, count]) => ({ label: name, value: count }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 5);
      renderMetricList('top-courses-list', topCourses, 'Sin activaciones');

      // Completados por curso (de vouchers con moodle_status=COMPLETED)
      const completedByCourse = {};
      Array.isArray(vouchers) && vouchers.forEach(v => {
        if ((v.moodle_status || '').toUpperCase() === 'COMPLETED') {
          const key = (v.course_name || 'Sin certificación').trim();
          completedByCourse[key] = (completedByCourse[key] || 0) + 1;
        }
      });
      const completedCoursesList = Object.entries(completedByCourse)
        .map(([name, count]) => ({ label: name, value: count }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 6);
      renderMetricList('completed-courses-list', completedCoursesList, 'Sin completaciones aún');

      if(el('stats-result')) el('stats-result').innerHTML = '<div class="alert alert-success">Estadisticas cargadas correctamente</div>';
    }catch(e){
      if(btn) setButtonLoading(btn, false);
      if(el('stats-result')) el('stats-result').innerHTML = `<div class="alert alert-danger">Error: ${escapeHTML(e.message)}</div>`;
    }
  }

  let _allPartnerVouchers = [];
  let _currentVouchersDisplayList = [];
  let _currentVouchersPage = 1;
  const VOUCHERS_PAGE_SIZE = 10;

  function renderVouchersTable(list, page){
    _currentVouchersDisplayList = Array.isArray(list) ? list : [];
    _currentVouchersPage = page || 1;
    const tbody = el('vouchers-table-body');
    if(!tbody) return;
    if(_currentVouchersDisplayList.length === 0){
      tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted p-3">No hay vouchers para los criterios seleccionados</td></tr>';
      renderVouchersPagination();
      return;
    }
    const start = (_currentVouchersPage - 1) * VOUCHERS_PAGE_SIZE;
    const pageData = _currentVouchersDisplayList.slice(start, start + VOUCHERS_PAGE_SIZE);
    tbody.innerHTML = pageData.map(v => {
      const safeCode = escapeHTML(v.code || '');
      const status = (v.status || '').toUpperCase();
      let statusBadge;
      if(status === 'CONSUMED'){
        statusBadge = '<span class="badge bg-secondary">Consumido</span>';
      } else if(status === 'AVAILABLE'){
        statusBadge = '<span class="badge bg-success">Disponible</span>';
      } else {
        statusBadge = `<span class="badge bg-light text-dark">${escapeHTML(v.status || '')}</span>`;
      }
      const safeCourse     = v.course_name  ? escapeHTML(v.course_name)  : '-';
      const safeConsumedBy = v.consumed_by  ? escapeHTML(v.consumed_by)  : '-';
      const safeFinalClient = v.final_client ? escapeHTML(v.final_client) : '-';
      const created        = v.created_at   ? new Date(v.created_at).toLocaleDateString('es-ES') : '-';

      let moodleBadge = '<span class="text-muted">—</span>';
      if(status === 'CONSUMED'){
        const ms = (v.moodle_status || '').toUpperCase();
        if(ms === 'COMPLETED'){
          const dateStr = v.moodle_completed_at
            ? new Date(v.moodle_completed_at).toLocaleDateString('es-ES', { day:'2-digit', month:'2-digit', year:'numeric' })
            : '';
          moodleBadge = `<span class="badge bg-primary" title="${dateStr ? 'Completado el ' + dateStr : 'Certificación completada'}">🎓 Completado</span>${dateStr ? `<div class="small text-muted mt-1">${dateStr}</div>` : ''}`;
        }
        else if(ms === 'COURSE_COMPLETED') moodleBadge = '<span class="badge bg-info text-white">📖 Curso Completado</span>';
        else if(ms === 'ENROLLED')  moodleBadge = '<span class="badge bg-success">✓ Acceso activado</span>';
        else if(ms === 'MOCKED')    moodleBadge = '<span class="badge bg-info text-white">Simulado</span>';
        else if(ms === 'FAILED')    moodleBadge = `<span class="badge bg-danger" title="${escapeHTML(v.moodle_error||'')}">✗ Error</span>`;
        else if(ms === 'PENDING')   moodleBadge = '<span class="badge bg-warning text-dark">⏳ Pendiente</span>';
        else if(ms === 'SKIPPED')   moodleBadge = '<span class="badge bg-secondary">Sin mapear</span>';
      }

      const compBadge = (v.voucher_type === 'COMPLIMENTARY')
        ? `<span class="badge ms-1" style="background:#fd7e14;color:#fff;" title="${escapeHTML(v.complimentary_reason || 'Cortesía')}">🎁 Cortesía</span>`
        : '';
      return `<tr>
        <td><code>${safeCode}</code>${compBadge}</td>
        <td>${statusBadge}</td>
        <td>${safeCourse}</td>
        <td>${safeConsumedBy}</td>
        <td>${safeFinalClient}</td>
        <td>${moodleBadge}</td>
        <td>${created}</td>
      </tr>`;
    }).join('');
    renderVouchersPagination();
  }

  function renderVouchersPagination(){
    const container = el('vouchers-pagination');
    if(!container) return;
    const total = _currentVouchersDisplayList.length;
    const totalPages = Math.ceil(total / VOUCHERS_PAGE_SIZE);
    if(totalPages <= 1){ container.innerHTML = ''; return; }
    let html = '<nav aria-label="Páginas de vouchers"><ul class="pagination pagination-sm justify-content-center mb-0">';
    html += `<li class="page-item ${_currentVouchersPage === 1 ? 'disabled' : ''}"><a class="page-link" href="#" data-vp-page="${_currentVouchersPage - 1}">«</a></li>`;
    for(let i = 1; i <= totalPages; i++){
      html += `<li class="page-item ${i === _currentVouchersPage ? 'active' : ''}"><a class="page-link" href="#" data-vp-page="${i}">${i}</a></li>`;
    }
    html += `<li class="page-item ${_currentVouchersPage === totalPages ? 'disabled' : ''}"><a class="page-link" href="#" data-vp-page="${_currentVouchersPage + 1}">»</a></li>`;
    html += '</ul></nav>';
    container.innerHTML = html;
    container.querySelectorAll('[data-vp-page]').forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        const p = parseInt(a.dataset.vpPage);
        if(p >= 1 && p <= totalPages) renderVouchersTable(_currentVouchersDisplayList, p);
      });
    });
  }

  function applyVoucherFilters(){
    const courseVal  = (el('voucher-filter-course') && el('voucher-filter-course').value) || '';
    const clientVal  = (el('voucher-filter-client') && el('voucher-filter-client').value) || '';
    const periodVal  = (el('voucher-filter-period') && el('voucher-filter-period').value) || '';
    const dateFrom   = (el('voucher-filter-date-from') && el('voucher-filter-date-from').value) || '';
    const dateTo     = (el('voucher-filter-date-to') && el('voucher-filter-date-to').value) || '';

    const now = new Date();
    const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

    let rangeStart = null;
    let rangeEnd   = null;

    if(periodVal === 'today'){
      rangeStart = startOfDay(now);
      rangeEnd   = new Date(rangeStart.getTime() + 86400000);
    } else if(periodVal === 'week'){
      const dow = now.getDay();
      rangeStart = startOfDay(new Date(now.getTime() - dow * 86400000));
      rangeEnd   = new Date(rangeStart.getTime() + 7 * 86400000);
    } else if(periodVal === 'month'){
      rangeStart = new Date(now.getFullYear(), now.getMonth(), 1);
      rangeEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    } else if(periodVal === 'year'){
      rangeStart = new Date(now.getFullYear(), 0, 1);
      rangeEnd   = new Date(now.getFullYear() + 1, 0, 1);
    } else if(periodVal === 'custom'){
      if(dateFrom) rangeStart = new Date(dateFrom + 'T00:00:00');
      if(dateTo)   rangeEnd   = new Date(dateTo   + 'T23:59:59');
    }

    // Only show USED (CONSUMED) vouchers in this list
    const usedOnly = _allPartnerVouchers.filter(v => (v.status || '').toUpperCase() !== 'AVAILABLE');

    let filtered = usedOnly.filter(v => {
      if(courseVal && (v.course_name || '') !== courseVal) return false;
      if(clientVal && (v.final_client || '') !== clientVal) return false;
      if(rangeStart || rangeEnd){
        const vDate = v.created_at ? new Date(v.created_at) : null;
        if(!vDate) return false;
        if(rangeStart && vDate < rangeStart) return false;
        if(rangeEnd   && vDate > rangeEnd)   return false;
      }
      return true;
    });

    renderVouchersTable(filtered);

    // Update summary strip from stats if available, else count from voucher list
    const stats = _partnerReportData && _partnerReportData.stats;
    const usedCount      = stats ? (stats.used      || 0) : usedOnly.length;
    const availableCount = stats ? (stats.available  || 0) : (_allPartnerVouchers.length - usedOnly.length);
    const totalCount     = stats ? (stats.total      || 0) : _allPartnerVouchers.length;
    const vsTotal = el('vsummary-total');
    const vsUsed  = el('vsummary-used');
    const vsAvail = el('vsummary-available');
    if(vsTotal) vsTotal.textContent = totalCount;
    if(vsUsed)  vsUsed.textContent  = usedCount;
    if(vsAvail) vsAvail.textContent = availableCount;

    const summaryEl = el('voucher-filter-summary');
    if(summaryEl){
      const hasFilter = courseVal || clientVal || periodVal;
      if(hasFilter){
        summaryEl.style.display = '';
        summaryEl.textContent = `Mostrando ${filtered.length} de ${usedOnly.length} vouchers usados`;
      } else {
        summaryEl.style.display = 'none';
      }
    }
  }

  function getVoucherPeriodLabel(periodVal, dateFrom, dateTo){
    const labels = {
      today: 'Hoy',
      week: 'Esta semana',
      month: 'Este mes',
      year: 'Este año',
      custom: 'Personalizado'
    };
    if(!periodVal) return 'Cualquier fecha';
    if(periodVal !== 'custom') return labels[periodVal] || 'Cualquier fecha';
    if(dateFrom && dateTo) return `Personalizado (${dateFrom} a ${dateTo})`;
    if(dateFrom) return `Personalizado (desde ${dateFrom})`;
    if(dateTo) return `Personalizado (hasta ${dateTo})`;
    return 'Personalizado';
  }

  function exportFilteredUsedVouchersExcel(){
    const XLSX = window.XLSX;
    if(!XLSX){
      showLoginMessage('Libreria Excel no disponible', 'danger', 3000);
      return;
    }

    const rows = Array.isArray(_currentVouchersDisplayList) ? _currentVouchersDisplayList : [];
    if(!rows.length){
      showLoginMessage('No hay vouchers usados para exportar con el filtro actual', 'warning', 3000);
      return;
    }

    const courseVal = (el('voucher-filter-course') && el('voucher-filter-course').value) || '';
    const clientVal = (el('voucher-filter-client') && el('voucher-filter-client').value) || '';
    const periodVal = (el('voucher-filter-period') && el('voucher-filter-period').value) || '';
    const dateFrom  = (el('voucher-filter-date-from') && el('voucher-filter-date-from').value) || '';
    const dateTo    = (el('voucher-filter-date-to') && el('voucher-filter-date-to').value) || '';

    const wb = XLSX.utils.book_new();
    const todayIso = new Date().toISOString().slice(0,10);
    const generatedAt = new Date().toLocaleDateString('es-ES');
    const periodLabel = getVoucherPeriodLabel(periodVal, dateFrom, dateTo);

    const aoa = [
      ['CertJOIN Platform'],
      ['Mis Vouchers Usados'],
      [`Generado: ${generatedAt}`],
      [`Certificación: ${courseVal || 'Todas las certificaciones'}`],
      [`Cliente final: ${clientVal || 'Todos los clientes'}`],
      [`Periodo: ${periodLabel}`],
      [`Total vouchers usados: ${rows.length}`],
      [],
      ['Codigo', 'Estado', 'Certificación asociada', 'Consumido por', 'Cliente final', 'Fecha consumo', 'Fecha registro']
    ];

    rows.forEach(v => {
      const status = (v.status || '').toUpperCase();
      const statusLabel = status === 'CONSUMED' ? 'Consumido' : (v.status || '-');
      const consumedAt = v.consumed_at ? new Date(v.consumed_at).toLocaleDateString('es-ES') : '-';
      const createdAt = v.created_at ? new Date(v.created_at).toLocaleDateString('es-ES') : '-';
      aoa.push([
        v.code || '-',
        statusLabel,
        v.course_name || '-',
        v.consumed_by || '-',
        v.final_client || '-',
        consumedAt,
        createdAt
      ]);
    });

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    _xlsxSetColWidths(ws, [16, 12, 28, 30, 24, 14, 14]);
    XLSX.utils.book_append_sheet(wb, ws, 'Vouchers usados');
    XLSX.writeFile(wb, `mis_vouchers_usados_${todayIso}.xlsx`);
    showLoginMessage('Excel de vouchers usado generado correctamente', 'success', 2500);
  }

  function populateFilterSelect(selectId, values, defaultLabel){
    const select = el(selectId);
    if(!select) return;
    const current = select.value;
    const unique = [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
    select.innerHTML = `<option value="">${escapeHTML(defaultLabel)}</option>` +
      unique.map(v => `<option value="${escapeHTML(v)}"${v === current ? ' selected' : ''}>${escapeHTML(v)}</option>`).join('');
  }

  function populateCourseFilterSelect(vouchers){
    populateFilterSelect('voucher-filter-course', vouchers.map(v => v.course_name), 'Todos los cursos');
  }

  function populateClientFilterSelect(vouchers){
    populateFilterSelect('voucher-filter-client', vouchers.map(v => v.final_client), 'Todos los clientes');
  }

  function updateVoucherSummaryStrip(){
    const stats = _partnerReportData && _partnerReportData.stats;
    const used      = stats ? (stats.used      || 0) : _allPartnerVouchers.filter(v => (v.status || '').toUpperCase() !== 'AVAILABLE').length;
    const available = stats ? (stats.available  || 0) : _allPartnerVouchers.filter(v => (v.status || '').toUpperCase() === 'AVAILABLE').length;
    const total     = stats ? (stats.total      || 0) : _allPartnerVouchers.length;
    const vsTotal = el('vsummary-total');
    const vsUsed  = el('vsummary-used');
    const vsAvail = el('vsummary-available');
    if(vsTotal) vsTotal.textContent = total;
    if(vsUsed)  vsUsed.textContent  = used;
    if(vsAvail) vsAvail.textContent = available;
  }

  async function loadPartnerVouchers(){
    const pid = getPartnerIdFromJwt();
    if(!pid){ showLoginMessage('No se pudo obtener Partner ID', 'danger', 3000); return; }
    const btn = el('load-vouchers');
    try{
      if(btn) setButtonLoading(btn, true);
      const resp = await safeFetch(apiUrl.replace(':8080', ':8081') + `/partner/${pid}/vouchers`, { headers: authHeaders() });
      const data = await resp.json();
      if(btn) setButtonLoading(btn, false);
      if(!el('vouchers-table-body')) return;
      _allPartnerVouchers = Array.isArray(data) ? data : [];
      const usedVouchers = _allPartnerVouchers.filter(v => (v.status || '').toUpperCase() !== 'AVAILABLE');
      populateCourseFilterSelect(usedVouchers);
      populateClientFilterSelect(usedVouchers);
      applyVoucherFilters();
    }catch(e){
      if(btn) setButtonLoading(btn, false);
      showLoginMessage('Error: ' + e.message, 'danger', 3000);
    }
  }

  let partnerPaymentsData = [];
  let currentPartnerPaymentsPage = 1;
  const PARTNER_PAYMENTS_PAGE_SIZE = 10;

  function renderPartnerPaymentsPage(page) {
    currentPartnerPaymentsPage = page || 1;
    const tbody = el('partner-payments-table-body');
    if (!tbody) return;
    if (partnerPaymentsData.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted p-3">No hay compras registradas</td></tr>';
      renderPartnerPaymentsPagination();
      return;
    }
    const start = (currentPartnerPaymentsPage - 1) * PARTNER_PAYMENTS_PAGE_SIZE;
    const pageData = partnerPaymentsData.slice(start, start + PARTNER_PAYMENTS_PAGE_SIZE);
    tbody.innerHTML = pageData.map(p => {
      const safeId  = escapeHTML(String(p.id || ''));
      const safeQty = escapeHTML(String(p.qty || 0));
      const method  = (p.payment_method || 'stripe').toLowerCase();
      const isComp  = method === 'complimentary';
      const total   = isComp
        ? '<span class="text-success fw-semibold">$0.00</span> <span class="badge" style="background:#fd7e14;color:#fff;font-size:0.7rem;">Cortesía</span>'
        : `<strong>$${parseFloat(p.total_price || 0).toFixed(2)}</strong>`;
      const stripeStatus = (p.stripe_status || '').toLowerCase();
      const status  = (p.status || '').toUpperCase();
      const created = p.created_at ? new Date(p.created_at).toLocaleString('es-ES') : '-';

      let statusBadge = '<span class="badge bg-warning text-dark">Pendiente</span>';
      if(status === 'PAID' || stripeStatus === 'paid' || stripeStatus === 'succeeded'){
        statusBadge = '<span class="badge bg-success">Pagado</span>';
      } else if(status === 'FAILED' || stripeStatus === 'failed' || stripeStatus === 'canceled'){
        statusBadge = '<span class="badge bg-danger">Fallido</span>';
      }

      const reasonHtml = isComp && p.complimentary_reason
        ? `<div class="small text-muted mt-1" style="max-width:160px;white-space:normal;">${escapeHTML(p.complimentary_reason)}</div>`
        : (p.external_reference ? `<div class="small text-muted mt-1">Ref: ${escapeHTML(p.external_reference)}</div>` : '');

      return `<tr>
        <td>${safeId}</td>
        <td class="text-center">${safeQty}</td>
        <td>${total}</td>
        <td>${paymentMethodBadge(method)}${reasonHtml}</td>
        <td>${statusBadge}</td>
        <td><small>${escapeHTML(created)}</small></td>
      </tr>`;
    }).join('');
    renderPartnerPaymentsPagination();
  }

  function renderPartnerPaymentsPagination() {
    const container = el('partner-payments-pagination');
    if (!container) return;
    const total = partnerPaymentsData.length;
    const totalPages = Math.ceil(total / PARTNER_PAYMENTS_PAGE_SIZE);
    if (totalPages <= 1) { container.innerHTML = ''; return; }
    let html = '<nav aria-label="Páginas de compras"><ul class="pagination pagination-sm justify-content-center mb-0">';
    html += `<li class="page-item ${currentPartnerPaymentsPage === 1 ? 'disabled' : ''}"><a class="page-link" href="#" data-pp-page="${currentPartnerPaymentsPage - 1}">«</a></li>`;
    for (let i = 1; i <= totalPages; i++) {
      html += `<li class="page-item ${i === currentPartnerPaymentsPage ? 'active' : ''}"><a class="page-link" href="#" data-pp-page="${i}">${i}</a></li>`;
    }
    html += `<li class="page-item ${currentPartnerPaymentsPage === totalPages ? 'disabled' : ''}"><a class="page-link" href="#" data-pp-page="${currentPartnerPaymentsPage + 1}">»</a></li>`;
    html += '</ul></nav>';
    container.innerHTML = html;
    container.querySelectorAll('[data-pp-page]').forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        const p = parseInt(a.dataset.ppPage);
        if (p >= 1 && p <= totalPages) renderPartnerPaymentsPage(p);
      });
    });
  }

  async function loadPartnerPayments(){
    const pid = getPartnerIdFromJwt();
    if(!pid){ return; }

    const tbody = el('partner-payments-table-body');
    if(!tbody){ return; }

    try {
      const resp = await safeFetch(apiUrl.replace(':8080', ':8081') + `/partner/${pid}/payments`, { headers: authHeaders() });
      const data = await resp.json();

      if(!resp.ok || !Array.isArray(data) || data.length === 0){
        partnerPaymentsData = [];
        tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted p-3">No hay compras registradas</td></tr>';
        const pg = el('partner-payments-pagination'); if(pg) pg.innerHTML = '';
        return;
      }

      partnerPaymentsData = data;
      renderPartnerPaymentsPage(1);
    } catch (e) {
      partnerPaymentsData = [];
      tbody.innerHTML = '<tr><td colspan="5" class="text-center text-danger p-3">Error cargando compras</td></tr>';
      const pg = el('partner-payments-pagination'); if(pg) pg.innerHTML = '';
    }
  }

  on('load-stats', 'click', () => loadPartnerStats(true));
  on('load-vouchers', 'click', () => loadPartnerVouchers());
  on('voucher-filter-apply', 'click', () => applyVoucherFilters());
  on('voucher-export-excel', 'click', () => exportFilteredUsedVouchersExcel());
  on('voucher-filter-clear', 'click', () => {
    const co = el('voucher-filter-course');  if(co) co.selectedIndex = 0;
    const cl = el('voucher-filter-client');  if(cl) cl.selectedIndex = 0;
    const p  = el('voucher-filter-period');  if(p)  p.value  = '';
    const df = el('voucher-filter-date-from'); if(df) df.value = '';
    const dt = el('voucher-filter-date-to');   if(dt) dt.value = '';
    const cd = el('voucher-filter-custom-dates'); if(cd) cd.style.display = 'none';
    applyVoucherFilters();
  });
  on('voucher-filter-period', 'change', () => {
    const p  = el('voucher-filter-period');
    const cd = el('voucher-filter-custom-dates');
    if(cd) cd.style.display = (p && p.value === 'custom') ? '' : 'none';
  });

  let _availableCourses = [];

  async function loadCoursesForActivation(){
    const pid = getPartnerIdFromJwt();
    if(!pid){ return; }

    const select = el('activate-course-id');
    if(!select){ return; }

    try {
      select.innerHTML = '<option value="">Cargando certificaciones...</option>';
      const resp = await safeFetch(apiUrl.replace(':8080', ':8081') + `/partner/${pid}/courses`, { headers: authHeaders() });
      const data = await resp.json();

      if(!resp.ok || !Array.isArray(data) || data.length === 0){
        select.innerHTML = '<option value="">No hay certificaciones disponibles</option>';
        _availableCourses = [];
        return;
      }

      _availableCourses = data;
      select.innerHTML = '<option value="">Selecciona una certificación</option>' +
        data.map(c => `<option value="${escapeHTML(String(c.id))}">${escapeHTML(c.id + ' - ' + c.name)}</option>`).join('');
      loadActivationMonthsSelect();
    } catch (e) {
      select.innerHTML = '<option value="">Error cargando certificaciones</option>';
      _availableCourses = [];
    }
  }

  let _maxActivationMonths = 12;

  async function loadActivationMonthsSelect(){
    const select = el('activate-months');
    if(!select) return;
    try {
      const resp = await safeFetch(apiUrl.replace(':8080', ':8081') + '/partner/settings', { headers: authHeaders() });
      if(resp.ok){
        const data = await resp.json();
        _maxActivationMonths = data.max_activation_months || 12;
      }
    } catch(e) { /* use default */ }
    const maxLabel = el('activate-months-max-label');
    if(maxLabel) maxLabel.textContent = `(máx. ${_maxActivationMonths} meses)`;
    const prevVal = parseInt(select.value) || _maxActivationMonths;
    select.innerHTML = '';
    for(let i = 1; i <= _maxActivationMonths; i++){
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = i === 12 ? '12 meses (1 año)' : i === 1 ? '1 mes' : `${i} meses`;
      if(i === Math.min(prevVal, _maxActivationMonths)) opt.selected = true;
      select.appendChild(opt);
    }
    if(!select.value) select.value = String(_maxActivationMonths);
  }

  async function loadActivationEligibility(){
    const pid = getPartnerIdFromJwt();
    if(!pid){ return; }

    const activateBtn = el('activate-btn');
    const countBadge  = el('activate-available-count');
    const noBadge     = el('activate-no-vouchers');
    const countNum    = el('activate-count-num');

    try {
      const resp = await safeFetch(apiUrl.replace(':8080', ':8081') + `/partner/${pid}/activation-eligibility`, { headers: authHeaders() });
      const data = await resp.json();

      if(!resp.ok){
        if(countBadge) countBadge.style.display = 'none';
        if(noBadge)    noBadge.style.display = 'inline-block';
        if(activateBtn) activateBtn.disabled = true;
        return;
      }

      if(data.can_activate){
        if(countNum)    countNum.textContent = data.available_paid_vouchers;
        if(countBadge)  countBadge.style.display = 'inline-block';
        if(noBadge)     noBadge.style.display = 'none';
        if(activateBtn) activateBtn.disabled = false;
      } else {
        if(countBadge)  countBadge.style.display = 'none';
        if(noBadge)     noBadge.style.display = 'inline-block';
        if(activateBtn) activateBtn.disabled = true;
      }
    } catch (e) {
      if(countBadge) countBadge.style.display = 'none';
      if(noBadge)    noBadge.style.display = 'inline-block';
      if(activateBtn) activateBtn.disabled = true;
      activateBtn.disabled = true;
    }
  }

  // Activar voucher — primero muestra confirmación
  on('activate-btn', 'click', () => {
    const pid = getPartnerIdFromJwt();
    if(!pid){ showToast('No se pudo obtener Partner ID', 'danger'); return; }
    const courseId = (el('activate-course-id') || {}).value || '';
    const firstname = (el('activate-firstname') || {}).value.trim() || '';
    const lastname  = (el('activate-lastname')  || {}).value.trim() || '';
    const name = firstname && lastname ? `${firstname} ${lastname}` : (firstname || lastname);
    const email = (el('activate-email') || {}).value || '';
    const finalClient = (el('activate-final-client') || {}).value || '';
    if(!courseId || !firstname || !lastname || !email || !finalClient){ showToast('Completa todos los campos del formulario', 'warning'); return; }
    const courseName = (el('activate-course-id') || {}).options?.[(el('activate-course-id')||{}).selectedIndex]?.text || courseId;
    const months = parseInt((el('activate-months') || {}).value || '12');
    const infoEl = el('confirm-activate-info');
    if(infoEl) infoEl.innerHTML = `Certificación: <strong>${escapeHTML(courseName)}</strong><br>Usuario: <strong>${escapeHTML(name)}</strong> — ${escapeHTML(email)}<br>Cliente: <strong>${escapeHTML(finalClient)}</strong><br>Disponibilidad: <strong>${months} mes(es)</strong>`;
    bootstrap.Modal.getOrCreateInstance(document.getElementById('confirmActivateModal')).show();
  });

  on('btn-do-activate', 'click', async () => {
    const pid = getPartnerIdFromJwt();
    const btn = el('btn-do-activate');
    const courseId = (el('activate-course-id') || {}).value || '';
    const firstname = (el('activate-firstname') || {}).value.trim() || '';
    const lastname  = (el('activate-lastname')  || {}).value.trim() || '';
    const name = firstname && lastname ? `${firstname} ${lastname}` : (firstname || lastname);
    const email = (el('activate-email') || {}).value || '';
    const finalClient = (el('activate-final-client') || {}).value || '';
    const months = parseInt((el('activate-months') || {}).value || '12');
    try{
      setButtonLoading(btn, true);
      const resp = await safeFetch(apiUrl.replace(':8080', ':8081') + `/partner/${pid}/activate`, { method:'POST', headers: authHeaders(), body: JSON.stringify({ course_id: parseInt(courseId, 10), user_name: name, user_email: email, final_client: finalClient, activation_months: months }) });
      const data = await resp.json();
      setButtonLoading(btn, false);
      bootstrap.Modal.getInstance(document.getElementById('confirmActivateModal')).hide();
      if(resp.ok){
        if(el('activate-course-id')) el('activate-course-id').value = '';
        if(el('activate-firstname')) el('activate-firstname').value = '';
        if(el('activate-lastname'))  el('activate-lastname').value = '';
        if(el('activate-email')) el('activate-email').value = '';
        if(el('activate-final-client')) el('activate-final-client').value = '';
        const ms = (data.moodle_status || '').toUpperCase();
        let moodleMsg = '';
        if(ms === 'ENROLLED') {
          moodleMsg = ' — ✓ Matriculado en Moodle';
          if(data.moodle_username && data.moodle_temp_password) {
            moodleMsg += `<br><small>👤 Usuario: <strong>${escapeHTML(data.moodle_username)}</strong> &nbsp; 🔑 Contraseña inicial: <strong>${escapeHTML(data.moodle_temp_password)}</strong></small>`;
          }
        } else if(ms === 'MOCKED')  moodleMsg = ' — Acceso Moodle: Simulado';
        else if(ms === 'FAILED')    moodleMsg = ' — Acceso Moodle: ⚠ Error (reintentar desde Admin)';
        else if(ms === 'SKIPPED')   moodleMsg = ' — Sin certificación Moodle configurada';
        const expiryInfo = data.expires_at ? ` — Disponible hasta: ${new Date(data.expires_at).toLocaleDateString('es-ES')}` : '';
        showToast(`Voucher activado — Certificación: ${data.course_name || ''}${moodleMsg}${expiryInfo}`, ms === 'FAILED' ? 'warning' : 'success', 8000);
        loadPartnerVouchers();
        loadPartnerStats(false);
        loadActivationEligibility();
      } else {
        showToast(data.error || 'No se pudo activar el voucher', 'danger', 5000);
      }
    }catch(e){
      setButtonLoading(btn, false);
      showToast('Error: ' + e.message, 'danger');
    }
  });

  // ── Clientes finales ────────────────────────────────────────────────────────

  let _partnerFinalClients = [];

  async function loadPartnerFinalClients(){
    const pid = getPartnerIdFromJwt();
    if(!pid) return;
    const tbody = el('final-clients-tbody');
    if(!tbody) return;
    try {
      const resp = await safeFetch(apiUrl.replace(':8080', ':8081') + `/partner/${pid}/final-clients`, { headers: authHeaders() });
      const data = await safeJson(resp);
      _partnerFinalClients = Array.isArray(data) ? data : [];
      renderFinalClientsTable();
    } catch(e) {
      if(tbody) tbody.innerHTML = `<tr><td colspan="3" class="text-center text-danger p-3">${escapeHTML(e.message)}</td></tr>`;
    }
  }

  function renderFinalClientsTable(){
    const tbody = el('final-clients-tbody');
    const countEl = el('final-clients-count');
    if(countEl) countEl.textContent = _partnerFinalClients.length;
    if(!tbody) return;
    if(!_partnerFinalClients.length){
      tbody.innerHTML = '<tr><td colspan="3" class="text-center text-muted p-3">Aún no tienes clientes registrados</td></tr>';
      return;
    }
    tbody.innerHTML = _partnerFinalClients.map(c => `
      <tr data-client-id="${c.id}">
        <td class="text-center">
          <span class="client-name-text">${escapeHTML(c.name)}</span>
          <input type="text" class="form-control form-control-sm client-name-input" value="${escapeHTML(c.name)}" maxlength="200" style="display:none;max-width:320px;margin:0 auto;">
        </td>
        <td class="text-center">${c.created_at ? new Date(c.created_at).toLocaleDateString('es-ES') : '-'}</td>
        <td class="text-center" style="white-space:nowrap;">
          <button class="btn btn-sm btn-outline-secondary edit-final-client-btn me-1" data-id="${c.id}" title="Editar">✏️</button>
          <button class="btn btn-sm btn-success save-final-client-btn me-1" data-id="${c.id}" style="display:none;" title="Guardar">💾</button>
          <button class="btn btn-sm btn-outline-secondary cancel-final-client-btn me-1" data-id="${c.id}" style="display:none;" title="Cancelar">✕</button>
          <button class="btn btn-sm btn-outline-danger delete-final-client-btn" data-id="${c.id}" data-name="${escapeHTML(c.name)}" title="Eliminar">🗑</button>
        </td>
      </tr>`).join('');

    // Editar
    tbody.querySelectorAll('.edit-final-client-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const row = tbody.querySelector(`tr[data-client-id="${btn.dataset.id}"]`);
        row.querySelector('.client-name-text').style.display  = 'none';
        row.querySelector('.client-name-input').style.display = '';
        btn.style.display = 'none';
        row.querySelector('.save-final-client-btn').style.display   = '';
        row.querySelector('.cancel-final-client-btn').style.display = '';
        row.querySelector('.client-name-input').focus();
      });
    });

    // Cancelar edición
    tbody.querySelectorAll('.cancel-final-client-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const row = tbody.querySelector(`tr[data-client-id="${btn.dataset.id}"]`);
        row.querySelector('.client-name-text').style.display  = '';
        row.querySelector('.client-name-input').style.display = 'none';
        row.querySelector('.edit-final-client-btn').style.display   = '';
        row.querySelector('.save-final-client-btn').style.display   = 'none';
        btn.style.display = 'none';
      });
    });

    // Guardar edición
    tbody.querySelectorAll('.save-final-client-btn').forEach(btn => {
      const doSave = async () => {
        const cid  = btn.dataset.id;
        const pid  = getPartnerIdFromJwt();
        const row  = tbody.querySelector(`tr[data-client-id="${cid}"]`);
        const name = row.querySelector('.client-name-input').value.trim();
        if(!name){ showFinalClientMessage('El nombre no puede estar vacío', 'warning'); return; }
        try {
          btn.disabled = true;
          const resp = await safeFetch(apiUrl.replace(':8080', ':8081') + `/partner/${pid}/final-clients/${cid}`, {
            method: 'PUT', headers: authHeaders(), body: JSON.stringify({ name })
          });
          const data = await safeJson(resp);
          btn.disabled = false;
          if(resp.ok){
            const idx = _partnerFinalClients.findIndex(c => String(c.id) === String(cid));
            if(idx !== -1) _partnerFinalClients[idx].name = data.name;
            _partnerFinalClients.sort((a, b) => a.name.localeCompare(b.name));
            renderFinalClientsTable();
            syncFinalClientsSelect();
            showFinalClientMessage(`Cliente actualizado a "${data.name}"`, 'success');
          } else {
            showFinalClientMessage(data.error || 'No se pudo actualizar', 'danger');
          }
        } catch(e) { btn.disabled = false; showFinalClientMessage('Error: ' + e.message, 'danger'); }
      };
      btn.addEventListener('click', doSave);
      // También guardar con Enter
      const row = tbody.querySelector(`tr[data-client-id="${btn.dataset.id}"]`);
      row.querySelector('.client-name-input').addEventListener('keydown', e => { if(e.key === 'Enter') doSave(); });
    });

    // Eliminar
    tbody.querySelectorAll('.delete-final-client-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const nameLabel = el('delete-client-name-label');
        if(nameLabel) nameLabel.textContent = btn.dataset.name;
        el('delete-client-id').value = btn.dataset.id;
        bootstrap.Modal.getOrCreateInstance(document.getElementById('deleteFinalClientModal')).show();
      });
    });
  }

  function showFinalClientMessage(msg, type){
    showToast(msg, type);
  }

  // Confirmar eliminación de cliente final
  on('btn-confirm-delete-client', 'click', async () => {
    const btn = el('btn-confirm-delete-client');
    const cid = (el('delete-client-id')||{}).value;
    const pid = getPartnerIdFromJwt();
    if(!cid || !pid) return;
    try {
      setButtonLoading(btn, true);
      const resp = await safeFetch(apiUrl.replace(':8080', ':8081') + `/partner/${pid}/final-clients/${cid}`, { method: 'DELETE', headers: authHeaders() });
      setButtonLoading(btn, false);
      if(resp.ok){
        _partnerFinalClients = _partnerFinalClients.filter(c => String(c.id) !== String(cid));
        renderFinalClientsTable();
        syncFinalClientsSelect();
        bootstrap.Modal.getInstance(document.getElementById('deleteFinalClientModal')).hide();
        showToast('Cliente eliminado correctamente', 'success');
      } else {
        const d = await safeJson(resp);
        showToast(d.error || 'No se pudo eliminar', 'danger');
      }
    } catch(e) { setButtonLoading(btn, false); showToast('Error: ' + e.message, 'danger'); }
  });

  on('create-final-client-btn', 'click', () => {
    const pid  = getPartnerIdFromJwt();
    if(!pid) return;
    const nameInput = el('new-final-client-name');
    const name = (nameInput || {}).value.trim();
    if(!name){ showFinalClientMessage('Escribe un nombre para el cliente', 'warning'); return; }

    const nameLabel = el('create-client-name-label');
    const nameValue = el('create-client-name-value');
    if(nameLabel) nameLabel.textContent = name;
    if(nameValue) nameValue.value = name;
    bootstrap.Modal.getOrCreateInstance(document.getElementById('createFinalClientModal')).show();
  });

  on('btn-confirm-create-client', 'click', async () => {
    const pid  = getPartnerIdFromJwt();
    if(!pid) return;
    const nameInput = el('new-final-client-name');
    const nameValue = el('create-client-name-value');
    const name = ((nameValue || {}).value || '').trim();
    if(!name){ showFinalClientMessage('Escribe un nombre para el cliente', 'warning'); return; }

    const btn = el('btn-confirm-create-client');
    try {
      setButtonLoading(btn, true);
      const resp = await safeFetch(apiUrl.replace(':8080', ':8081') + `/partner/${pid}/final-clients`, {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ name })
      });
      const data = await safeJson(resp);
      setButtonLoading(btn, false);
      if(resp.ok){
        _partnerFinalClients.push(data);
        _partnerFinalClients.sort((a, b) => a.name.localeCompare(b.name));
        renderFinalClientsTable();
        syncFinalClientsSelect();
        if(nameInput) nameInput.value = '';
        if(nameValue) nameValue.value = '';
        bootstrap.Modal.getInstance(document.getElementById('createFinalClientModal')).hide();
        showFinalClientMessage(`Cliente "${data.name}" agregado`, 'success');
      } else {
        showFinalClientMessage(data.error || 'No se pudo crear el cliente', 'danger');
      }
    } catch(e) {
      setButtonLoading(btn, false);
      showFinalClientMessage('Error: ' + e.message, 'danger');
    }
  });

  async function loadFinalClientsForSelect(){
    const pid = getPartnerIdFromJwt();
    if(!pid) return;
    try {
      const resp = await safeFetch(apiUrl.replace(':8080', ':8081') + `/partner/${pid}/final-clients`, { headers: authHeaders() });
      const data = await safeJson(resp);
      _partnerFinalClients = Array.isArray(data) ? data : [];
      syncFinalClientsSelect();
    } catch(e) { /* silencioso — el select queda vacío */ }
  }

  function syncFinalClientsSelect(){
    const select = el('activate-final-client');
    if(!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">Selecciona un cliente final</option>' +
      _partnerFinalClients.map(c => `<option value="${escapeHTML(c.name)}"${c.name === current ? ' selected' : ''}>${escapeHTML(c.name)}</option>`).join('');
  }

  // ── Activación masiva por Excel / CSV ──────────────────────────────────────

  function parseCSVRows(text){
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if(lines.length < 2) return [];
    const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    return lines.slice(1).map(line => {
      const values = [];
      let cur = '', inQuote = false;
      for(let i = 0; i < line.length; i++){
        const ch = line[i];
        if(ch === '"'){ inQuote = !inQuote; }
        else if(ch === ',' && !inQuote){ values.push(cur); cur = ''; }
        else { cur += ch; }
      }
      values.push(cur);
      const obj = {};
      headers.forEach((h, idx) => { obj[h] = (values[idx] || '').trim().replace(/^"|"$/g, ''); });
      return obj;
    });
  }

  on('download-activation-template', 'click', () => {
    if(!window.XLSX){ showLoginMessage('Librería Excel no cargada. Recarga la página.', 'danger', 4000); return; }

    const wb = window.XLSX.utils.book_new();

    // Sheet 1: plantilla de activaciones
    const templateData = [
      ['course_id', 'user_name', 'user_email', 'final_client', 'activation_months'],
      [1, 'Juan Perez', 'juan@ejemplo.com', 'Empresa ABC', _maxActivationMonths],
      [2, 'Maria Lopez', 'maria@ejemplo.com', 'Empresa XYZ', _maxActivationMonths],
    ];
    const wsTemplate = window.XLSX.utils.aoa_to_sheet(templateData);
    wsTemplate['!cols'] = [{ wch: 12 }, { wch: 25 }, { wch: 30 }, { wch: 25 }, { wch: 20 }];
    window.XLSX.utils.book_append_sheet(wb, wsTemplate, 'Activaciones');

    // Sheet 2: catálogo de cursos disponibles
    const catalogHeader = [['course_id', 'course_name']];
    const catalogRows = _availableCourses.length
      ? _availableCourses.map(c => [c.id, c.name])
      : [[1, '(carga la sección primero para ver cursos reales)']];
    const wsCatalog = window.XLSX.utils.aoa_to_sheet(catalogHeader.concat(catalogRows));
    wsCatalog['!cols'] = [{ wch: 12 }, { wch: 50 }];
    window.XLSX.utils.book_append_sheet(wb, wsCatalog, 'Certificaciones disponibles');

    window.XLSX.writeFile(wb, 'plantilla_activacion_vouchers.xlsx');
  });

  on('activate-bulk-btn', 'click', async () => {
    const pid = getPartnerIdFromJwt();
    if(!pid){ showLoginMessage('No se pudo obtener Partner ID', 'danger', 3000); return; }

    const fileInput = el('activate-excel-file');
    const file = fileInput && fileInput.files[0];
    if(!file){ showLoginMessage('Selecciona un archivo primero', 'warning', 3000); return; }

    const resultsEl    = el('bulk-activate-results');
    const progressEl   = el('bulk-activate-progress');
    const progressBar  = el('bulk-progress-bar');
    const progressText = el('bulk-progress-text');
    const btn          = el('activate-bulk-btn');

    if(resultsEl)  resultsEl.innerHTML = '';
    if(progressEl) { progressEl.style.display = ''; }
    if(progressBar){ progressBar.style.width = '0%'; progressBar.textContent = '0%'; }
    if(btn) btn.disabled = true;

    try {
      let rows = [];
      const ext = file.name.split('.').pop().toLowerCase();

      if(ext === 'csv'){
        const text = await file.text();
        rows = parseCSVRows(text);
      } else if(ext === 'xlsx' || ext === 'xls'){
        if(!window.XLSX){ showLoginMessage('Librería Excel no cargada. Recarga la página.', 'danger', 4000); if(btn) btn.disabled = false; return; }
        const buffer = await file.arrayBuffer();
        const wb = window.XLSX.read(buffer, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        rows = window.XLSX.utils.sheet_to_json(ws, { defval: '' });
      } else {
        showLoginMessage('Formato no soportado. Usa .xlsx, .xls o .csv', 'warning', 3000);
        if(btn) btn.disabled = false; return;
      }

      if(!rows.length){
        showLoginMessage('El archivo está vacío o no contiene datos', 'warning', 3000);
        if(btn) btn.disabled = false; return;
      }

      const requiredCols = ['course_id', 'user_name', 'user_email', 'final_client'];
      const missing = requiredCols.filter(c => !(c in rows[0]));
      if(missing.length){
        showLoginMessage(`Columnas faltantes: ${missing.join(', ')}`, 'danger', 6000);
        if(btn) btn.disabled = false; return;
      }

      // Confirmación antes de procesar
      if(btn) btn.disabled = false;
      await new Promise((resolve, reject) => {
        showConfirmAction({
          title: 'Confirmar Activación Masiva', icon: '📋',
          alert: 'Esta acción activará vouchers de forma masiva e irreversible.',
          rows: [
            { label: 'Archivo:', value: file.name },
            { label: 'Registros a procesar:', value: rows.length },
            { label: 'Primera fila:', value: `${rows[0].user_name || '—'} — ${rows[0].user_email || '—'}` }
          ],
          confirmLabel: `▶ Activar ${rows.length} vouchers`, confirmClass: 'btn-warning',
          onConfirm: () => { if(btn) btn.disabled = true; resolve(); }
        });
        // Si se cancela el modal, no continuamos
        document.getElementById('modal-generic-confirm').addEventListener('hidden.bs.modal', () => reject(new Error('cancelled')), { once: true });
      }).catch(() => { return; });

      const results = [];
      for(let i = 0; i < rows.length; i++){
        const row = rows[i];
        const courseId   = parseInt(row.course_id, 10);
        const userName   = String(row.user_name   || '').trim();
        const userEmail  = String(row.user_email  || '').trim();
        const finalClient = String(row.final_client || '').trim();
        const actMonths  = parseInt(row.activation_months || _maxActivationMonths, 10) || _maxActivationMonths;

        const pct = Math.round((i / rows.length) * 100);
        if(progressBar){ progressBar.style.width = pct + '%'; progressBar.textContent = pct + '%'; }
        if(progressText) progressText.textContent = `Procesando fila ${i + 1} de ${rows.length}…`;

        if(!courseId || !userName || !userEmail || !finalClient){
          results.push({ row: i + 2, ok: false, error: 'Fila incompleta o datos inválidos', userName, userEmail });
          continue;
        }

        try {
          const resp = await safeFetch(apiUrl.replace(':8080', ':8081') + `/partner/${pid}/activate`, {
            method: 'POST', headers: authHeaders(),
            body: JSON.stringify({ course_id: courseId, user_name: userName, user_email: userEmail, final_client: finalClient, activation_months: actMonths })
          });
          const data = await resp.json();
          if(resp.ok){
            results.push({ row: i + 2, ok: true, voucher: data.voucher_code, course: data.course_name, userName, userEmail });
          } else {
            results.push({ row: i + 2, ok: false, error: data.error || 'Error desconocido', userName, userEmail });
          }
        } catch(e){
          results.push({ row: i + 2, ok: false, error: e.message, userName, userEmail });
        }
      }

      if(progressBar){ progressBar.style.width = '100%'; progressBar.textContent = '100%'; progressBar.classList.remove('progress-bar-animated'); }
      const okCount   = results.filter(r => r.ok).length;
      const failCount = results.filter(r => !r.ok).length;
      if(progressText) progressText.textContent = `Completado: ${okCount} exitosos, ${failCount} fallidos de ${rows.length} filas.`;

      let html = `<div class="alert ${failCount === 0 ? 'alert-success' : (okCount === 0 ? 'alert-danger' : 'alert-warning')} mb-3">
        <strong>${okCount} activaciones exitosas</strong>${failCount > 0 ? `, <strong>${failCount} fallidas</strong>` : ''} de ${rows.length} filas procesadas.
      </div>
      <div class="table-responsive"><table class="table table-sm table-bordered">
        <thead class="table-light"><tr><th>Fila</th><th>Usuario</th><th>Email</th><th>Resultado</th></tr></thead><tbody>`;
      results.forEach(r => {
        const badge = r.ok
          ? `<span class="badge bg-success">✓ Voucher: ${escapeHTML(r.voucher || '')}</span>`
          : `<span class="badge bg-danger">✗ ${escapeHTML(r.error || '')}</span>`;
        html += `<tr>
          <td class="text-center">${r.row}</td>
          <td>${escapeHTML(r.userName || '')}</td>
          <td>${escapeHTML(r.userEmail || '')}</td>
          <td>${badge}</td>
        </tr>`;
      });
      html += '</tbody></table></div>';
      if(resultsEl) resultsEl.innerHTML = html;

      if(okCount > 0){
        loadPartnerVouchers();
        loadPartnerStats(false);
        loadActivationEligibility();
      }

    } catch(e){
      showLoginMessage('Error procesando archivo: ' + escapeHTML(e.message), 'danger', 5000);
    } finally {
      if(btn) btn.disabled = false;
      if(fileInput) fileInput.value = '';
    }
  });

  // Initial view
  if(getToken()){
    showUser();
    showAppScreen();
    if(userDropdownWrap) userDropdownWrap.style.display = 'block';
    const d = decodeJwt(getToken()) || {};
    if(d.role === 'admin'){
      show(sAdmin);
      document.querySelectorAll('.admin-menu-item').forEach(c => c.classList.remove('active'));
      const dashCard = document.querySelector('.admin-menu-item[data-target="admin-dashboard"]');
      if(dashCard) dashCard.classList.add('active');
      document.querySelectorAll('#admin .content-section').forEach(s => s.classList.remove('active'));
      const dashSection = el('admin-dashboard');
      if(dashSection) dashSection.classList.add('active');
      loadAdminDashboard();
    } else if(d.role === 'partner'){
      show(sPartner);
      loadPartnerStats(false);
      loadCoursesForActivation();
      loadActivationEligibility();
      loadPartnerPayments();
      refreshVoucherPricingPreview();
    }
  } else {
    showLoginScreen();
  }

  updateCartCount();
  renderCartSummary();

  // ── Report download functions ─────────────────────────────────────────────

  // Encabezado visual para PDFs: barra azul oscura + logo + título + fecha
  function _pdfHeader(doc, title, opts = {}){
    const { logoData, dateRange } = opts;
    const pageW = doc.internal.pageSize.getWidth();

    // Barra de cabecera
    doc.setFillColor(15, 52, 120);
    doc.rect(0, 0, pageW, 38, 'F');
    // Línea de acento inferior
    doc.setFillColor(41, 182, 246);
    doc.rect(0, 36, pageW, 2, 'F');

    // Logo
    let textX = 14;
    if(logoData){
      try { doc.addImage(logoData, 'PNG', 10, 5, 27, 27); textX = 44; } catch(e){}
    }

    // Título
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(255, 255, 255);
    doc.text(title, textX, 18);

    // Rango de fechas
    if(dateRange){
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(180, 210, 255);
      doc.text(dateRange, textX, 27);
    }

    // Fecha de generación (derecha)
    const genDate = new Date().toLocaleDateString('es-ES', {day:'2-digit', month:'short', year:'numeric'});
    doc.setFontSize(7.5);
    doc.setTextColor(180, 210, 255);
    doc.text(`Generado: ${genDate}`, pageW - 10, 32, { align: 'right' });

    doc.setTextColor(33, 37, 41);
    doc.setFont('helvetica', 'normal');
    return 44; // startY recomendado para la tabla
  }

  // Pie de página con número de página en todos los folios
  function _pdfFooter(doc){
    const pageCount = doc.internal.getNumberOfPages();
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    for(let i = 1; i <= pageCount; i++){
      doc.setPage(i);
      doc.setDrawColor(210, 210, 210);
      doc.line(10, pageH - 14, pageW - 10, pageH - 14);
      doc.setFontSize(7.5);
      doc.setTextColor(160, 160, 160);
      doc.text('CertJOIN Platform', 14, pageH - 8);
      doc.text(`Página ${i} de ${pageCount}`, pageW - 14, pageH - 8, { align: 'right' });
    }
    doc.setTextColor(33, 37, 41);
  }

  function downloadPartnerReportExcel(){
    if(!window.XLSX){ showLoginMessage('Librería Excel no cargada. Recarga la página.', 'danger', 4000); return; }
    if(!_partnerReportData){ showLoginMessage('Primero carga las estadísticas con "Actualizar".', 'warning', 3000); return; }

    const { stats, payments, vouchers } = _partnerReportData;
    const paidP    = payments.filter(isPaymentPaid);
    const pendingP = payments.filter(p => !isPaymentPaid(p) && !isPaymentFailed(p));
    const failedP  = payments.filter(isPaymentFailed);
    const revenue  = paidP.reduce((s, p) => s + toNumber(p.total_price), 0);
    const avgT     = paidP.length > 0 ? revenue / paidP.length : 0;
    const rate     = stats.total > 0 ? (stats.used / stats.total * 100) : 0;
    const now      = new Date().toLocaleDateString('es-ES');

    const wb = window.XLSX.utils.book_new();

    // Hoja 1 – Resumen
    const wsSummary = window.XLSX.utils.aoa_to_sheet([
      ['CertJOIN Platform'],
      ['Informe de Estadísticas – Partner'],
      [`Generado: ${now}`],
      [],
      ['Métrica', 'Valor'],
      ['Total Vouchers',      stats.total     || 0],
      ['Disponibles',         stats.available || 0],
      ['Consumidos',          stats.used      || 0],
      ['Tasa de uso (%)',     parseFloat(rate.toFixed(2))],
      ['Compras pagadas',     paidP.length],
      ['Compras pendientes',  pendingP.length],
      ['Compras fallidas',    failedP.length],
      ['Ingresos totales',    revenue],
      ['Ticket promedio',     parseFloat(avgT.toFixed(2))],
    ]);
    _xlsxSetColWidths(wsSummary, [30, 18]);
    window.XLSX.utils.book_append_sheet(wb, wsSummary, 'Resumen');

    // Hoja 2 – Vouchers
    const wsVouchers = window.XLSX.utils.aoa_to_sheet([
      ['Código', 'Estado', 'Certificación', 'Consumido por', 'Cliente final', 'Creado', 'Consumido'],
      ...vouchers.map(v => [
        v.code || '', v.status || '', v.course_name || '',
        v.consumed_by || '', v.final_client || '',
        v.created_at  ? new Date(v.created_at).toLocaleDateString('es-ES')  : '',
        v.consumed_at ? new Date(v.consumed_at).toLocaleDateString('es-ES') : '',
      ])
    ]);
    _xlsxSetColWidths(wsVouchers, [20, 14, 28, 22, 22, 13, 13]);
    window.XLSX.utils.book_append_sheet(wb, wsVouchers, 'Vouchers');

    // Hoja 3 – Compras
    const wsPayments = window.XLSX.utils.aoa_to_sheet([
      ['ID', 'Cantidad', 'Total ($)', 'Estado', 'Estado Stripe', 'Fecha'],
      ...payments.map(p => [
        p.id || '', p.qty || 0, toNumber(p.total_price),
        p.status || '', p.stripe_status || '',
        p.created_at ? new Date(p.created_at).toLocaleDateString('es-ES') : '',
      ])
    ]);
    _xlsxSetColWidths(wsPayments, [8, 12, 16, 14, 16, 13]);
    window.XLSX.utils.book_append_sheet(wb, wsPayments, 'Compras');

    window.XLSX.writeFile(wb, `informe_partner_${new Date().toISOString().slice(0,10)}.xlsx`);
  }

  async function downloadPartnerReportPDF(){
    if(!window.jspdf || !window.jspdf.jsPDF){ showLoginMessage('Librería PDF no cargada. Recarga la página.', 'danger', 4000); return; }
    if(!_partnerReportData){ showLoginMessage('Primero carga las estadísticas con "Actualizar".', 'warning', 3000); return; }

    const { jsPDF } = window.jspdf;
    const logoData = await _loadLogo();
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

    const { stats, payments, vouchers } = _partnerReportData;
    const paidP    = payments.filter(isPaymentPaid);
    const pendingP = payments.filter(p => !isPaymentPaid(p) && !isPaymentFailed(p));
    const failedP  = payments.filter(isPaymentFailed);
    const revenue  = paidP.reduce((s, p) => s + toNumber(p.total_price), 0);
    const avgT     = paidP.length > 0 ? revenue / paidP.length : 0;
    const rate     = stats.total > 0 ? (stats.used / stats.total * 100) : 0;

    const hOpts = { logoData };
    const tBase = {
      theme: 'grid',
      styles: { fontSize: 8, cellPadding: 2.5 },
      headStyles: { fillColor: [13, 110, 253], textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [240, 246, 255] },
      tableLineColor: [200, 200, 200], tableLineWidth: 0.1,
    };

    // Página 1 – Resumen
    let startY = _pdfHeader(doc, 'Informe de Estadísticas – Partner', hOpts);
    doc.autoTable({
      ...tBase, startY,
      head: [['Métrica', 'Valor']],
      body: [
        ['Total Vouchers',     String(stats.total     || 0)],
        ['Disponibles',        String(stats.available || 0)],
        ['Consumidos',         String(stats.used      || 0)],
        ['Tasa de uso',        `${rate.toFixed(1)}%`],
        ['Compras pagadas',    String(paidP.length)],
        ['Compras pendientes', String(pendingP.length)],
        ['Compras fallidas',   String(failedP.length)],
        ['Ingresos totales',   formatCurrency(revenue)],
        ['Ticket promedio',    formatCurrency(avgT)],
      ],
      columnStyles: { 0: { fontStyle: 'bold', cellWidth: 70 } },
    });

    // Página 2 – Vouchers
    doc.addPage();
    startY = _pdfHeader(doc, 'Detalle de Vouchers', hOpts);
    doc.autoTable({
      ...tBase, startY,
      head: [['Código', 'Estado', 'Curso', 'Consumido por', 'Cliente final', 'Creado']],
      body: vouchers.map(v => [
        v.code || '', v.status || '', v.course_name || '',
        v.consumed_by || '', v.final_client || '',
        v.created_at ? new Date(v.created_at).toLocaleDateString('es-ES') : '',
      ]),
      columnStyles: { 0: { font: 'courier', fontSize: 7 } },
    });

    // Página 3 – Compras (opcional)
    if(payments.length > 0){
      doc.addPage();
      startY = _pdfHeader(doc, 'Historial de Compras', hOpts);
      doc.autoTable({
        ...tBase, startY,
        head: [['ID', 'Cantidad', 'Total ($)', 'Estado', 'Stripe', 'Fecha']],
        body: payments.map(p => [
          String(p.id || ''), String(p.qty || 0),
          formatCurrency(toNumber(p.total_price)),
          p.status || '', p.stripe_status || '',
          p.created_at ? new Date(p.created_at).toLocaleDateString('es-ES') : '',
        ]),
      });
    }

    _pdfFooter(doc);
    doc.save(`informe_partner_${new Date().toISOString().slice(0,10)}.pdf`);
  }

  function downloadAdminReportExcel(){
    if(!window.XLSX){ showLoginMessage('Librería Excel no cargada. Recarga la página.', 'danger', 4000); return; }
    if(!_adminReportData){ showLoginMessage('Primero carga las estadísticas (global o partner).', 'warning', 3000); return; }

    const { stats, vouchers, partnerInfo } = _adminReportData;
    const now = new Date().toLocaleDateString('es-ES');
    const wb  = window.XLSX.utils.book_new();

    const partnerRows = partnerInfo ? [
      ['Nombre',    partnerInfo.name  || ''],
      ['Email',     partnerInfo.email || ''],
      ['ID',        String(partnerInfo.id || '')],
      ['Categoría', partnerInfo.pricing_profile_name || partnerInfo.pricing_profile_code || ''],
    ] : [];

    const wsSummary = window.XLSX.utils.aoa_to_sheet([
      ['CertJOIN Platform'],
      ['Informe de Partner – Administrador'],
      [`Generado: ${now}`],
      [],
      ...(partnerRows.length ? [['── Información del Partner ──'], ...partnerRows, []] : []),
      ['── Estadísticas ──'],
      ['Total Vouchers',  stats.total     || 0],
      ['Disponibles',     stats.available || 0],
      ['Consumidos',      stats.used      || 0],
    ]);
    _xlsxSetColWidths(wsSummary, [32, 22]);
    window.XLSX.utils.book_append_sheet(wb, wsSummary, 'Resumen');

    const wsVouchers = window.XLSX.utils.aoa_to_sheet([
      ['Código', 'Estado', 'Curso', 'Usuario', 'Cliente final', 'Compra ID', 'Creado', 'Consumido'],
      ...vouchers.map(v => [
        v.code || '', v.status || '', v.course_name || '',
        v.consumed_by || '', v.final_client || '',
        v.purchase_id != null ? String(v.purchase_id) : '',
        v.created_at  ? new Date(v.created_at).toLocaleDateString('es-ES')  : '',
        v.consumed_at ? new Date(v.consumed_at).toLocaleDateString('es-ES') : '',
      ])
    ]);
    _xlsxSetColWidths(wsVouchers, [20, 14, 28, 22, 22, 11, 13, 13]);
    window.XLSX.utils.book_append_sheet(wb, wsVouchers, 'Vouchers');

    const partnerSlug = partnerInfo ? String(partnerInfo.id) : 'admin';
    window.XLSX.writeFile(wb, `informe_admin_partner${partnerSlug}_${new Date().toISOString().slice(0,10)}.xlsx`);
  }

  async function downloadAdminReportPDF(){
    if(!window.jspdf || !window.jspdf.jsPDF){ showLoginMessage('Librería PDF no cargada. Recarga la página.', 'danger', 4000); return; }
    if(!_adminReportData){ showLoginMessage('Primero carga las estadísticas (global o partner).', 'warning', 3000); return; }

    const { jsPDF } = window.jspdf;
    const logoData = await _loadLogo();
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

    const { stats, vouchers, partnerInfo } = _adminReportData;
    const hOpts = { logoData };
    const tBase = {
      theme: 'grid',
      styles: { fontSize: 8, cellPadding: 2.5 },
      headStyles: { fillColor: [220, 53, 69], textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [255, 243, 243] },
      tableLineColor: [200, 200, 200], tableLineWidth: 0.1,
    };

    // Página 1 – Resumen
    let startY = _pdfHeader(doc, 'Informe de Partner – Administrador', hOpts);

    const summaryBody = [];
    if(partnerInfo){
      summaryBody.push(
        ['Partner',   partnerInfo.name  || '-'],
        ['Email',     partnerInfo.email || '-'],
        ['ID',        String(partnerInfo.id || '-')],
        ['Categoría', partnerInfo.pricing_profile_name || partnerInfo.pricing_profile_code || '-'],
      );
    }
    summaryBody.push(
      ['Total Vouchers', String(stats.total     || 0)],
      ['Disponibles',    String(stats.available || 0)],
      ['Consumidos',     String(stats.used      || 0)],
    );

    doc.autoTable({
      ...tBase, startY,
      head: [['Campo', 'Valor']],
      body: summaryBody,
      columnStyles: { 0: { fontStyle: 'bold', cellWidth: 65 } },
    });

    // Página 2 – Vouchers
    doc.addPage();
    startY = _pdfHeader(doc, `Vouchers${partnerInfo ? ' – ' + (partnerInfo.name || partnerInfo.id) : ''}`, hOpts);
    doc.autoTable({
      ...tBase, startY,
      head: [['Código', 'Estado', 'Curso', 'Usuario', 'Cliente final', 'Compra ID', 'Creado']],
      body: vouchers.map(v => [
        v.code || '', v.status || '', v.course_name || '',
        v.consumed_by || '', v.final_client || '',
        v.purchase_id != null ? String(v.purchase_id) : '',
        v.created_at ? new Date(v.created_at).toLocaleDateString('es-ES') : '',
      ]),
      columnStyles: { 0: { font: 'courier', fontSize: 7 } },
    });

    _pdfFooter(doc);
    const partnerSlug = partnerInfo ? String(partnerInfo.id) : 'admin';
    doc.save(`informe_admin_partner${partnerSlug}_${new Date().toISOString().slice(0,10)}.pdf`);
  }

  on('partner-download-excel', 'click', downloadPartnerReportExcel);
  on('partner-download-pdf',   'click', downloadPartnerReportPDF);
  on('admin-download-excel',   'click', downloadAdminReportExcel);
  on('admin-download-pdf',     'click', downloadAdminReportPDF);

  // Handle checkout result from Stripe
  checkoutResultHandler();

  // Counter animation function
  function animateCounters() {
    const counters = document.querySelectorAll('.counter-number');
    counters.forEach(counter => {
      if (counter.dataset.animated) return;
      
      const target = parseInt(counter.dataset.target) || 0;
      const duration = 2000; // 2 seconds
      const start = 0;
      const increment = target / (duration / 16); // 60fps
      let current = start;

      const timer = setInterval(() => {
        current += increment;
        if (current >= target) {
          counter.textContent = target + (target >= 90 && target <= 100 ? '%' : '+');
          clearInterval(timer);
          counter.dataset.animated = 'true';
        } else {
          counter.textContent = Math.floor(current) + (target >= 90 && target <= 100 ? '%' : '+');
        }
      }, 16);
    });
  }

  // Intersection Observer for counter animation
  const observerOptions = {
    threshold: 0.5,
    rootMargin: '0px'
  };

  const counterObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        animateCounters();
      }
    });
  }, observerOptions);

  // Observe stats counter section
  const statsSection = document.querySelector('.stats-counter-section');
  if (statsSection) {
    counterObserver.observe(statsSection);
  }
});
