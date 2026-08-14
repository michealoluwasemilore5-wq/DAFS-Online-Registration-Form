const loginView = document.getElementById('loginView');
const dashboardView = document.getElementById('dashboardView');
const loginForm = document.getElementById('loginForm');
const loginMessage = document.getElementById('loginMessage');
const rows = document.getElementById('registrationRows');
const search = document.getElementById('search');
const emptyState = document.getElementById('emptyState');
const errorMessage = document.getElementById('errorMessage');
const modal = document.getElementById('modal');
const modalTitle = document.getElementById('modalTitle');
const modalDetails = document.getElementById('modalDetails');
let registrations = [];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({
    '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'
  }[char]));
}

function setMessage(el, text, type = 'error') {
  el.textContent = text;
  el.className = `message ${text ? `show ${type}` : ''}`;
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-NG', {
    dateStyle: 'medium',
    timeStyle: 'short'
  });
}

const request = (url, options = {}) => fetch(url, {
  credentials: 'same-origin',
  ...options,
  headers: {
    ...(options.headers || {})
  }
});

async function checkLogin() {
  try {
    const res = await request('/api/admin/me');
    if (!res.ok) throw new Error();
    const user = await res.json();
    document.getElementById('adminName').textContent = user.username;
    showDashboard();
    await loadRegistrations();
  } catch {
    showLogin();
  }
}

function showLogin() {
  loginView.classList.remove('hidden');
  dashboardView.classList.add('hidden');
}

function showDashboard() {
  loginView.classList.add('hidden');
  dashboardView.classList.remove('hidden');
}

loginForm.addEventListener('submit', async e => {
  e.preventDefault();
  const button = loginForm.querySelector('button');
  button.disabled = true;
  setMessage(loginMessage, '');

  try {
    const res = await request('/api/admin/login', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        username: document.getElementById('username').value,
        password: document.getElementById('password').value
      })
    });

    const result = await res.json();

    if (!res.ok) {
      throw new Error(result.message || 'Login failed.');
    }

    document.getElementById('adminName').textContent = result.username;
    loginForm.reset();
    showDashboard();

    const loaded = await loadRegistrations();
    if (!loaded) showLogin();
  } catch (err) {
    setMessage(loginMessage, err.message, 'error');
  } finally {
    button.disabled = false;
  }
});

async function loadRegistrations() {
  setMessage(errorMessage, '');

  try {
    const res = await request('/api/registrations');

    if (res.status === 401) {
      showLogin();
      return false;
    }

    const result = await res.json();

    if (!res.ok) {
      throw new Error(result.message || 'Could not load registrations.');
    }

    registrations = result;
    render();

    document.getElementById('lastUpdated').textContent =
      `Updated ${new Date().toLocaleTimeString('en-NG', {
        hour:'2-digit',
        minute:'2-digit'
      })}`;

    return true;
  } catch (err) {
    setMessage(errorMessage, err.message, 'error');
    return false;
  }
}

function render() {
  const q = search.value.trim().toLowerCase();

  const filtered = registrations.filter(r =>
    Object.values(r).some(v =>
      String(v ?? '').toLowerCase().includes(q)
    )
  );

  rows.innerHTML = filtered.map(r => `
    <tr>
      <td><b>${escapeHtml(r.applicationId)}</b></td>
      <td>${escapeHtml([r.firstName, r.otherName, r.lastName].filter(Boolean).join(' '))}</td>
      <td>${escapeHtml(r.classApplying)}</td>
      <td>${escapeHtml(r.guardianName)}</td>
      <td>${escapeHtml(r.phone)}</td>
      <td>${escapeHtml(formatDate(r.submittedAt))}</td>
      <td><button class="view" data-index="${registrations.indexOf(r)}">View</button></td>
    </tr>
  `).join('');

  emptyState.classList.toggle('hidden', filtered.length !== 0);
  document.getElementById('totalCount').textContent = registrations.length;

  const today = new Date().toDateString();
  document.getElementById('todayCount').textContent =
    registrations.filter(r =>
      new Date(r.submittedAt).toDateString() === today
    ).length;

  document.getElementById('latestId').textContent =
    registrations.length
      ? registrations[registrations.length - 1].applicationId
      : '—';
}

rows.addEventListener('click', e => {
  const btn = e.target.closest('.view');
  if (!btn) return;

  const r = registrations[Number(btn.dataset.index)];
  if (!r) return;

  modalTitle.textContent = r.applicationId;

  const labels = {
    firstName:'First Name',
    lastName:'Last Name',
    otherName:'Other Name',
    dateOfBirth:'Date of Birth',
    gender:'Gender',
    classApplying:'Class Applying For',
    guardianName:'Parent/Guardian',
    phone:'Phone Number',
    email:'Email',
    relationship:'Relationship',
    address:'Home Address',
    previousSchool:'Previous School',
    previousClass:'Previous Class',
    additionalInfo:'Additional Information',
    paymentReference:'Payment Reference', paymentAmount:'Payment Amount', paymentCurrency:'Currency', paidAt:'Paid At', submittedAt:'Submitted At'
  };

  modalDetails.innerHTML = Object.entries(labels).map(([key,label]) => `
    <div>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(
        key === 'submittedAt' ? formatDate(r[key]) : (r[key] || '—')
      )}</strong>
    </div>
  `).join('');

  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden','false');
});

function closeModal() {
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden','true');
}

document.getElementById('closeModal').addEventListener('click', closeModal);

modal.addEventListener('click', e => {
  if (e.target === modal) closeModal();
});

search.addEventListener('input', render);
document.getElementById('refreshBtn').addEventListener('click', loadRegistrations);

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await request('/api/admin/logout', { method: 'POST' });
  showLogin();
});

checkLogin();
