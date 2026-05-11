const GIVEAWAY_MS = 5 * 60 * 1000;

const usernameInput   = document.getElementById('usernameInput');
const addBtn          = document.getElementById('addBtn');
const giveawaySection = document.getElementById('giveawaySection');
const giveawayList    = document.getElementById('giveawayList');
const streamerSection = document.getElementById('streamerSection');
const streamerList    = document.getElementById('streamerList');

// ── Helpers ────────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])
  );
}

function fmt(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function urgency(ms) {
  if (ms <= 60_000)  return 'urgent';
  if (ms <= 120_000) return 'warning';
  return 'ok';
}

const STATUS_LABEL = {
  connecting:   { dot: 'dot-yellow', text: 'Connecting…' },
  live:         { dot: 'dot-green',  text: 'Live' },
  offline:      { dot: 'dot-gray',   text: 'Not live' },
  reconnecting: { dot: 'dot-yellow', text: 'Reconnecting…' },
  error:        { dot: 'dot-red',    text: 'Error' },
  not_found:    { dot: 'dot-red',    text: 'Not found' },
};

// ── Render ─────────────────────────────────────────────────────────────────────
function render({ streamers, giveaways }) {
  // ── Active giveaway cards (sorted soonest first) ────────────────────────────
  const gEntries = Object.entries(giveaways).sort(([, a], [, b]) => a.remaining - b.remaining);

  if (gEntries.length === 0) {
    giveawaySection.classList.add('hidden');
  } else {
    giveawaySection.classList.remove('hidden');
    giveawayList.innerHTML = '';

    for (const [username, { remaining }] of gEntries) {
      const pct = Math.min(100, (remaining / GIVEAWAY_MS) * 100).toFixed(1);
      const u   = urgency(remaining);
      const card = document.createElement('div');
      card.className = `giveaway-card ${u}`;
      card.innerHTML = `
        <div class="card-row">
          <span class="g-username">@${esc(username)}</span>
          <span class="g-time ${u}">${fmt(remaining)}</span>
        </div>
        <div class="progress-track">
          <div class="progress-bar ${u}" style="width:${pct}%"></div>
        </div>
      `;
      giveawayList.appendChild(card);
    }
  }

  // ── Watched streamers list ──────────────────────────────────────────────────
  const sEntries = Object.entries(streamers);

  if (sEntries.length === 0) {
    streamerList.innerHTML = '<div class="empty-state">No streamers added yet.</div>';
  } else {
    streamerList.innerHTML = '';

    for (const [username, { status }] of sEntries) {
      const { dot, text } = STATUS_LABEL[status] ?? { dot: 'dot-gray', text: status };
      const hasGiveaway = Boolean(giveaways[username]);

      const row = document.createElement('div');
      row.className = `streamer-row${hasGiveaway ? ' has-giveaway' : ''}`;
      row.innerHTML = `
        <span class="dot ${dot}"></span>
        <span class="s-name">@${esc(username)}</span>
        <span class="s-status">${text}</span>
        <button class="remove-btn" data-username="${esc(username)}" title="Stop watching">✕</button>
      `;
      streamerList.appendChild(row);
    }

    streamerList.querySelectorAll('.remove-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'REMOVE_STREAMER', username: btn.dataset.username });
      });
    });
  }
}

// ── Poll background for state ─────────────────────────────────────────────────
function poll() {
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, resp => {
    if (chrome.runtime.lastError || !resp) return;
    render(resp);
  });
}

poll();
setInterval(poll, 1000);

// ── Add streamer ───────────────────────────────────────────────────────────────
function addStreamer() {
  const raw = usernameInput.value.trim().replace(/^@/, '');
  if (!raw) return;

  addBtn.disabled = true;
  addBtn.textContent = '…';

  chrome.runtime.sendMessage({ type: 'ADD_STREAMER', username: raw }, resp => {
    addBtn.disabled = false;
    addBtn.textContent = 'Watch';
    if (resp?.error === 'already_added') {
      usernameInput.style.borderColor = '#f59e0b';
      setTimeout(() => { usernameInput.style.borderColor = ''; }, 1500);
    } else {
      usernameInput.value = '';
    }
    poll();
  });
}

addBtn.addEventListener('click', addStreamer);
usernameInput.addEventListener('keydown', e => { if (e.key === 'Enter') addStreamer(); });
