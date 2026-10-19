// YouTube Transcript - DRP: side panel.
//
// The panel owns no data. It asks the worker for a transcript and renders it;
// the worker holds the settings, the history and the host permissions that let
// it reach the local API.

const $ = (id) => document.getElementById(id);

// Mirrors the worker's defaults so a failed settings read still leaves a
// usable panel rather than one that throws on every path.
const DEFAULTS = { api: 'http://127.0.0.1:8000', languages: 'ne,en', historyLimit: 10, contextLines: 2 };

let settings = { ...DEFAULTS };
let available = [];         // the video's transcripts, from /languages
let selectedLanguage = '';
let history = [];

// The rendered transcript. `segments` holds only the pages fetched so far;
// `total`/`duration`/`hasMore` come from the API metadata and describe the whole
// video. A five-hour transcript is never all in memory at once.
let current = null;

// Bumped on every new transcript so a slow reply from the previous one cannot
// paint over the current view.
let loadGen = 0;

// How many segments one page of the Full list holds. Small enough to render
// instantly, large enough that scrolling does not refetch every screen.
const PAGE_SIZE = 300;

// Focus mode. The range is the single source of truth: the two time boxes, the
// slider and a line click all read from it and all write back through
// setRange(), so the three controls can never drift apart.
let mode = 'full';
let range = { start: 0, end: 0 };

// Focus renders only its time window, fetched from the API on demand, so the
// panel never holds the whole transcript to show a slice of it. This is that
// window plus the range it was fetched for, so a stale reply can be spotted.
let focusData = null;
let focusTimer = null;
let focusGen = 0;

// How the selected text is laid out: one line per segment, or a flowing
// paragraph in a selectable field.
let format = 'lines';

let listObserver = null;
let fullLoader = null;
let paraGen = 0;

let compareTimer = null;

function stopListing() {
  if (listObserver) {
    listObserver.disconnect();
    listObserver = null;
  }
}

// The URL the panel filled in on its own. A field still holding autoUrl is
// untouched, so replacing it when the tab changes is safe; anything the user
// pasted no longer matches and is left alone.
let autoUrl = '';

// ------------------------------------------------------------------- plumbing

function send(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res) return reject(new Error('the extension worker did not answer'));
      if (res.ok === false) {
        const err = new Error(res.error || 'failed');
        err.errorType = res.errorType || '';
        err.status = res.status || 0;
        return reject(err);
      }
      resolve(res.result);
    });
  });
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function toast(text, level) {
  const box = el('div', 'toast' + (level ? ' ' + level : ''), text);
  const host = $('toasts');
  host.appendChild(box);
  const life = level === 'error' || level === 'warn' ? 6000 : 3200;
  const timer = setTimeout(() => {
    box.classList.add('out');
    setTimeout(() => box.remove(), 200);
  }, life);
  box.addEventListener('click', () => { clearTimeout(timer); box.remove(); });
  while (host.children.length > 3) host.firstElementChild.remove();
}

async function copyText(text, button) {
  if (!text) { toast('There is nothing to copy yet.', 'warn'); return false; }
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    toast('Could not copy: ' + (err.message || err), 'error');
    return false;
  }
  if (button) {
    const was = button.textContent;
    button.textContent = 'Copied ✓';
    setTimeout(() => { button.textContent = was; }, 1500);
  }
  return true;
}

// The Copy button. When everything is already loaded it copies from memory;
// a still-paged transcript asks the API for the joined text first.
async function copyAll(button) {
  if (!current) return;
  const was = button.textContent;
  button.disabled = true;
  button.textContent = 'Copying…';
  try {
    const text = current.hasMore ? await fetchVerbatim() : fullText();
    const ok = await copyText(text, null);
    button.textContent = ok ? 'Copied ✓' : was;
    if (ok) setTimeout(() => { button.textContent = was; }, 1500);
  } catch (err) {
    toast('Could not copy: ' + (err.message || err), 'error');
    button.textContent = was;
  } finally {
    button.disabled = false;
  }
}

// ------------------------------------------------------------------- backend

function backendProblem(message) {
  const box = $('backend');
  box.className = 'backend bad';
  box.hidden = false;
  box.textContent = message;
}

function backendOk() {
  $('backend').hidden = true;
}

// The panel cannot fetch the API itself (no CORS), but it can still report
// whether the worker can reach it, which is the question that matters.
async function checkBackend() {
  try {
    await send({ type: 'health' });
    backendOk();
    return true;
  } catch (err) {
    backendProblem(String(err.message || err) + ' Open Settings to change the address.');
    return false;
  }
}

// ------------------------------------------------------------------- the tab

let currentPage = null;

function setHint(text, kind) {
  const hint = $('tab-hint');
  hint.textContent = text || '';
  hint.hidden = !text;
  hint.className = 'tab-hint' + (kind ? ' ' + kind : '');
}

