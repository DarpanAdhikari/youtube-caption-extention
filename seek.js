// YouTube Transcript - DRP: content script.
//
// Declared only for youtube.com, and its whole job is to move the playhead of
// the video already on the page. A timestamp click that reloaded the tab would
// lose the panel's scroll position and the watch state, so this is what makes
// "jump to 4:12" cost nothing.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'seek') return false;
  const video = document.querySelector('video');
  if (!video) {
    sendResponse({ ok: false, error: 'no video element on this page' });
    return false;
  }
  try {
    video.currentTime = Math.max(0, Number(msg.time) || 0);
    // A paused player would otherwise sit at the new frame doing nothing,
    // which reads as the click having failed.
    const played = video.play();
    if (played && typeof played.catch === 'function') played.catch(() => {});
    sendResponse({ ok: true });
  } catch (err) {
    sendResponse({ ok: false, error: String(err.message || err) });
  }
  return false;
});
