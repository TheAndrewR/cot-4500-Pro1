const GIVEAWAY_DURATION_MS = 5 * 60 * 1000;

const listEl = document.getElementById('giveawayList');
const input = document.getElementById('usernameInput');
const addBtn = document.getElementById('addBtn');

function formatTime(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function urgencyClass(remaining) {
  if (remaining <= 60000) return 'urgent';
  if (remaining <= 120000) return 'warning';
  return 'normal';
}

function render(giveaways) {
  const entries = Object.entries(giveaways).sort(
    ([, a], [, b]) => a.remaining - b.remaining
  );

  if (entries.length === 0) {
    listEl.innerHTML =
      '<div class="empty-state">No active giveaways.<br/>Open a Whatnot stream to auto-detect.</div>';
    return;
  }

  listEl.innerHTML = '';

  for (const [username, { remaining }] of entries) {
    const pct = Math.min(100, (remaining / GIVEAWAY_DURATION_MS) * 100);
    const cls = urgencyClass(remaining);

    const card = document.createElement('div');
    card.className = `giveaway-card ${cls}`;
    card.innerHTML = `
      <div class="card-top">
        <span class="username">@${escapeHtml(username)}</span>
        <span class="countdown ${cls}">${formatTime(remaining)}</span>
      </div>
      <div class="progress-track">
        <div class="progress-bar ${cls}" style="width:${pct.toFixed(1)}%"></div>
      </div>
      <div class="card-actions">
        <button class="dismiss-btn" data-username="${escapeHtml(username)}">Dismiss</button>
      </div>
    `;
    listEl.appendChild(card);
  }

  listEl.querySelectorAll('.dismiss-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const username = btn.dataset.username;
      chrome.runtime.sendMessage({ type: 'REMOVE_GIVEAWAY', username });
    });
  });
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function poll() {
  chrome.runtime.sendMessage({ type: 'GET_GIVEAWAYS' }, (response) => {
    if (chrome.runtime.lastError) return;
    render(response?.giveaways ?? {});
  });
}

// Refresh every second
poll();
setInterval(poll, 1000);

// Manual start
function manualStart() {
  const username = input.value.trim().replace(/^@/, '');
  if (!username) return;
  chrome.runtime.sendMessage({ type: 'GIVEAWAY_MANUAL', username }, () => {
    input.value = '';
    poll();
  });
}

addBtn.addEventListener('click', manualStart);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') manualStart();
});