function describePage(page) {
  if (!page || !page.url) return "Can't read this tab — paste a URL instead.";
  if (!page.isYouTube) {
    return `This tab isn't a YouTube page${page.title ? ` — ${page.title}` : ''}. `
      + 'Open a video, or paste a URL.';
  }
  return `This tab: ${page.title || page.url}`;
}

// Pull the active tab into the field. force is the This page button: an
// explicit request for this tab, so it wins over a pasted URL.
async function adoptCurrentPage({ andFetch = false, force = false } = {}) {
  let page;
  try {
    page = await send({ type: 'currentPage' });
  } catch (err) {
    setHint(`Can't reach the extension worker: ${String(err.message || err)}`, 'warn');
    return null;
  }
  currentPage = page || null;
  setHint(describePage(page), page && page.isYouTube ? 'found' : 'warn');
  if (!page || !page.url || !page.isYouTube) return page;
  if (force || !$('url').value.trim() || $('url').value.trim() === autoUrl) {
    $('url').value = page.url;
    autoUrl = page.url;
    if (andFetch) await fetchFor(page.url);
  }
  return page;
}

// ---------------------------------------------------------------------- fetch

function skeleton() {
  const box = el('div', 'skeletons');
  for (let i = 0; i < 5; i += 1) box.appendChild(el('div', 'skeleton'));
  return box;
}

function renderMessage(title, body, extraButton) {
  const box = el('div', 'empty');
  box.appendChild(el('p', 'empty-title', title));
  if (body) box.appendChild(el('p', 'empty-body', body));
  if (extraButton) {
    const wrap = el('div');
    wrap.style.marginTop = '10px';
    wrap.appendChild(extraButton);
    box.appendChild(wrap);
  }
  return box;
}

function fetchButton(label, url) {
  const btn = el('button', 'ghost small', label);
  btn.addEventListener('click', () => {
    $('url').value = url;
    fetchFor(url);
  });
  return btn;
}

// The main entry point. Load the video's transcript list first, then ask for
// the transcript in the best of the preferred languages that actually exists.
async function fetchFor(url) {
  const box = $('result');
  const value = (url || $('url').value || '').trim();
  if (!value) { toast('Paste a YouTube URL first.', 'warn'); return; }

  $('fetch').disabled = true;
  $('fetch').textContent = 'Fetching…';
  $('lang-row').hidden = true;
  box.textContent = '';
  box.appendChild(skeleton());

  try {
    const langs = await send({ type: 'languages', url: value });
    available = langs.transcripts || [];
    $('url').value = langs.url || value;
    autoUrl = $('url').value;

    if (!available.length) {
      throw Object.assign(new Error('This video has no transcripts at all.'), { errorType: 'no_transcript_found' });
    }

    selectedLanguage = TranscriptLib.pickLanguage(
      available,
      String(settings.languages || '').split(',').map((s) => s.trim()).filter(Boolean)
    );
    renderLanguagePicker();
    await loadTranscript(value, selectedLanguage);
  } catch (err) {
    current = null;
    $('lang-row').hidden = true;
    renderError(err, value);
    $('fetch').disabled = false;
    $('fetch').textContent = 'Fetch';
    return;
  }
  $('fetch').disabled = false;
  $('fetch').textContent = 'Fetch';
}

async function loadTranscript(url, language) {
  const box = $('result');
  box.textContent = '';
  box.appendChild(skeleton());
  resetCompare();
  const gen = ++loadGen;
  try {
    // Only the first page comes back here; the rest follows as the list is
    // scrolled. `total_segments`/`duration` describe the whole video.
    const data = await send({ type: 'transcript', url, language, offset: 0, limit: PAGE_SIZE });
    if (gen !== loadGen) return;
    current = {
      video_id: data.video_id,
      url: data.url,
      language: data.language,
      language_code: data.language_code,
      is_generated: data.is_generated,
      segments: data.segments || [],
      total: data.total_segments || (data.segments || []).length,
      duration: data.duration || 0,
      hasMore: !!data.has_more,
    };
    focusData = null;
    fullLoader = null;
    paraGen += 1;
    // A new transcript starts in Full with the range covering all of it, so
    // Focus is always one click from a sane starting point.
    mode = 'full';
    range = { start: 0, end: maxDuration() };
    renderResult();
    switchTab('transcript');
    backendOk();
  } catch (err) {
    if (gen !== loadGen) return;
    current = null;
    renderError(err, url);
  }
}

function renderLanguagePicker() {
  const row = $('lang-row');
  const select = $('language');
  select.textContent = '';
  for (const t of available) {
    const opt = el('option');
    opt.value = t.language_code;
    opt.textContent = `${t.language} · ${t.language_code} · ${t.is_generated ? 'auto' : 'manual'}`;
    select.appendChild(opt);
  }
  select.value = selectedLanguage;
  row.hidden = false;
}

