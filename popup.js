// YouTube Transcript - DRP: popup.
//
// A shortcut, not a second UI. The transcript needs the room of the side panel,
// so the popup's one job is to say whether this tab is a video and open the
// panel on it.

const $ = (id) => document.getElementById(id);

function send(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res) return reject(new Error('the extension worker did not answer'));
      if (res.ok === false) return reject(new Error(res.error || 'failed'));
      resolve(res.result);
    });
  });
}

async function init() {
  let page = null;
  try {
    page = await send({ type: 'currentPage' });
  } catch { /* worker unreachable; treated as "no page" below */ }

  const label = $('page');
  const btn = $('open-panel');

  // The panel opens on any page. When the tab is a video it fetches by itself;
  // otherwise the user pastes a URL into the panel's field.
  if (page && page.isYouTube && TranscriptLib.videoIdFromUrl(page.url)) {
    label.textContent = page.title || page.url;
    $('status').textContent = 'The panel fetches this video as soon as it opens.';
  } else if (page && page.isYouTube) {
    label.textContent = page.title || page.url;
    $('status').textContent = 'No single video on this page — paste a URL in the panel.';
  } else {
    label.textContent = page && page.title ? page.title : 'This tab is not a YouTube video.';
    $('status').textContent = 'The panel opens anyway — paste a YouTube URL into its field.';
  }
  btn.disabled = false;

  btn.addEventListener('click', async () => {
    // The panel belongs to a window. Prefer the tab's window; fall back to the
    // window this popup is in, so the panel still opens when currentPage could
    // not resolve a tab.
    let windowId = page && page.windowId != null ? page.windowId : null;
    if (windowId == null) {
      try { windowId = (await chrome.windows.getCurrent()).id; } catch { /* ignore */ }
    }
    try {
      if (windowId != null) await chrome.sidePanel.open({ windowId });
    } catch { /* older Chrome; the panel still opens from the toolbar */ }
    window.close();
  });

  $('open-options').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
}

document.addEventListener('DOMContentLoaded', init);
