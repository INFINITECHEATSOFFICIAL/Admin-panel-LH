'use strict';

const API = '/api/admin';
let TOKEN = localStorage.getItem('lh_token') || null;
let usersPage = 1;

// ── Fetch helper ──────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

  const res = await fetch(API + path, { ...opts, headers });
  if (res.status === 401) {
    logout();
    throw new Error('Session expired');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || body.errors?.join(', ') || 'Request failed');
  return body;
}

function toast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${type}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 3000);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Auth ──────────────────────────────────────────────────────────────────
function logout() {
  TOKEN = null;
  localStorage.removeItem('lh_token');
  document.getElementById('app').classList.add('hidden');
  document.getElementById('loginScreen').classList.remove('hidden');
}

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  try {
    const res = await fetch(API + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Login failed');
    TOKEN = body.token;
    localStorage.setItem('lh_token', TOKEN);
    boot();
  } catch (err) {
    errEl.textContent = err.message;
  }
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  try { await api('/auth/logout', { method: 'POST' }); } catch (_) {}
  logout();
});

// ── Navigation ────────────────────────────────────────────────────────────
const views = ['dashboard', 'courses', 'users', 'premium', 'notices', 'appcontrol', 'settings'];
const titles = { dashboard: 'Dashboard', courses: 'Courses', users: 'Users', premium: 'Premium', notices: 'Notices', appcontrol: 'App Control', settings: 'Settings' };

function showView(name) {
  views.forEach((v) => document.getElementById(`view-${v}`).classList.toggle('hidden', v !== name));
  document.querySelectorAll('.nav-item').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === name));
  document.getElementById('viewTitle').textContent = titles[name];
  if (name === 'dashboard') loadDashboard();
  if (name === 'courses') loadCourses();
  if (name === 'users') loadUsers();
  if (name === 'premium') loadPremium();
  if (name === 'notices') loadNotices();
  if (name === 'appcontrol') loadAppControl();
}
document.querySelectorAll('.nav-item').forEach((btn) => btn.addEventListener('click', () => showView(btn.dataset.view)));

// ── Modal helper ──────────────────────────────────────────────────────────
function openModal(html) {
  document.getElementById('modalBox').innerHTML = html;
  document.getElementById('modalOverlay').classList.remove('hidden');
}
function closeModal() {
  document.getElementById('modalOverlay').classList.add('hidden');
}
document.getElementById('modalOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'modalOverlay') closeModal();
});

// ── Dashboard ─────────────────────────────────────────────────────────────
let growthChartInstance = null;

async function loadDashboard() {
  try {
    const { data } = await api('/stats');
    document.getElementById('statTotalUsers').textContent = data.totalUsers;
    document.getElementById('statActiveToday').textContent = data.activeToday;
    document.getElementById('statTotalCourses').textContent = data.totalCourses;
    document.getElementById('statPremiumUsers').textContent = data.premiumUsers;
    setStatusBadge(data.appStatus);

    const feed = document.getElementById('activityFeed');
    feed.innerHTML = data.recentActivity.length
      ? data.recentActivity.map((l) => `<li>${esc(l.action.replace(/_/g, ' '))}<span class="ts">${esc(l.timestamp)}</span></li>`).join('')
      : '<li class="muted">No activity yet</li>';

    const growth = await api('/stats/growth?days=30');
    renderGrowthChart(growth.data);
  } catch (err) { toast(err.message, 'error'); }
}

function renderGrowthChart(rows) {
  const ctx = document.getElementById('growthChart');
  const labels = rows.map((r) => r.day);
  const values = rows.map((r) => r.count);
  if (growthChartInstance) growthChartInstance.destroy();
  growthChartInstance = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [{ label: 'New users', data: values, borderColor: '#6C63FF', backgroundColor: '#6C63FF33', tension: 0.35, fill: true }] },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#6A6A8E' }, grid: { color: '#26264A' } },
        y: { ticks: { color: '#6A6A8E' }, grid: { color: '#26264A' }, beginAtZero: true },
      },
    },
  });
}

function setStatusBadge(status) {
  const badge = document.getElementById('appStatusBadge');
  badge.textContent = status;
  badge.className = 'badge ' + (status === 'ALIVE' ? 'badge-ok' : status === 'MAINTENANCE' ? 'badge-warn' : 'badge-danger');
}