function renderError(err, url) {
  const box = $('result');
  box.textContent = '';
  $('view-bar').hidden = true;
  $('focus-controls').hidden = true;
  const type = err.errorType || '';
  const id = TranscriptLib.videoIdFromUrl(url);

  if (type === 'no_transcript_found' || type === 'transcript_unavailable') {
    box.appendChild(renderMessage(
      'No transcript here.',
      String(err.message || err),
      fetchButton('Try the current page instead', currentPage && currentPage.url ? currentPage.url : url)
    ));
  } else if (type === 'youtube_blocked') {
    box.appendChild(renderMessage(
      'YouTube is blocking the server.',
      String(err.message || err)
    ));
  } else if (type === 'unreachable') {
    box.appendChild(renderMessage(
      'The transcript API is not running.',
      String(err.message || err)
    ));
    backendProblem(String(err.message || err));
  } else if (type === 'no_host_permission') {
    const openSettings = el('button', 'ghost small', 'Open Settings');
    openSettings.addEventListener('click', () => chrome.runtime.openOptionsPage());
    box.appendChild(renderMessage('Give the extension access to the API.', String(err.message || err), openSettings));
  } else if (type === 'invalid_url' || type === 'invalid_video_id') {
    box.appendChild(renderMessage('That URL is not usable.', String(err.message || err)));
  } else {
    box.appendChild(renderMessage('Could not get the transcript.', String(err.message || err)));
  }

  if (id) {
    const open = el('button', 'ghost small', 'Open on YouTube');
    open.addEventListener('click', () => chrome.tabs.create({ url: TranscriptLib.canonicalUrl(id) }));
    box.appendChild(open);
  }
}

// --------------------------------------------------------------------- result

// The whole video's length, from the API metadata. Falls back to the longest
// loaded segment for an older response, and is cached because the slider reads
// it on every tick.
function maxDuration() {
  if (!current) return 0;
  if (current.duration) return current.duration;
  if (current._duration == null) {
    current._duration = TranscriptLib.transcriptDuration(current.segments);
  }
  return current._duration;
}

// Plain text of whatever is currently in memory. Only used when everything is
// loaded; copy/full-text paths for a paged transcript ask the API for verbatim.
function fullText() {
  return current ? TranscriptLib.transcriptToText(current.segments) : '';
}

// The whole transcript as one string, fetched on demand. The API caches the
// parsed transcript, so this is a cheap round trip even for a long video.
async function fetchVerbatim() {
  if (!current) return '';
  const data = await send({ type: 'verbatim', url: current.url, language: current.language_code });
  return data.verbatim || '';
}

function renderResult() {
  const box = $('result');
  box.textContent = '';
  if (!current) {
    renderViewBar();
    renderFocusControls();
    return;
  }

  const id = current.video_id;
  const head = el('div', 'result-head');

  const img = el('img');
  img.alt = '';
  img.src = TranscriptLib.thumbnailUrl(id);
  // A broken image icon where a thumbnail belongs looks like a bug, so a
  // missing one leaves an empty box instead.
  img.addEventListener('error', () => { img.removeAttribute('src'); });
  head.appendChild(img);

  const meta = el('div', 'meta');
  const title = el('div', 'title', current.url || TranscriptLib.canonicalUrl(id));
  meta.appendChild(title);
  const length = maxDuration();
  meta.appendChild(el('div', 'sub', `${id} · ${TranscriptLib.formatTime(length)} of transcript`));
  const chips = el('div');
  chips.appendChild(el('span', 'chip ' + (current.is_generated ? 'gen' : 'manual'),
    current.is_generated ? 'auto-generated' : 'manual'));
  chips.appendChild(el('span', 'chip', current.language_code));
  chips.appendChild(el('span', 'chip', `${current.total || current.segments.length} segments`));
  meta.appendChild(chips);
  head.appendChild(meta);

  const acts = el('div', 'acts');
  const copy = el('button', 'primary small', 'Copy');
  copy.title = 'Copy the whole transcript as plain text';
  copy.addEventListener('click', () => copyAll(copy));
  acts.appendChild(copy);
  const open = el('button', 'ghost small', 'Watch');
  open.title = 'Open the video on YouTube';
  open.addEventListener('click', () => chrome.tabs.create({ url: TranscriptLib.canonicalUrl(id) }));
  acts.appendChild(open);
  head.appendChild(acts);

  box.appendChild(head);

  const body = el('div', 'result-body');
  body.id = 'result-body';
  box.appendChild(body);

  renderViewBar();
  renderFocusControls();
  renderBody();
}

