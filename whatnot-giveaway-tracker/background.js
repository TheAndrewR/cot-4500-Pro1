const GIVEAWAY_DURATION_MS = 5 * 60 * 1000;

// { username: { startTime, productId } }
const activeGiveaways = {};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'GIVEAWAY_STARTED') {
    const { username, productId, startTime } = message;
    const now = Date.now();
    const effectiveStart = startTime ?? now;

    // Skip if we already have this exact product tracked
    if (activeGiveaways[username]?.productId === productId) {
      sendResponse({ status: 'already_active' });
      return true;
    }

    // Skip if remaining time on existing giveaway is > 0 and it's a different product
    // (the new one wins — replace it)
    const remainingMs = GIVEAWAY_DURATION_MS - (now - effectiveStart);
    if (remainingMs <= 0) {
      sendResponse({ status: 'expired' });
      return true;
    }

    activeGiveaways[username] = { startTime: effectiveStart, productId };
    chrome.alarms.clear(`giveaway_end_${username}`);
    chrome.alarms.create(`giveaway_end_${username}`, {
      delayInMinutes: remainingMs / 60000,
    });
    syncToStorage();
    sendResponse({ status: 'started' });
  }

  if (message.type === 'GIVEAWAY_MANUAL') {
    const { username } = message;
    const now = Date.now();
    activeGiveaways[username] = { startTime: now, productId: null };
    chrome.alarms.clear(`giveaway_end_${username}`);
    chrome.alarms.create(`giveaway_end_${username}`, { delayInMinutes: 5 });
    syncToStorage();
    sendResponse({ status: 'started' });
  }

  if (message.type === 'REMOVE_GIVEAWAY') {
    const { username } = message;
    delete activeGiveaways[username];
    chrome.alarms.clear(`giveaway_end_${username}`);
    syncToStorage();
    sendResponse({ status: 'removed' });
  }

  if (message.type === 'GET_GIVEAWAYS') {
    sendResponse({ giveaways: getSerializableState() });
  }

  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith('giveaway_end_')) {
    const username = alarm.name.replace('giveaway_end_', '');
    delete activeGiveaways[username];
    syncToStorage();
  }
});

// Restore state after service worker restarts
chrome.storage.session.get('giveaways', (result) => {
  if (!result.giveaways) return;
  const now = Date.now();
  for (const [username, data] of Object.entries(result.giveaways)) {
    const remaining = GIVEAWAY_DURATION_MS - (now - data.startTime);
    if (remaining > 0) {
      activeGiveaways[username] = data;
      chrome.alarms.create(`giveaway_end_${username}`, {
        delayInMinutes: remaining / 60000,
      });
    }
  }
});

function getSerializableState() {
  const now = Date.now();
  const result = {};
  for (const [username, data] of Object.entries(activeGiveaways)) {
    const remaining = GIVEAWAY_DURATION_MS - (now - data.startTime);
    if (remaining > 0) {
      result[username] = { ...data, remaining };
    }
  }
  return result;
}

function syncToStorage() {
  chrome.storage.session.set({ giveaways: activeGiveaways });
}
