// YouTube Transcript - DRP: shared pure helpers.
//
// These are deliberately free of chrome.* and DOM references so they can be
// lifted and run under node in tests/view-logic.mjs. background.js pulls them in
// with importScripts(), the panel and options pages with a <script> tag, and the
// test file with require().
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TranscriptLib = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
  var PATH_ID = /\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/;

  // Host must be youtube.com or youtu.be with a path, so a bare "youtube.com"
  // is not a page. The leading-dot alternative stops "notyoutube.com" matching.
  function isYouTube(url) {
    if (!url) return false;
    return /^(https?:\/\/)?([a-z0-9-]+\.)*youtube\.com\/.+/i.test(url)
      || /^(https?:\/\/)?([a-z0-9-]+\.)*youtu\.be\/.+/i.test(url);
  }

  // Accepts a full URL (watch, youtu.be, shorts, embed, live) or a bare id.
  // Returns '' when nothing usable can be found, so callers can tell "no id"
  // from "an id that happens to be empty".
  function videoIdFromUrl(urlOrId) {
    if (!urlOrId) return '';
    var value = String(urlOrId).trim();
    if (VIDEO_ID.test(value)) return value;
    if (value.indexOf('://') < 0) value = 'https://' + value;

    var parsed;
    try { parsed = new URL(value); } catch (e) { return ''; }
    var host = (parsed.hostname || '').toLowerCase();

    if (host === 'youtu.be' || host === 'www.youtu.be') {
      var candidate = parsed.pathname.replace(/^\/+/, '').split('/')[0];
      return VIDEO_ID.test(candidate) ? candidate : '';
    }

    if (host === 'youtube.com' || /(^|\.)youtube\.com$/.test(host)
        || host === 'youtube-nocookie.com' || /(^|\.)youtube-nocookie\.com$/.test(host)) {
      var queryId = parsed.searchParams.get('v') || '';
      if (VIDEO_ID.test(queryId)) return queryId;
      var match = PATH_ID.exec(parsed.pathname);
      if (match) return match[1];
    }
    return '';
  }

  function canonicalUrl(videoId) {
    return 'https://www.youtube.com/watch?v=' + videoId;
  }

  // A link the browser can open on its own when the video is not the active
  // tab, and which starts playback at the right second after the reload.
  function seekUrl(videoId, seconds) {
    var at = Math.max(0, Math.floor(Number(seconds) || 0));
    return 'https://www.youtube.com/watch?v=' + videoId + '&t=' + at + 's';
  }

  function thumbnailUrl(videoId) {
    return 'https://img.youtube.com/vi/' + videoId + '/hqdefault.jpg';
  }

  // Whole seconds as m:ss, or h:mm:ss past an hour. Used for the time chips,
  // so it must never emit a negative or NaN.
  function formatTime(seconds) {
    var total = Math.max(0, Math.floor(Number(seconds) || 0));
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return h ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  }

  // The preference list is a set of codes, in order. Exact code first, then a
  // regional variant of it ("en" should pick up "en-US"), otherwise the first
  // transcript the video actually has rather than failing on a technicality.
  function pickLanguage(available, preferred) {
    var list = available || [];
    if (!list.length) return '';
    var prefs = preferred || [];
    for (var i = 0; i < prefs.length; i += 1) {
      var exact = list.find(function (t) { return t.language_code === prefs[i]; });
      if (exact) return exact.language_code;
    }
    for (var j = 0; j < prefs.length; j += 1) {
      var base = String(prefs[j]).split('-')[0];
      var variant = list.find(function (t) {
        var code = String(t.language_code);
        return code.split('-')[0] === base;
      });
      if (variant) return variant.language_code;
    }
    return list[0].language_code;
  }

  // One clip per line is what an importer expects, so segment text is joined
  // with a single space and internal whitespace is collapsed. This matches the
  // API's own "verbatim" field.
  function transcriptToText(segments) {
    var list = segments || [];
    return list
      .map(function (s) { return String(s.text || '').trim(); })
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Newest first, de-duplicated by video id (a re-fetch moves the entry to the
  // top rather than creating a second one), and capped. The store is in
  // storage.local, which has a hard quota, so the cap is not decoration.
  function trimHistory(entries, limit) {
    var cap = Number(limit) > 0 ? Math.floor(Number(limit)) : 0;
    var seen = new Set();
    var sorted = (entries || [])
      .filter(function (e) { return e && e.video_id; })
      .sort(function (a, b) { return (b.fetchedAt || 0) - (a.fetchedAt || 0); });
    var out = [];
    for (var i = 0; i < sorted.length; i += 1) {
      var id = sorted[i].video_id;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(sorted[i]);
      if (cap && out.length >= cap) break;
    }
    return out;
  }

  // The small shape the panel's Recent list needs. A five-hour transcript is
  // megabytes of segments; sending those through every history message would
  // freeze the panel, so the list only ever carries this and the full record is
  // fetched by id when the user actually opens one.
  function historySummary(entry) {
    var e = entry || {};
    return {
      video_id: e.video_id,
      url: e.url,
      language: e.language,
      language_code: e.language_code,
      is_generated: e.is_generated,
      fetchedAt: e.fetchedAt,
      segmentCount: e.segments ? e.segments.length : (Number(e.segmentCount) || 0),
      duration: Number(e.duration) || 0,
    };
  }

  // The two requests the worker ever makes against the transcript API, built in
  // one place so the panel, the options test button and the tests agree. The
  // opts carry paging (offset/limit) or a time window (start/end/context), and
  // verbatimOnly asks for just the joined text. Long transcripts are pulled one
  // page at a time, so this is how "load more on scroll" is expressed.
  function transcriptQuery(base, url, language, opts) {
    var root = String(base || '').replace(/\/+$/, '');
    var q = '?url=' + encodeURIComponent(url);
    if (language) q += '&languages=' + encodeURIComponent(language);
    var o = opts || {};

    var offset = Number(o.offset);
    if (isFinite(offset) && offset > 0) q += '&offset=' + Math.floor(offset);
    var limit = Number(o.limit);
    if (isFinite(limit) && limit > 0) q += '&limit=' + Math.floor(limit);
    if (o.start != null && isFinite(Number(o.start))) q += '&start=' + Number(o.start);
    if (o.end != null && isFinite(Number(o.end))) q += '&end=' + Number(o.end);
    var context = Number(o.context);
    if (isFinite(context) && context > 0) q += '&context=' + Math.floor(context);
    if (o.verbatimOnly) q += '&verbatim_only=true';
    return root + '/transcript' + q;
  }

  function languagesQuery(base, url) {
    var root = String(base || '').replace(/\/+$/, '');
    return root + '/languages?url=' + encodeURIComponent(url);
  }

  // The match-pattern form of an API address, e.g. http://203.0.113.5/*. The
  // baked-in host_permissions only cover 127.0.0.1/localhost, so a remote API
  // address needs this to check (and request) access. Match patterns ignore
  // ports, so the port is deliberately dropped.
  function originPattern(base) {
    var value = String(base || '').trim();
    if (!value) return '';
    if (value.indexOf('://') < 0) value = 'http://' + value;
    var url;
    try { url = new URL(value); } catch (e) { return ''; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (!url.hostname) return '';
    return url.protocol + '//' + url.hostname + '/*';
  }

  function describeTranscript(t) {
    var bits = [];
    if (t.language) bits.push(t.language);
    if (t.language_code) bits.push(t.language_code);
    bits.push(t.is_generated ? 'auto-generated' : 'manual');
    bits.push((t.segments || []).length + ' segments');
    return bits.join(' · ');
  }

  // ---------------------------------------------------------------- focus

  function segmentEnd(seg) {
    return (Number(seg && seg.start) || 0) + (Number(seg && seg.duration) || 0);
  }

  // The last second the transcript covers. Used as the slider's maximum and as
  // the end of the default range, so a slider drag can always reach the end.
  function transcriptDuration(segments) {
    var list = segments || [];
    var max = 0;
    for (var i = 0; i < list.length; i += 1) {
      var e = segmentEnd(list[i]);
      if (e > max) max = e;
    }
    return max;
  }

  // Accepts what a person types: a bare second count, m:ss, or h:mm:ss. Returns
  // null for anything else so the caller can leave the previous range alone
  // rather than treating a typo as zero.
  function parseTimestamp(text) {
    if (text == null) return null;
    var value = String(text).trim();
    if (!value) return null;

    if (/^\d+(\.\d+)?$/.test(value)) return Math.floor(Number(value));

    var parts = value.split(':');
    if (parts.length !== 2 && parts.length !== 3) return null;
    for (var i = 0; i < parts.length; i += 1) {
      if (!/^\d+$/.test(parts[i])) return null;
    }
    var total = 0;
    for (var j = 0; j < parts.length; j += 1) total = total * 60 + Number(parts[j]);
    // Seconds field beyond 59 makes "1:90" ambiguous; refuse it rather than
    // silently reading it as a different time than the user meant.
    if (Number(parts[parts.length - 1]) > 59) return null;
    return total;
  }

  // Start and end, forced into order and inside the transcript. Any change to
  // one control goes through here, so the inputs, the slider and a line click
  // can never disagree about the range.
  function clampRange(start, end, max) {
    var top = Number(max);
    if (!isFinite(top) || top < 0) top = 0;
    var s = Number(start);
    var e = Number(end);
    if (!isFinite(s)) s = 0;
    if (!isFinite(e)) e = 0;
    s = Math.min(Math.max(s, 0), top);
    e = Math.min(Math.max(e, 0), top);
    if (s > e) { var t = s; s = e; e = t; }
    return { start: s, end: e };
  }

  // The heart of focus mode: the lines inside [start, end] plus the context
  // lines immediately outside them. A range that falls in a gap still gets the
  // nearest line, because an empty middle would read as a bug rather than as
  // "nothing is said there".
  function sliceContext(segments, start, end, context) {
    var list = segments || [];
    var n = Number(context);
    if (!isFinite(n) || n < 0) n = 2;
    if (!list.length) return { before: [], inRange: [], after: [] };

    var s = Number(start);
    var e = Number(end);
    if (!isFinite(s)) s = 0;
    if (!isFinite(e)) e = 0;
    if (s > e) { var t = s; s = e; e = t; }

    var first = -1;
    var last = -1;
    for (var i = 0; i < list.length; i += 1) {
      // Intersection with [start, end). A zero-width range is treated as a
      // point so a single line can still be selected by clicking it.
      var a = Number(list[i].start) || 0;
      var b = segmentEnd(list[i]);
      var hit = (e > s) ? (b > s && a < e) : (a <= s && s < b);
      if (hit) {
        if (first < 0) first = i;
        last = i;
      }
    }

    if (first < 0) {
      // Nearest by start time to the point (or the middle of a range).
      var target = (e > s) ? (s + e) / 2 : s;
      var best = 0;
      var bestDist = Infinity;
      for (var k = 0; k < list.length; k += 1) {
        var d = Math.abs((Number(list[k].start) || 0) - target);
        if (d < bestDist) { bestDist = d; best = k; }
      }
      first = best;
      last = best;
    }

    var floor = Math.floor(n);
    return {
      before: list.slice(Math.max(0, first - floor), first),
      inRange: list.slice(first, last + 1),
      after: list.slice(last + 1, last + 1 + floor),
    };
  }

  // ------------------------------------------------------------------- diff
  //
  // Word-level comparison of a transcript against text the user pasted. "equal"
  // is a word in both, "del" is only in the transcript and "ins" only in the
  // paste. Matching ignores case and punctuation because auto-captions carry
  // almost none, so "Hello," and "hello" are the same word.

  // The comparison matrix is O(n*m); past this many cells the exact pass is
  // skipped for a coarse one, so pasting into a five-hour transcript cannot
  // allocate hundreds of megabytes or lock the panel.
  var MAX_DIFF_CELLS = 8000000;

  function wordKey(word) {
    var w = String(word == null ? '' : word);
    try { w = w.normalize('NFKC'); } catch (e) { /* older engine: match as-is */ }
    var key = w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    // A token that is nothing but punctuation has no letters; fall back to its
    // raw form so two unrelated "..." do not falsely match as equal.
    return key || String(word == null ? '' : word).toLowerCase();
  }

  function tokenizeWords(text) {
    var matches = String(text == null ? '' : text).match(/\S+/g) || [];
    var out = [];
    for (var i = 0; i < matches.length; i += 1) {
      out.push({ raw: matches[i], key: wordKey(matches[i]) });
    }
    return out;
  }

  function appendRun(runs, type, word) {
    var last = runs[runs.length - 1];
    if (last && last.type === type) last.text += ' ' + word;
    else runs.push({ type: type, text: word });
  }

  function diffWords(aText, bText) {
    var a = tokenizeWords(aText);
    var b = tokenizeWords(bText);
    if (a.length * b.length > MAX_DIFF_CELLS) return diffCoarse(a, b);
    return diffLCS(a, b);
  }

  // Classic longest-common-subsequence table, walked back into runs. Built
  // bottom-right to top-left so the backtrace only moves up or left.
  function diffLCS(a, b) {
    var n = a.length;
    var m = b.length;
    var runs = [];
    var k;
    if (!n) { for (k = 0; k < m; k += 1) appendRun(runs, 'ins', b[k].raw); return runs; }
    if (!m) { for (k = 0; k < n; k += 1) appendRun(runs, 'del', a[k].raw); return runs; }

    var width = m + 1;
    var dp = new Uint32Array((n + 1) * width);
    for (var i = n - 1; i >= 0; i -= 1) {
      var row = i * width;
      var next = (i + 1) * width;
      for (var j = m - 1; j >= 0; j -= 1) {
        if (a[i].key === b[j].key) dp[row + j] = dp[next + j + 1] + 1;
        else {
          var down = dp[next + j];
          var right = dp[row + j + 1];
          dp[row + j] = down >= right ? down : right;
        }
      }
    }

    i = 0;
    var jj = 0;
    while (i < n && jj < m) {
      if (a[i].key === b[jj].key) { appendRun(runs, 'equal', a[i].raw); i += 1; jj += 1; }
      else if (dp[(i + 1) * width + jj] >= dp[i * width + jj + 1]) { appendRun(runs, 'del', a[i].raw); i += 1; }
      else { appendRun(runs, 'ins', b[jj].raw); jj += 1; }
    }
    while (i < n) { appendRun(runs, 'del', a[i].raw); i += 1; }
    while (jj < m) { appendRun(runs, 'ins', b[jj].raw); jj += 1; }
    return runs;
  }

  // For inputs too big for the exact table: peel the common prefix and suffix,
  // then either run the exact pass on what is left or mark the remainder as one
  // block of deletions followed by one of insertions. Not minimal, but bounded.
  function diffCoarse(a, b) {
    var runs = [];
    var ai = 0;
    var aj = a.length;
    var bi = 0;
    var bj = b.length;
    while (ai < aj && bi < bj && a[ai].key === b[bi].key) { appendRun(runs, 'equal', a[ai].raw); ai += 1; bi += 1; }
    var tail = [];
    while (aj > ai && bj > bi && a[aj - 1].key === b[bj - 1].key) { tail.push(a[aj - 1].raw); aj -= 1; bj -= 1; }

    var midA = a.slice(ai, aj);
    var midB = b.slice(bi, bj);
    if (midA.length * midB.length <= MAX_DIFF_CELLS) {
      var middle = diffLCS(midA, midB);
      for (var r = 0; r < middle.length; r += 1) {
        var run = middle[r];
        runs.push({ type: run.type, text: run.text });
      }
    } else {
      for (var x = 0; x < midA.length; x += 1) appendRun(runs, 'del', midA[x].raw);
      for (var y = 0; y < midB.length; y += 1) appendRun(runs, 'ins', midB[y].raw);
    }
    for (var t = tail.length - 1; t >= 0; t -= 1) appendRun(runs, 'equal', tail[t]);
    return runs;
  }

  function diffStats(runs) {
    var counts = { equal: 0, del: 0, ins: 0 };
    for (var i = 0; i < runs.length; i += 1) {
      var words = runs[i].text ? runs[i].text.split(' ').length : 0;
      counts[runs[i].type] += words;
    }
    var union = counts.equal + counts.del + counts.ins;
    return {
      equal: counts.equal,
      del: counts.del,
      ins: counts.ins,
      percent: union ? Math.round((counts.equal / union) * 100) : 100,
    };
  }

  return {
    isYouTube: isYouTube,
    videoIdFromUrl: videoIdFromUrl,
    canonicalUrl: canonicalUrl,
    seekUrl: seekUrl,
    thumbnailUrl: thumbnailUrl,
    formatTime: formatTime,
    pickLanguage: pickLanguage,
    transcriptToText: transcriptToText,
    trimHistory: trimHistory,
    historySummary: historySummary,
    transcriptQuery: transcriptQuery,
    languagesQuery: languagesQuery,
    originPattern: originPattern,
    describeTranscript: describeTranscript,
    segmentEnd: segmentEnd,
    transcriptDuration: transcriptDuration,
    parseTimestamp: parseTimestamp,
    clampRange: clampRange,
    sliceContext: sliceContext,
    tokenizeWords: tokenizeWords,
    diffWords: diffWords,
    diffStats: diffStats,
  };
});