// Re-drawn on its own when the range moves, so dragging a slider never rebuilds
// the header (and its thumbnail) sixty times a second.
function renderBody() {
  const body = $('result-body');
  if (!body) return;
  stopListing();
  fullLoader = null;
  // Cancels any paragraph still being fetched, so a late reply cannot paint
  // over whatever view is now showing.
  paraGen += 1;
  body.textContent = '';
  if (!current) return;

  if (mode === 'focus') {
    const fd = focusData && focusData.videoId === current.video_id ? focusData : null;
    if (!fd) {
      body.appendChild(renderMessage(
        'Loading range…',
        'The lines inside the range are fetched from the API.'
      ));
      return;
    }
    // Classified against the window it was fetched for, not the live range, so
    // the context lines stay correct if a debounced refresh has not landed yet.
    const slice = TranscriptLib.sliceContext(fd.segments, fd.start, fd.end, settings.contextLines);
    if (format === 'para') renderParagraph(body, slice.inRange);
    else renderFocusBody(body, slice);
    return;
  }

  if (!current.segments.length) {
    body.appendChild(renderMessage('The transcript is empty.', 'YouTube returned no segments for this video.'));
    return;
  }

  if (format === 'para') renderFullParagraph(body);
  else renderFullBody(body);
}

// One view of the text, run together as prose in a field-like box. It used to
// also paint a read-only textarea, which showed the same transcript twice.
function renderParagraphText(box, text) {
  if (!text) {
    box.appendChild(renderMessage('Nothing to show here.', 'No lines fall inside this range.'));
    return;
  }
  const field = el('div', 'para-field', text);
  field.setAttribute('tabindex', '0');
  field.setAttribute('aria-label', 'Selected text');
  box.appendChild(field);
}

function renderParagraph(box, segments) {
  renderParagraphText(box, TranscriptLib.transcriptToText(segments));
}

// A paragraph of the whole transcript needs every segment, not just the loaded
// pages, so it asks the API for the joined text. Guarded by paraGen so toggling
// back to Lines before the reply lands cannot repaint the panel.
async function renderFullParagraph(box) {
  const gen = paraGen;
  box.appendChild(renderMessage('Loading text…', null));
  try {
    const text = await fetchVerbatim();
    if (gen !== paraGen || !$('result-body')) return;
    const body = $('result-body');
    body.textContent = '';
    renderParagraphText(body, text);
  } catch (err) {
    if (gen !== paraGen || !$('result-body')) return;
    const body = $('result-body');
    body.textContent = '';
    body.appendChild(renderMessage('Could not load the text.', String(err.message || err)));
  }
}

function segmentRow(seg, opts) {
  const options = opts || {};
  const classes = ['seg'];
  if (options.context) classes.push('ctx');
  if (options.active) classes.push('active');
  const row = el('div', classes.join(' '));

  const time = el('button', 'time', TranscriptLib.formatTime(seg.start));
  time.title = 'Jump the video to ' + TranscriptLib.formatTime(seg.start);
  time.addEventListener('click', (e) => {
    // Without this the row's own click handler would also fire and move the
    // range on a plain seek.
    e.stopPropagation();
    jumpTo(current.video_id, seg.start, time);
  });
  row.appendChild(time);
  row.appendChild(el('span', 'txt', seg.text));

  row.title = 'Click to focus this line · Shift+click to set the range end';
  row.addEventListener('click', (e) => {
    if (e.target.closest('.time')) return;
    selectLine(seg, e.shiftKey);
  });
  return row;
}

function renderFullBody(box) {
  const list = el('div', 'segments');
  list.id = 'segment-list';
  box.appendChild(list);

  const foot = el('div', 'load-more');
  const more = el('button', 'ghost small', 'Load more');
  const status = el('span', 'muted load-status');
  foot.appendChild(more);
  foot.appendChild(status);
  list.appendChild(foot);

  fullLoader = { list, foot, more, status, rendered: 0, fetching: false };
  more.addEventListener('click', pumpFullList);
  pumpFullList();

  if ('IntersectionObserver' in window) {
    listObserver = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) pumpFullList();
    }, { rootMargin: '300px' });
    listObserver.observe(foot);
  }
}

// Paints the segments loaded so far, then either reports progress or pulls the
// next page once the footer scrolls into view. A whole page renders at once —
// at PAGE_SIZE that is cheap — while the expensive part (the network) is what
// stays lazy.
function pumpFullList() {
  const L = fullLoader;
  if (!L || !current) return;
  const loaded = current.segments.length;
  if (L.rendered < loaded) {
    const frag = document.createDocumentFragment();
    for (; L.rendered < loaded; L.rendered += 1) {
      frag.appendChild(segmentRow(current.segments[L.rendered]));
    }
    L.list.insertBefore(frag, L.foot);
  }

  const total = current.total || loaded;
  const allLoaded = !current.hasMore && L.rendered >= loaded;
  L.more.hidden = allLoaded;
  if (allLoaded) {
    L.status.textContent = `All ${total} lines shown.`;
    stopListing();
    renderViewBar();
    return;
  }
  L.status.textContent = `Showing ${L.rendered} of ${total} lines — scroll for more.`;
  if (L.rendered >= loaded && current.hasMore && !L.fetching) fetchNextPage();
}

