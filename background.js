// YouTube Transcript - DRP: background service worker.
//
// All transcript-API traffic lives here. Extension pages are their own origin,
// and the FastAPI app sends no CORS headers on purpose, so a fetch from the
// panel would be blocked. The worker holds the host permissions for
// 127.0.0.1/localhost instead, which is also why the app needs no changes.

importScripts('lib.js');

const API_DEFAULT = 'http://127.0.0.1:8000';
const SETTINGS_KEY = 'settings';
const MAX_HISTORY_CAP = 50;

// --------------------------------------------------------------------------
// settings

async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const saved = stored[SETTINGS_KEY] || {};
  const limit = Number(saved.historyLimit);
  const ctx = Number(saved.contextLines);
  return Object.assign(
    { api: API_DEFAULT, languages: 'ne,en', historyLimit: 10, contextLines: 2 },
    saved,
    // A stored 0 or NaN would make the next fetch trim history down to nothing,
    // so the fallback is applied here rather than trusted from the store.
    {
      historyLimit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, MAX_HISTORY_CAP) : 10,
      contextLines: Number.isFinite(ctx) && ctx >= 0 ? Math.min(Math.floor(ctx), 5) : 2,
    }
  );
}

async function saveSettings(patch) {
  const next = Object.assign(await getSettings(), patch);
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

function preferredLanguages(settings) {
  return String(settings.languages || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// --------------------------------------------------------------------------
// the transcript API

class ApiError extends Error {
  constructor(message, status, errorType) {
    super(message);
    this.status = status;
    this.errorType = errorType;
  }
}

function apiUrl(settings) {
  return (settings.api || API_DEFAULT).replace(/\/+$/, '');
}

// The app answers failures with {detail, error_type}. Both are carried up so
// the panel can say the actual reason ("no transcript in those languages")
// instead of "request failed".
async function readError(res) {
  let data = {};
  try { data = await res.json(); } catch { /* not json */ }
  return new ApiError(
    data.detail || `request failed (${res.status})`,
    res.status,
    data.error_type || 'http_error'
  );
}

// A fetch to a host the extension has no permission for is subject to CORS (the
// API sends no CORS headers), so it fails with an opaque network error. Checking
// up front turns that into a message the user can act on.
async function ensureHostPermission(settings) {
  const pattern = TranscriptLib.originPattern(apiUrl(settings));
  if (!pattern || !chrome.permissions) return;
  let has = false;
  try { has = await chrome.permissions.contains({ origins: [pattern] }); } catch { return; }
  if (has) return;
  throw new ApiError(
    `The extension has not been granted access to ${apiUrl(settings)}. `
      + 'Open Settings and press Save to allow it.',
    0,
    'no_host_permission'
  );
}

async function apiGet(settings, pathOrUrl) {
  // The lib query builders return absolute URLs; a bare path is resolved
  // against the configured address. Accepting both keeps the callers from
  // having to remember which one they built.
  const url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : apiUrl(settings) + pathOrUrl;
  await ensureHostPermission(settings);
  let res;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch (err) {
    // A refused connection is not an HTTP error: the app is not up.
    throw new ApiError(
      `Cannot reach the transcript API at ${apiUrl(settings)}. Start it with "uvicorn app.main:app".`,
      0,
      'unreachable'
    );
  }
  if (!res.ok) throw await readError(res);
  return res.json();
}

// --------------------------------------------------------------------------
// the active tab
//
// A side panel is not a window, so chrome.tabs.query({currentWindow:true})
// answers about the wrong window. lastFocusedWindow is the documented call for
// a side panel; the others are fallbacks for odd focus states.

async function currentPage() {
  const attempts = [
    { active: true, lastFocusedWindow: true },
    { active: true, currentWindow: true },
    { active: true },
  ];
  for (const q of attempts) {
    let tabs = [];
    try { tabs = await chrome.tabs.query(q); } catch { continue; }
    const tab = tabs.find((t) => t && t.active && t.url) || tabs.find((t) => t && t.url);
    if (tab) {
      return {
        url: tab.url,
        title: tab.title || '',
        tabId: tab.id,
        windowId: tab.windowId,
        isYouTube: TranscriptLib.isYouTube(tab.url),
        isExtension: /^chrome-extension:/.test(tab.url || ''),
      };
    }
  }
  return { url: '', title: '', tabId: null, windowId: null, isYouTube: false, isExtension: false };
}

// The field follows the browser, so the active tab is pushed rather than
// polled. Coalesced because navigating within YouTube fires several updates.
let tabPushTimer = null;

function pushTabSoon() {
  if (tabPushTimer) clearTimeout(tabPushTimer);
  tabPushTimer = setTimeout(async () => {
    tabPushTimer = null;
    const page = await currentPage();
    try { await chrome.runtime.sendMessage({ type: 'tab:changed', page }); }
    catch { /* no panel open */ }
  }, 250);
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab || !tab.active || !changeInfo.url) return;
  pushTabSoon();
});
chrome.tabs.onActivated.addListener(() => pushTabSoon());

// --------------------------------------------------------------------------
// seek
//
// A timestamp click should jump the video that is already open, not reload it.
// The declared content script does the seeking; when the video is not the
// active tab there is nothing to seek in, so the tab is navigated to the watch
// URL with a &t= offset instead. The panel is told which of the two happened so
// the fallback is never silent.

async function seek({ videoId, seconds }) {
  if (!videoId) throw new ApiError('no video id to seek to', 0, 'invalid');
  const page = await currentPage();
  const onSameVideo = page.tabId != null
    && TranscriptLib.isYouTube(page.url)
    && TranscriptLib.videoIdFromUrl(page.url) === videoId;

  if (onSameVideo) {
    try {
      const reply = await chrome.tabs.sendMessage(page.tabId, {
        type: 'seek',
        time: Number(seconds) || 0,
      });
      if (reply && reply.ok) return { mode: 'seeked' };
    } catch { /* no content script yet; fall through to navigating */ }
  }

  const target = TranscriptLib.seekUrl(videoId, seconds);
  if (page.tabId != null && page.isYouTube) {
    await chrome.tabs.update(page.tabId, { url: target });
  } else {
    await chrome.tabs.create({ url: target });
  }
  return { mode: 'navigated' };
}

// --------------------------------------------------------------------------
// history
//
// Only summaries are stored now. A five-hour transcript is megabytes of
// segments and storage.local has a hard quota, so keeping them all would fill
// the quota after a handful of videos. The list is tiny, so it can be held in a
// single key with no cost. Older builds stored full records under `history:*`
// keys plus a `history_index`; those are read once and then dropped.

const HISTORY_KEY = 'history';
const LEGACY_INDEX_KEY = 'history_index';
const LEGACY_ENTRY_PREFIX = 'history:';

let legacyCleaned = false;

async function legacyEntryKeys() {
  const all = await chrome.storage.local.get(null);
  return Object.keys(all).filter((k) => k.indexOf(LEGACY_ENTRY_PREFIX) === 0);
}

async function cleanupLegacy() {
  const keys = [LEGACY_INDEX_KEY].concat(await legacyEntryKeys());
  if (keys.length) await chrome.storage.local.remove(keys);
}

async function readStoredHistory() {
  const stored = await chrome.storage.local.get([HISTORY_KEY, LEGACY_INDEX_KEY]);
  if (Array.isArray(stored[HISTORY_KEY])) return { raw: stored[HISTORY_KEY], legacy: false };
  if (Array.isArray(stored[LEGACY_INDEX_KEY])) return { raw: stored[LEGACY_INDEX_KEY], legacy: true };
  return { raw: [], legacy: false };
}

async function getHistory() {
  const { raw, legacy } = await readStoredHistory();
  if (legacy && !legacyCleaned) {
    legacyCleaned = true;
    cleanupLegacy().catch(() => {});
  }
  return raw.map(TranscriptLib.historySummary);
}

// A caller passes a summary (video_id + counts) rather than a full record, so
// no segments ever touch storage.
async function addHistory(summary, settings) {
  const current = await getHistory();
  const next = TranscriptLib.trimHistory([summary].concat(current), settings.historyLimit);
  await chrome.storage.local.set({ [HISTORY_KEY]: next });
  await chrome.runtime.sendMessage({ type: 'history:changed', history: next }).catch(() => {});
  return next;
}

async function clearHistory() {
  const keys = [HISTORY_KEY, LEGACY_INDEX_KEY].concat(await legacyEntryKeys());
  await chrome.storage.local.remove(keys);
  return { ok: true };
}

async function removeHistory({ videoId }) {
  const next = (await getHistory()).filter((h) => h && h.video_id !== videoId);
  await chrome.storage.local.set({ [HISTORY_KEY]: next });
  if (videoId) await chrome.storage.local.remove(LEGACY_ENTRY_PREFIX + videoId);
  return { ok: true };
}

// --------------------------------------------------------------------------
// messages from the panel, popup and options

const handlers = {
  async settings() {
    return getSettings();
  },
  async saveSettings({ patch }) {
    return saveSettings(patch);
  },
  async currentPage() {
    return currentPage();
  },
  async health() {
    const settings = await getSettings();
    return apiGet(settings, '/health');
  },
  async languages({ url }) {
    const settings = await getSettings();
    const id = TranscriptLib.videoIdFromUrl(url);
    if (!id) throw new ApiError('That does not look like a YouTube link or id.', 0, 'invalid_url');
    const data = await apiGet(settings, TranscriptLib.languagesQuery(apiUrl(settings), url));
    return Object.assign({}, data, {
      // The API only knows the requested URL; the canonical watch URL is what
      // the panel links and names the record with.
      url: TranscriptLib.canonicalUrl(data.video_id || id),
    });
  },
  // Pulls one window of a transcript. The panel passes offset/limit to page
  // through a long video, or start/end/context for a focus range, or
  // verbatimOnly to get just the joined text for a copy.
  async transcript({ url, language, offset, limit, start, end, context, verbatimOnly }) {
    const settings = await getSettings();
    const id = TranscriptLib.videoIdFromUrl(url);
    if (!id) throw new ApiError('That does not look like a YouTube link or id.', 0, 'invalid_url');
    const opts = { offset, limit, start, end, context, verbatimOnly };
    const data = await apiGet(
      settings,
      TranscriptLib.transcriptQuery(apiUrl(settings), url, language || '', opts)
    );
    // Only the first, unpaged load of a video becomes a history entry; the
    // follow-on pages and focus/verbatim requests are the same video again.
    const isInitialLoad = !verbatimOnly && start == null && end == null && !(Number(offset) > 0);
    if (isInitialLoad) {
      const entry = {
        video_id: data.video_id,
        url: data.url,
        language: data.language,
        language_code: data.language_code,
        is_generated: data.is_generated,
        fetchedAt: Date.now(),
        // The page only carries `limit` segments; the real totals are in the
        // response metadata.
        segmentCount: data.total_segments,
        duration: data.duration,
      };
      addHistory(entry, settings).catch(() => {});
      // Verbatim duplicates the segments as a string; dropping it halves the
      // payload the panel has to parse.
      delete data.verbatim;
    }
    return data;
  },
  // The whole transcript as one string, fetched only when the user copies.
  async verbatim({ url, language }) {
    const settings = await getSettings();
    const id = TranscriptLib.videoIdFromUrl(url);
    if (!id) throw new ApiError('That does not look like a YouTube link or id.', 0, 'invalid_url');
    return apiGet(
      settings,
      TranscriptLib.transcriptQuery(apiUrl(settings), url, language || '', { verbatimOnly: true })
    );
  },
  async seek({ videoId, seconds }) {
    return seek({ videoId, seconds });
  },
  async history() {
    return getHistory();
  },
  async clearHistory() {
    return clearHistory();
  },
  async removeHistory({ videoId }) {
    return removeHistory({ videoId });
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Our own broadcasts: nothing to answer.
  if (msg && (msg.type === 'tab:changed' || msg.type === 'history:changed')) return false;
  const fn = handlers[msg && msg.type];
  if (!fn) {
    sendResponse({ ok: false, error: `unknown message ${msg && msg.type}` });
    return false;
  }
  Promise.resolve(fn(msg))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({
      ok: false,
      error: String(err.message || err),
      errorType: err.errorType || '',
      status: err.status || 0,
    }));
  return true;   // keep the channel open for the async reply
});

// The side panel is the UI; clicking the toolbar icon opens the popup, which
// offers to open the panel. Same behaviour as the other DRP extensions.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
