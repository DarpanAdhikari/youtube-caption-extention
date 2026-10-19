// YouTube Transcript - DRP: options page.

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

function cleanLanguages(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(',');
}

async function load() {
  const s = await send({ type: 'settings' });
  $('api').value = s.api;
  $('languages').value = s.languages;
  $('historyLimit').value = s.historyLimit;
  $('contextLines').value = s.contextLines;
}

// The baked-in permissions only cover 127.0.0.1/localhost. Any other address
// (a port-forwarded host, another machine, a tunnel) needs the user to grant
// access here — extension fetch() goes through CORS otherwise and fails.
// request() is called straight from the click, with no await before it, because
// it needs the user gesture; it resolves true without a prompt if already held.
function ensureHostPermission(api) {
  const pattern = TranscriptLib.originPattern(api);
  if (!pattern || !chrome.permissions) return Promise.resolve(true);
  return chrome.permissions.request({ origins: [pattern] });
}

async function save() {
  const limit = parseInt($('historyLimit').value, 10);
  const context = parseInt($('contextLines').value, 10);
  const api = $('api').value.trim().replace(/\/+$/, '');

  let grantError = '';
  try {
    if (!(await ensureHostPermission(api))) {
      grantError = 'Saved, but access to that address was not granted.';
    }
  } catch (err) {
    grantError = 'Saved, but access could not be requested.';
  }

  await send({
    type: 'saveSettings',
    patch: {
      api,
      languages: cleanLanguages($('languages').value) || 'ne,en',
      historyLimit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 50) : 10,
      contextLines: Number.isFinite(context) && context >= 0 ? Math.min(context, 5) : 2,
    },
  });
  $('saved').textContent = grantError || 'Saved.';
  setTimeout(() => { $('saved').textContent = ''; }, grantError ? 6000 : 2000);
}

async function test() {
  const box = $('status');
  box.className = 'status';
  box.textContent = 'Checking…';
  try {
    // Asked through the worker, not from this page: the worker is the context
    // that holds the host permission and does the real fetches, so this tests
    // the exact path the panel uses.
    await send({ type: 'health' });
    box.className = 'status ok';
    box.textContent = 'Reachable — the transcript API answered.';
  } catch (err) {
    box.className = 'status bad';
    box.textContent = `Could not reach it: ${err.message}. Is "uvicorn app.main:app" running?`;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await load();
  } catch (err) {
    $('status').className = 'status bad';
    $('status').textContent = String(err.message || err);
  }
  $('save').addEventListener('click', save);
  $('test').addEventListener('click', test);
});