async function fetchNextPage() {
  const L = fullLoader;
  if (!L || !current || L.fetching) return;
  L.fetching = true;
  L.status.textContent = 'Loading more…';
  const gen = loadGen;
  try {
    const data = await send({
      type: 'transcript',
      url: current.url,
      language: current.language_code,
      offset: current.segments.length,
      limit: PAGE_SIZE,
    });
    if (gen !== loadGen || fullLoader !== L || !current) return;
    current.segments.push(...(data.segments || []));
    current.hasMore = !!data.has_more;
    current.total = data.total_segments || current.total;
  } catch (err) {
    if (gen === loadGen && fullLoader === L) {
      L.status.textContent = 'Could not load more — tap Load more to retry.';
      toast('Could not load more lines: ' + (err.message || err), 'warn');
    }
  } finally {
    L.fetching = false;
    if (gen === loadGen && fullLoader === L) pumpFullList();
  }
}

// Top context, the selected range, bottom context. The dimmed blocks are the
// lines just outside the range; clicking any of them widens the range to there.
function renderFocusBody(box, slice) {
  const wrap = el('div', 'focus-body');

  if (slice.before.length) {
    const top = el('div', 'ctx-block');
    top.appendChild(el('div', 'ctx-label', 'before'));
    for (const seg of slice.before) top.appendChild(segmentRow(seg, { context: true }));
    wrap.appendChild(top);
  }

  const mid = el('div', 'range-block');
  for (const seg of slice.inRange) mid.appendChild(segmentRow(seg, { active: true }));
  wrap.appendChild(mid);

  if (slice.after.length) {
    const bottom = el('div', 'ctx-block');
    bottom.appendChild(el('div', 'ctx-label', 'after'));
    for (const seg of slice.after) bottom.appendChild(segmentRow(seg, { context: true }));
    wrap.appendChild(bottom);
  }

  box.appendChild(wrap);
}

// ------------------------------------------------------------------ focus data
//
// Focus fetches just the window it shows, so the panel never holds the whole
// transcript to display a slice of it. Requests are debounced so a slider drag
// does not fire one per pixel, and each reply carries a generation so a slow
// response cannot overwrite a newer range.

function focusDataMatches() {
  return !!focusData
    && !!current
    && focusData.videoId === current.video_id
    && focusData.start === range.start
    && focusData.end === range.end;
}

function ensureFocusRange(immediate) {
  if (mode !== 'focus' || !current) return;
  if (focusDataMatches()) return;
  if (focusTimer) clearTimeout(focusTimer);
  if (immediate) { fetchFocusRange(); return; }
  focusTimer = setTimeout(fetchFocusRange, 200);
}

async function fetchFocusRange() {
  if (mode !== 'focus' || !current) return;
  const gen = ++focusGen;
  const start = range.start;
  const end = range.end;
  const videoId = current.video_id;
  try {
    const data = await send({
      type: 'transcript',
      url: current.url,
      language: current.language_code,
      start,
      end,
      context: Number(settings.contextLines),
    });
    if (gen !== focusGen || !current || current.video_id !== videoId) return;
    focusData = { videoId, start, end, segments: data.segments || [] };
    renderBody();
    updateFocusInfo();
    refreshCompareIfOpen();
  } catch (err) {
    if (gen !== focusGen) return;
    toast('Could not load that range: ' + (err.message || err), 'warn');
    renderBody();
  }
}

// ------------------------------------------------------------- focus controls

// Every control for the range writes back through setRange, and setRange pushes
// the value back into all of them. That is what keeps the two time boxes and the
// slider showing the same instant no matter which one was touched last.
function setRange(start, end) {
  range = TranscriptLib.clampRange(start, end, maxDuration());
  syncTimeInputs();
  syncSlider();
  updateFocusInfo();
  renderBody();
  renderViewBar();
  ensureFocusRange(false);
  refreshCompareIfOpen();
}