// ── Courses ───────────────────────────────────────────────────────────────
async function loadCourses(search = '') {
  try {
    const q = search ? `?search=${encodeURIComponent(search)}&pageSize=100` : '?pageSize=100';
    const { data } = await api('/courses' + q);
    const list = document.getElementById('courseList');
    list.innerHTML = data.length
      ? data.map(courseRow).join('')
      : '<p class="muted">No courses yet. Add your first one.</p>';
  } catch (err) { toast(err.message, 'error'); }
}

function courseRow(c) {
  return `
  <div class="list-item">
    <div class="list-item-icon">${esc(c.icon || '📘')}</div>
    <div class="list-item-body">
      <div class="list-item-title">${esc(c.title)} ${c.premium ? '<span class="tag tag-premium">PREMIUM</span>' : ''} ${!c.active ? '<span class="tag tag-blocked">INACTIVE</span>' : ''}</div>
      <div class="list-item-sub">${esc(c.level)} · ${esc(c.description || '').slice(0, 80)}</div>
    </div>
    <div class="list-item-actions">
      <button class="btn btn-ghost btn-sm" onclick="manageLessons(${c.id}, '${esc(c.title).replace(/'/g, "\\'")}')">📹 Lessons</button>
      <button class="btn btn-ghost btn-sm" onclick="editCourse(${c.id})">✏️ Edit</button>
      <button class="btn btn-danger btn-sm" onclick="deleteCourse(${c.id})">🗑</button>
    </div>
  </div>`;
}

document.getElementById('courseSearch').addEventListener('input', (e) => loadCourses(e.target.value));
document.getElementById('newCourseBtn').addEventListener('click', () => courseModal());

function courseModal(course = null) {
  const isEdit = !!course;
  openModal(`
    <h3>${isEdit ? 'Edit' : 'Add'} Course</h3>
    <label>Title<input id="cf_title" value="${esc(course?.title || '')}"></label>
    <label>Icon (emoji)<input id="cf_icon" value="${esc(course?.icon || '📘')}"></label>
    <label>Level<input id="cf_level" value="${esc(course?.level || 'Beginner')}"></label>
    <label>Color (hex)<input id="cf_color" value="${esc(course?.color || '#6C63FF')}"></label>
    <label>Description<textarea id="cf_desc" rows="3">${esc(course?.description || '')}</textarea></label>
    <label class="checkbox-row"><input type="checkbox" id="cf_premium" ${course?.premium ? 'checked' : ''}> Premium course</label>
    <label class="checkbox-row"><input type="checkbox" id="cf_active" ${course?.active !== false ? 'checked' : ''}> Active</label>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveCourse(${course?.id || 'null'})">Save</button>
    </div>
  `);
}

async function editCourse(id) {
  try {
    const { data } = await api(`/courses/${id}`);
    courseModal(data);
  } catch (err) { toast(err.message, 'error'); }
}