function setMode(next) {
  const enteringFocus = next === 'focus' && mode !== 'focus';
  if (enteringFocus) {
    // Range starts as the whole video, which for an hour-long transcript is
    // exactly the payload paging exists to avoid. Open on a short window first;
    // the controls still reach the rest.
    const dur = maxDuration();
    if (range.end <= 0 || range.end >= dur) {
      range = { start: 0, end: Math.min(60, dur) };
    }
    focusData = null;
  }
  mode = next === 'focus' ? 'focus' : 'full';
  renderViewBar();
  renderFocusControls();
  renderBody();
  if (mode === 'focus') ensureFocusRange(true);
  // Compare is a focus-range tool; leaving focus hides it.
  if (mode === 'full') $('compare-box').hidden = true;
  refreshCompareIfOpen();
}

function setFormat(next) {
  format = next === 'para' ? 'para' : 'lines';
  renderViewBar();
  renderBody();
}

function renderViewBar() {
  const bar = $('view-bar');
  bar.hidden = !current;
  $('mode-full').classList.toggle('active', mode === 'full');
  $('mode-focus').classList.toggle('active', mode === 'focus');
  $('fmt-lines').classList.toggle('active', format === 'lines');
  $('fmt-para').classList.toggle('active', format === 'para');
  const info = $('view-info');
  if (!current) info.textContent = '';
  else if (mode === 'focus') info.textContent = `${TranscriptLib.formatTime(range.start)} – ${TranscriptLib.formatTime(range.end)}`;
  else info.textContent = `${current.total || current.segments.length} segments`;
}

function renderFocusControls() {
  const show = mode === 'focus' && !!current;
  $('focus-controls').hidden = !show;
  if (!show) return;
  syncTimeInputs();
  syncSlider();
  updateFocusInfo();
}

function syncTimeInputs() {
  $('focus-start').value = TranscriptLib.formatTime(range.start);
  $('focus-end').value = TranscriptLib.formatTime(range.end);
}

function syncSlider() {
  const max = Math.max(1, Math.ceil(maxDuration()));
  const lo = $('focus-lo');
  const hi = $('focus-hi');
  lo.max = String(max);
  hi.max = String(max);
  const start = Math.min(range.start, max);
  const end = Math.min(range.end, max);
  lo.value = String(start);
  hi.value = String(end);
  const highlight = $('focus-highlight');
  const a = (start / max) * 100;
  const b = (end / max) * 100;
  highlight.style.left = a + '%';
  highlight.style.width = Math.max(0, b - a) + '%';
}

function updateFocusInfo() {
  if (!current) return;
  const fd = focusData && focusData.videoId === current.video_id ? focusData : null;
  let lines = 0;
  if (fd) {
    lines = TranscriptLib.sliceContext(fd.segments, fd.start, fd.end, settings.contextLines).inRange.length;
  }
  $('focus-info').textContent =
    `${TranscriptLib.formatTime(range.end - range.start)} · ${lines} line${lines === 1 ? '' : 's'}`;
}

// A plain click on a line pins the range to that line; shift extends the end to
// it. Either way the panel switches to Focus, because that is what the click
// asked for. Mode and range are set together so only one fetch is triggered.
function selectLine(seg, shift) {
  if (!current) return;
  const start = shift ? range.start : seg.start;
  const end = TranscriptLib.segmentEnd(seg);
  const wasFocus = mode === 'focus';
  mode = 'focus';
  range = TranscriptLib.clampRange(start, end, maxDuration());
  if (!wasFocus) focusData = null;
  syncTimeInputs();
  syncSlider();
  updateFocusInfo();
  renderViewBar();
  renderFocusControls();
  ensureFocusRange(false);
  renderBody();
  refreshCompareIfOpen();
}

function commitTimeInputs() {
  const start = TranscriptLib.parseTimestamp($('focus-start').value);
  const end = TranscriptLib.parseTimestamp($('focus-end').value);
  // A box left unparseable keeps its previous value rather than snapping to 0,
  // which would throw the range away over a typo.
  setRange(start == null ? range.start : start, end == null ? range.end : end);
}

function resetRange() {
  setRange(0, maxDuration());
}

function copyRange() {
  const fd = focusData && current && focusData.videoId === current.video_id ? focusData : null;
  if (!fd) { toast('The range is still loading.', 'warn'); return; }
  const slice = TranscriptLib.sliceContext(fd.segments, fd.start, fd.end, settings.contextLines);
  const text = TranscriptLib.transcriptToText(slice.inRange);
  copyText(text, $('focus-copy'));
}

// ---------------------------------------------------------------- compare

// The text the comparison runs against: the lines inside the current Focus
// range, fetched from the API. Narrowing the range is how a five-hour video
// stays comparable, so Compare only exists in Focus.
function compareSourceText() {
  const fd = focusData && current && focusData.videoId === current.video_id ? focusData : null;
  if (!fd) return '';
  const slice = TranscriptLib.sliceContext(fd.segments, fd.start, fd.end, settings.contextLines);
  return TranscriptLib.transcriptToText(slice.inRange);
}

function toggleCompare() {
  const box = $('compare-box');
  box.hidden = !box.hidden;
  if (!box.hidden) $('compare-input').focus();
}

function clearCompare() {
  $('compare-input').value = '';
  $('compare-result').textContent = '';
  $('compare-info').textContent = '';
}

// Painted in order: matched and transcript-only words green, paste-only words
// red, so the transcript reads as green with your added words picked out.
function renderDiff(runs) {
  const box = $('compare-result');
  box.textContent = '';
  for (const run of runs) {
    const cls = run.type === 'ins' ? 'd-ins' : (run.type === 'del' ? 'd-del' : 'd-eq');
    box.appendChild(el('span', cls, run.text));
    box.appendChild(document.createTextNode(' '));
  }
}

function runCompare() {
  if (!current) return;
  const mine = $('compare-input').value.trim();
  if (!mine) {
    $('compare-result').textContent = '';
    $('compare-info').textContent = 'Paste some text first.';
    return;
  }
  const source = compareSourceText();
  if (!source) {
    $('compare-result').textContent = '';
    $('compare-info').textContent = 'The range is still loading.';
    return;
  }
  const runs = TranscriptLib.diffWords(source, mine);
  renderDiff(runs);
  const stats = TranscriptLib.diffStats(runs);
  $('compare-info').textContent =
    `${stats.percent}% match · ${stats.del} only in transcript · ${stats.ins} only in yours`;
}

// Re-run the diff when the range or view moves, but only while the box is open
// with text in it — otherwise moving the slider would do needless work. Debounced
// so a slider drag recomputes once it settles, not on every tick.
function refreshCompareIfOpen() {
  const box = $('compare-box');
  if (box.hidden) return;
  if (!$('compare-input').value.trim()) return;
  if (compareTimer) clearTimeout(compareTimer);
  compareTimer = setTimeout(runCompare, 150);
}

function resetCompare() {
  $('compare-box').hidden = true;
  clearCompare();
}


async function jumpTo(videoId, seconds, button) {
  if (button) button.disabled = true;
  try {
    const r = await send({ type: 'seek', videoId, seconds });
    if (r.mode === 'navigated') {
      toast('Opened the video at ' + TranscriptLib.formatTime(seconds) + '.', 'info');
    }
  } catch (err) {
    toast('Could not jump: ' + (err.message || err), 'warn');
  } finally {
    if (button) button.disabled = false;
  }
}

// -------------------------------------------------------------------- history

async function refreshHistory() {
  try {
    history = await send({ type: 'history' });
  } catch {
    history = [];
  }
  renderHistory();
}

function fmtWhen(ts) {
  const diff = Date.now() - (ts || 0);
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return new Date(ts).toLocaleDateString();
}

function renderHistory() {
  const box = $('history');
  box.textContent = '';
  const pill = $('count-recent');
  pill.textContent = String(history.length);
  pill.hidden = history.length === 0;

  if (!history.length) {
    box.appendChild(renderMessage('Nothing fetched yet.', 'Paste a YouTube URL above, or load one from this tab.'));
    return;
  }

  for (const entry of history) {
    const row = el('div', 'hist');

    const img = el('img');
    img.alt = '';
    img.src = TranscriptLib.thumbnailUrl(entry.video_id);
    img.addEventListener('error', () => { img.removeAttribute('src'); });
    row.appendChild(img);

    const meta = el('div', 'meta');
    meta.appendChild(el('div', 't', entry.url || TranscriptLib.canonicalUrl(entry.video_id)));
    const bits = [fmtWhen(entry.fetchedAt)];
    if (entry.language) bits.push(entry.language);
    if (entry.segmentCount) bits.push(`${entry.segmentCount} segments`);
    meta.appendChild(el('div', 'd', bits.join(' · ')));
    row.appendChild(meta);

    const acts = el('div', 'acts');
    const open = el('button', 'small', 'Open');
    open.addEventListener('click', () => openFromHistory(entry, open));
    acts.appendChild(open);
    const del = el('button', 'small ghost danger', '×');
    del.title = 'Remove from history';
    del.addEventListener('click', async () => {
      try {
        await send({ type: 'removeHistory', videoId: entry.video_id });
        await refreshHistory();
      } catch (err) {
        toast(String(err.message || err), 'error');
      }
    });
    acts.appendChild(del);
    row.appendChild(acts);

    box.appendChild(row);
  }
}