async function saveCourse(id) {
  const payload = {
    title: document.getElementById('cf_title').value.trim(),
    icon: document.getElementById('cf_icon').value.trim() || '📘',
    level: document.getElementById('cf_level').value.trim() || 'Beginner',
    color: document.getElementById('cf_color').value.trim() || '#6C63FF',
    description: document.getElementById('cf_desc').value.trim(),
    premium: document.getElementById('cf_premium').checked,
    active: document.getElementById('cf_active').checked,
  };
  try {
    if (id) await api(`/courses/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    else await api('/courses', { method: 'POST', body: JSON.stringify(payload) });
    closeModal();
    toast('Course saved');
    loadCourses();
  } catch (err) { toast(err.message, 'error'); }
}

async function deleteCourse(id) {
  if (!confirm('Delete this course and all its lessons? This cannot be undone.')) return;
  try {
    await api(`/courses/${id}`, { method: 'DELETE' });
    toast('Course deleted');
    loadCourses();
  } catch (err) { toast(err.message, 'error'); }
}

// ── Lessons ───────────────────────────────────────────────────────────────
async function manageLessons(courseId, courseTitle) {
  try {
    const { data } = await api(`/lessons/course/${courseId}`);
    openModal(`
      <h3>Lessons · ${esc(courseTitle)}</h3>
      <div id="lessonListInner">${data.map((l) => lessonRow(l)).join('') || '<p class="muted">No lessons yet.</p>'}</div>
      <button class="btn btn-primary btn-block" style="margin-top:14px" onclick="lessonModal(${courseId})">➕ Add Lesson</button>
      <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Close</button></div>
    `);
  } catch (err) { toast(err.message, 'error'); }
}

function lessonRow(l) {
  return `
    <div class="list-item" style="padding:10px 12px;">
      <div class="list-item-body">
        <div class="list-item-title" style="font-size:13px;">${esc(l.title)}</div>
        <div class="list-item-sub">${esc(l.duration || '')} · ${l.status}</div>
      </div>
      <div class="list-item-actions">
        <button class="btn btn-danger btn-sm" onclick="deleteLesson(${l.id}, ${l.course_id})">🗑</button>
      </div>
    </div>`;
}

function lessonModal(courseId) {
  openModal(`
    <h3>Add Lesson</h3>
    <label>Title<input id="lf_title"></label>
    <label>Video URL<input id="lf_video"></label>
    <label>Thumbnail URL<input id="lf_thumb"></label>
    <label>File URL (optional download)<input id="lf_file"></label>
    <label>Duration (e.g. 12:30)<input id="lf_duration"></label>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="manageLessons(${courseId}, '')">Back</button>
      <button class="btn btn-primary" onclick="saveLesson(${courseId})">Save</button>
    </div>
  `);
}

async function saveLesson(courseId) {
  const payload = {
    course_id: courseId,
    title: document.getElementById('lf_title').value.trim(),
    video_url: document.getElementById('lf_video').value.trim(),
    thumb_url: document.getElementById('lf_thumb').value.trim(),
    file_url: document.getElementById('lf_file').value.trim(),
    duration: document.getElementById('lf_duration').value.trim(),
  };
  try {
    await api('/lessons', { method: 'POST', body: JSON.stringify(payload) });
    toast('Lesson added');
    manageLessons(courseId, '');
  } catch (err) { toast(err.message, 'error'); }
}

async function deleteLesson(id, courseId) {
  if (!confirm('Delete this lesson?')) return;
  try {
    await api(`/lessons/${id}`, { method: 'DELETE' });
    toast('Lesson deleted');
    manageLessons(courseId, '');
  } catch (err) { toast(err.message, 'error'); }
}

// ── Users ─────────────────────────────────────────────────────────────────
async function loadUsers(page = 1) {
  usersPage = page;
  const search = document.getElementById('userSearch').value;
  const status = document.getElementById('userStatusFilter').value;
  const params = new URLSearchParams({ page, pageSize: 20 });
  if (search) params.set('search', search);
  if (status) params.set('status', status);

  try {
    const { data, pagination } = await api('/users?' + params.toString());
    const tbody = document.querySelector('#usersTable tbody');
    tbody.innerHTML = data.length ? data.map(userRow).join('') : '<tr><td colspan="6" class="muted">No users found</td></tr>';
    renderPagination('usersPagination', pagination, loadUsers);
  } catch (err) { toast(err.message, 'error'); }
}

function userRow(u) {
  const statusTags = [
    u.is_premium ? '<span class="tag tag-premium">PREMIUM</span>' : '<span class="tag tag-free">FREE</span>',
    u.is_blocked ? '<span class="tag tag-blocked">BLOCKED</span>' : '',
  ].join(' ');
  return `
    <tr>
      <td>${esc(u.device_name || u.device_id.slice(0, 12) + '…')}</td>
      <td>${esc(u.android_version || '–')}</td>
      <td>${esc((u.registered_at || '').slice(0, 10))}</td>
      <td>${esc((u.last_active || '').slice(0, 16).replace('T', ' '))}</td>
      <td>${statusTags}</td>
      <td>
        ${u.is_blocked
          ? `<button class="btn btn-success btn-sm" onclick="unblockUser(${u.id})">Unblock</button>`
          : `<button class="btn btn-danger btn-sm" onclick="blockUser(${u.id})">Block</button>`}
      </td>
    </tr>`;
}

function renderPagination(elId, pagination, loader) {
  const el = document.getElementById(elId);
  if (!pagination || pagination.totalPages <= 1) { el.innerHTML = ''; return; }
  let html = '';
  for (let p = 1; p <= pagination.totalPages; p++) {
    html += `<button class="btn btn-sm ${p === pagination.page ? 'btn-primary' : 'btn-ghost'}" onclick="(${loader.name})(${p})">${p}</button>`;
  }
  el.innerHTML = html;
}

document.getElementById('userSearch').addEventListener('input', debounce(() => loadUsers(1), 350));
document.getElementById('userStatusFilter').addEventListener('change', () => loadUsers(1));
document.getElementById('exportUsersBtn').addEventListener('click', (e) => {
  e.preventDefault();
  window.open(API + '/users/export.csv?token=' + encodeURIComponent(TOKEN), '_blank');
});

async function blockUser(id) {
  try { await api(`/users/${id}/block`, { method: 'POST' }); toast('User blocked'); loadUsers(usersPage); }
  catch (err) { toast(err.message, 'error'); }
}
async function unblockUser(id) {
  try { await api(`/users/${id}/unblock`, { method: 'POST' }); toast('User unblocked'); loadUsers(usersPage); }
  catch (err) { toast(err.message, 'error'); }
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ── Premium ───────────────────────────────────────────────────────────────
async function loadPremium() {
  try {
    const stats = await api('/premium/stats');
    document.getElementById('premTotal').textContent = stats.data.total;
    document.getElementById('premActive').textContent = stats.data.active;
    document.getElementById('premExpired').textContent = stats.data.expired;
    document.getElementById('premSoon').textContent = stats.data.expiringSoon;

    const search = document.getElementById('premiumSearch').value;
    const q = search ? `?search=${encodeURIComponent(search)}&pageSize=50` : '?pageSize=50';
    const { data } = await api('/premium' + q);
    document.getElementById('premiumTableBody').innerHTML = data.length
      ? data.map(premiumRow).join('')
      : '<tr><td colspan="5" class="muted">No premium grants yet</td></tr>';
  } catch (err) { toast(err.message, 'error'); }
}

function premiumRow(p) {
  const expiry = p.is_lifetime ? '<span class="tag tag-premium">LIFETIME</span>' : (p.is_expired ? `<span class="tag tag-blocked">${esc(p.expiry_date)}</span>` : esc(p.expiry_date));
  return `
    <tr>
      <td>${esc(p.device_id)}</td>
      <td>${expiry}</td>
      <td>${esc(p.granted_by || '–')}</td>
      <td>${esc(p.notes || '–')}</td>
      <td><button class="btn btn-danger btn-sm" onclick="revokePremium(${p.id})">Revoke</button></td>
    </tr>`;
}

document.getElementById('premiumSearch').addEventListener('input', debounce(loadPremium, 350));
document.getElementById('exportPremiumBtn').addEventListener('click', (e) => {
  e.preventDefault();
  window.open(API + '/premium/export.csv?token=' + encodeURIComponent(TOKEN), '_blank');
});

document.getElementById('grantPremiumBtn').addEventListener('click', () => {
  openModal(`
    <h3>Grant Premium</h3>
    <label>Device ID<input id="pf_device"></label>
    <label>Duration
      <select id="pf_duration">
        <option value="3d">3 Days</option>
        <option value="7d">7 Days</option>
        <option value="15d">15 Days</option>
        <option value="30d" selected>30 Days</option>
        <option value="lifetime">Lifetime</option>
      </select>
    </label>
    <label>Notes<input id="pf_notes"></label>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="grantPremium()">Grant</button>
    </div>
  `);
});

async function grantPremium() {
  const payload = {
    device_id: document.getElementById('pf_device').value.trim(),
    duration: document.getElementById('pf_duration').value,
    notes: document.getElementById('pf_notes').value.trim(),
  };
  if (!payload.device_id) return toast('Device ID is required', 'error');
  try {
    await api('/premium', { method: 'POST', body: JSON.stringify(payload) });
    closeModal();
    toast('Premium granted');
    loadPremium();
  } catch (err) { toast(err.message, 'error'); }
}

async function revokePremium(id) {
  if (!confirm('Revoke this premium grant?')) return;
  try {
    await api(`/premium/${id}`, { method: 'DELETE' });
    toast('Premium revoked');
    loadPremium();
  } catch (err) { toast(err.message, 'error'); }
}

// ── Notices ───────────────────────────────────────────────────────────────
async function loadNotices() {
  try {
    const { data } = await api('/notices');
    const list = document.getElementById('noticeList');
    list.innerHTML = data.length ? data.map(noticeRow).join('') : '<p class="muted">No notices yet.</p>';
  } catch (err) { toast(err.message, 'error'); }
}

function noticeRow(n) {
  return `
    <div class="list-item">
      <div class="list-item-icon">📢</div>
      <div class="list-item-body">
        <div class="list-item-title">${esc(n.title)} ${n.is_active ? '<span class="tag tag-premium">ACTIVE</span>' : ''}</div>
        <div class="list-item-sub">${esc(n.message)} · target: ${esc(n.target)}</div>
      </div>
      <div class="list-item-actions">
        <button class="btn btn-ghost btn-sm" onclick="toggleNotice(${n.id}, ${!n.is_active})">${n.is_active ? 'Disable' : 'Enable'}</button>
        <button class="btn btn-danger btn-sm" onclick="deleteNotice(${n.id})">🗑</button>
      </div>
    </div>`;
}

document.getElementById('newNoticeBtn').addEventListener('click', () => {
  openModal(`
    <h3>New Notice</h3>
    <label>Title<input id="nf_title"></label>
    <label>Message<textarea id="nf_message" rows="3"></textarea></label>
    <label>Target
      <select id="nf_target">
        <option value="all">All Users</option>
        <option value="premium">Premium Only</option>
        <option value="free">Free Only</option>
      </select>
    </label>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveNotice()">Publish</button>
    </div>
  `);
});

async function saveNotice() {
  const payload = {
    title: document.getElementById('nf_title').value.trim(),
    message: document.getElementById('nf_message').value.trim(),
    target: document.getElementById('nf_target').value,
    is_active: true,
  };
  if (!payload.title || !payload.message) return toast('Title and message are required', 'error');
  try {
    await api('/notices', { method: 'POST', body: JSON.stringify(payload) });
    closeModal();
    toast('Notice published');
    loadNotices();
  } catch (err) { toast(err.message, 'error'); }
}

async function toggleNotice(id, active) {
  try {
    await api(`/notices/${id}`, { method: 'PUT', body: JSON.stringify({ is_active: active }) });
    loadNotices();
  } catch (err) { toast(err.message, 'error'); }
}

async function deleteNotice(id) {
  if (!confirm('Delete this notice?')) return;
  try {
    await api(`/notices/${id}`, { method: 'DELETE' });
    toast('Notice deleted');
    loadNotices();
  } catch (err) { toast(err.message, 'error'); }
}

// ── App Control ───────────────────────────────────────────────────────────
async function loadAppControl() {
  try {
    const { data } = await api('/config');
    document.getElementById('appStatusText').textContent = data.app_status;
    document.getElementById('cfgVersion').value = data.current_version || '';
    document.getElementById('cfgForceUpdate').checked = data.force_update;
    setStatusBadge(data.app_status);
  } catch (err) { toast(err.message, 'error'); }
}

document.getElementById('killBtn').addEventListener('click', async () => {
  const message = prompt('Message shown to users:', 'This app has been temporarily disabled.');
  if (message === null) return;
  try { await api('/config/kill', { method: 'POST', body: JSON.stringify({ message }) }); toast('Kill switch activated', 'error'); loadAppControl(); }
  catch (err) { toast(err.message, 'error'); }
});
document.getElementById('maintenanceBtn').addEventListener('click', async () => {
  const message = prompt('Maintenance message:', 'Under maintenance. Please check back soon.');
  if (message === null) return;
  try { await api('/config/maintenance', { method: 'POST', body: JSON.stringify({ message }) }); toast('Maintenance mode enabled'); loadAppControl(); }
  catch (err) { toast(err.message, 'error'); }
});
document.getElementById('aliveBtn').addEventListener('click', async () => {
  try { await api('/config/alive', { method: 'POST' }); toast('App is live'); loadAppControl(); }
  catch (err) { toast(err.message, 'error'); }
});
document.getElementById('saveVersionBtn').addEventListener('click', async () => {
  const payload = {
    current_version: document.getElementById('cfgVersion').value.trim(),
    force_update: document.getElementById('cfgForceUpdate').checked,
  };
  try { await api('/config', { method: 'PUT', body: JSON.stringify(payload) }); toast('Version settings saved'); }
  catch (err) { toast(err.message, 'error'); }
});

// ── Settings ──────────────────────────────────────────────────────────────
document.getElementById('changePassBtn').addEventListener('click', async () => {
  const currentPassword = document.getElementById('curPass').value;
  const newPassword = document.getElementById('newPass').value;
  try {
    await api('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
    toast('Password updated');
    document.getElementById('curPass').value = '';
    document.getElementById('newPass').value = '';
  } catch (err) { toast(err.message, 'error'); }
});

// ── Boot ──────────────────────────────────────────────────────────────────
async function boot() {
  try {
    await api('/auth/me');
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    showView('dashboard');
  } catch (_) {
    logout();
  }
}

if (TOKEN) boot(); else logout();