// The list carries only summaries now (the segments are gone), so opening an
// entry refetches its first page from the API — same path as a fresh fetch.
async function openFromHistory(entry, button) {
  if (button) button.disabled = true;
  const url = entry.url || TranscriptLib.canonicalUrl(entry.video_id);
  try {
    resetCompare();
    $('url').value = url;
    autoUrl = url;
    selectedLanguage = entry.language_code || '';
    available = [];
    $('lang-row').hidden = true;
    await loadTranscript(url, selectedLanguage);
    switchTab('transcript');
  } catch (err) {
    toast(String(err.message || err), 'error');
  } finally {
    if (button) button.disabled = false;
  }
}
// ----------------------------------------------------------------------- tabs

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === name);
  });
  document.querySelectorAll('.pane').forEach((p) => {
    p.classList.toggle('active', p.id === `pane-${name}`);
  });
  if (name === 'recent') refreshHistory();
}

// ----------------------------------------------------------------------- init

function init() {
  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => switchTab(t.dataset.tab));
  });

  $('fetch').addEventListener('click', () => fetchFor($('url').value));
  $('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') fetchFor($('url').value); });

  $('current-page').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const page = await adoptCurrentPage({ andFetch: true, force: true });
      if (page && !page.isYouTube) btn.blur();
    } finally {
      btn.disabled = false;
    }
  });

  $('language').addEventListener('change', async (e) => {
    selectedLanguage = e.target.value;
    await loadTranscript($('url').value, selectedLanguage);
  });

  $('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

  // ---- focus mode controls
  $('mode-full').addEventListener('click', () => setMode('full'));
  $('mode-focus').addEventListener('click', () => setMode('focus'));
  $('fmt-lines').addEventListener('click', () => setFormat('lines'));
  $('fmt-para').addEventListener('click', () => setFormat('para'));

  // The two time boxes are the primary control. They commit on Enter or blur
  // rather than on every keystroke, so a half-typed "1:3" never becomes 1:03.
  for (const id of ['focus-start', 'focus-end']) {
    $(id).addEventListener('change', commitTimeInputs);
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') { commitTimeInputs(); $(id).blur(); } });
  }

  $('focus-lo').addEventListener('input', () => {
    if (Number($('focus-lo').value) > range.end) $('focus-lo').value = String(range.end);
    setRange(Number($('focus-lo').value), range.end);
  });
  $('focus-hi').addEventListener('input', () => {
    if (Number($('focus-hi').value) < range.start) $('focus-hi').value = String(range.start);
    setRange(range.start, Number($('focus-hi').value));
  });

  $('focus-slider-toggle').addEventListener('change', (e) => {
    $('focus-slider').hidden = !e.target.checked;
  });

  $('focus-play').addEventListener('click', () => {
    if (current) jumpTo(current.video_id, range.start, $('focus-play'));
  });
  $('focus-copy').addEventListener('click', copyRange);
  $('focus-reset').addEventListener('click', resetRange);
  $('focus-compare').addEventListener('click', toggleCompare);
  $('compare-run').addEventListener('click', runCompare);
  $('compare-clear').addEventListener('click', clearCompare);
  $('compare-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runCompare(); }
  });

  $('clear-history').addEventListener('click', async () => {
    await send({ type: 'clearHistory' }).catch(() => {});
    await refreshHistory();
  });

  // The worker pushes a tab change whenever the active tab moves, so the field
  // follows the browser without the panel polling.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'tab:changed') {
      const page = msg.page;
      if (!page || page.isExtension) return;
      currentPage = page;
      setHint(describePage(page), page.isYouTube ? 'found' : 'warn');
      if (!page.isYouTube) return;
      const field = $('url').value.trim();
      if (field && field !== autoUrl) return;   // the user typed; leave it
      $('url').value = page.url;
      autoUrl = page.url;
      // Coming to a video loads it by itself, but only when the field is ours
      // (a pasted URL bowed out above) and it is not the one already shown.
      if (!current || current.video_id !== TranscriptLib.videoIdFromUrl(page.url)) {
        fetchFor(page.url);
      }
    }
    if (msg && msg.type === 'history:changed') {
      history = msg.history || [];
      if ($('pane-recent').classList.contains('active')) renderHistory();
      const pill = $('count-recent');
      pill.textContent = String(history.length);
      pill.hidden = history.length === 0;
    }
  });

  // Settings are loaded first: the fetch that follows needs the preferred
  // languages and the API address.
  send({ type: 'settings' })
    .then((s) => { settings = Object.assign({}, DEFAULTS, s); })
    .catch((err) => {
      settings = { ...DEFAULTS };
      backendProblem(`Cannot read the extension's settings: ${String(err.message || err)}`);
    })
    .then(() => adoptCurrentPage({ andFetch: true }))
    .then(() => {
      const page = currentPage;
      if (!page || !page.isYouTube) {
        $('result').appendChild(renderMessage(
          'No transcript yet.',
          'Paste a YouTube URL above, or open a video and press This page.'
        ));
      }
      return checkBackend();
    })
    .catch((err) => toast(String(err.message || err), 'error'));

  refreshHistory();
}

document.addEventListener('DOMContentLoaded', init);
