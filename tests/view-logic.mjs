// view-logic.mjs — exercises the pure helpers in lib.js under node.
//
// These are the parts the panel and the worker both lean on: the URL parsing
// that decides what gets fetched, the language pick that decides which
// transcript, the history trim that keeps storage.local under quota, and the
// query strings the worker actually sends. They are pure precisely so they can
// be run without a browser.
//
//   node --test tests/view-logic.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../lib.js');

test('videoIdFromUrl accepts every URL form and a bare id', () => {
  const id = 'dQw4w9WgXcQ';
  assert.equal(L.videoIdFromUrl(`https://www.youtube.com/watch?v=${id}`), id);
  assert.equal(L.videoIdFromUrl(`https://youtu.be/${id}`), id);
  assert.equal(L.videoIdFromUrl(`https://www.youtube.com/shorts/${id}`), id);
  assert.equal(L.videoIdFromUrl(`https://www.youtube.com/embed/${id}`), id);
  assert.equal(L.videoIdFromUrl(`https://www.youtube.com/live/${id}`), id);
  assert.equal(L.videoIdFromUrl(`https://m.youtube.com/watch?v=${id}&t=30s`), id);
  assert.equal(L.videoIdFromUrl(id), id);
  assert.equal(L.videoIdFromUrl(`  ${id}  `), id);
});

test('videoIdFromUrl rejects what is not a video', () => {
  assert.equal(L.videoIdFromUrl(''), '');
  assert.equal(L.videoIdFromUrl('not a url'), '');
  assert.equal(L.videoIdFromUrl('https://www.youtube.com/watch?v=short'), '');
  assert.equal(L.videoIdFromUrl('https://example.com/watch?v=dQw4w9WgXcQ'), '');
  assert.equal(L.videoIdFromUrl('https://www.youtube.com/playlist?list=PL123'), '');
});

test('isYouTube requires a host and a path', () => {
  assert.equal(L.isYouTube('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), true);
  assert.equal(L.isYouTube('https://youtu.be/dQw4w9WgXcQ'), true);
  assert.equal(L.isYouTube('https://www.youtube.com/'), false);
  assert.equal(L.isYouTube('https://notyoutube.com/watch?v=x'), false);
  assert.equal(L.isYouTube(''), false);
});

test('formatTime never emits a negative or NaN', () => {
  assert.equal(L.formatTime(0), '0:00');
  assert.equal(L.formatTime(9), '0:09');
  assert.equal(L.formatTime(75), '1:15');
  assert.equal(L.formatTime(3661), '1:01:01');
  assert.equal(L.formatTime(-5), '0:00');
  assert.equal(L.formatTime(undefined), '0:00');
  assert.equal(L.formatTime('nonsense'), '0:00');
});

test('pickLanguage prefers exact, then a regional variant, then anything', () => {
  const available = [
    { language_code: 'de-DE', language: 'German' },
    { language_code: 'en', language: 'English' },
    { language_code: 'ne', language: 'Nepali' },
  ];
  assert.equal(L.pickLanguage(available, ['ne', 'en']), 'ne');
  assert.equal(L.pickLanguage(available, ['en', 'ne']), 'en');
  // "de" is not an exact code here, so it should still find de-DE.
  assert.equal(L.pickLanguage(available, ['de']), 'de-DE');
  // Nothing preferred exists: the first transcript beats refusing to fetch.
  assert.equal(L.pickLanguage(available, ['fr']), 'de-DE');
  assert.equal(L.pickLanguage([], ['ne']), '');
});

test('trimHistory keeps newest first, de-duplicates and caps', () => {
  const entries = [
    { video_id: 'a', fetchedAt: 1 },
    { video_id: 'b', fetchedAt: 3 },
    { video_id: 'a', fetchedAt: 5 },
    { video_id: 'c', fetchedAt: 2 },
  ];
  const trimmed = L.trimHistory(entries, 2);
  assert.deepEqual(trimmed.map((e) => e.video_id), ['a', 'b']);
  assert.equal(trimmed[0].fetchedAt, 5);
  // A limit of 0 means "keep none" is not a thing; the worker always passes a
  // positive limit, and this documents that no cap keeps everything.
  assert.equal(L.trimHistory(entries, 0).length, 3);
});

test('transcriptToText collapses whitespace and drops empty segments', () => {
  const text = L.transcriptToText([
    { text: '  Hello   there ' },
    { text: '' },
    { text: ' how\nare you ' },
  ]);
  assert.equal(text, 'Hello there how are you');
  assert.equal(L.transcriptToText([]), '');
});

test('historySummary drops the heavy fields and counts segments', () => {
  const summary = L.historySummary({
    video_id: 'abc',
    url: 'https://www.youtube.com/watch?v=abc',
    language: 'English',
    language_code: 'en',
    is_generated: true,
    fetchedAt: 42,
    segments: [{ start: 0 }, { start: 5 }, { start: 9 }],
    verbatim: 'a b c',
  });
  assert.deepEqual(summary, {
    video_id: 'abc',
    url: 'https://www.youtube.com/watch?v=abc',
    language: 'English',
    language_code: 'en',
    is_generated: true,
    fetchedAt: 42,
    segmentCount: 3,
    duration: 0,
  });
  // No segments is not a crash.
  assert.equal(L.historySummary({}).segmentCount, 0);
  assert.equal('segments' in summary, false);
  assert.equal('verbatim' in summary, false);
  // A stored summary keeps its counts instead of being zeroed out.
  const kept = L.historySummary({ video_id: 'x', segmentCount: 7, duration: 12.5 });
  assert.equal(kept.segmentCount, 7);
  assert.equal(kept.duration, 12.5);
});

test('the query builders match what the API expects', () => {
  const base = 'http://127.0.0.1:8000/';
  assert.equal(
    L.transcriptQuery(base, 'https://youtu.be/dQw4w9WgXcQ', 'ne'),
    'http://127.0.0.1:8000/transcript?url=https%3A%2F%2Fyoutu.be%2FdQw4w9WgXcQ&languages=ne'
  );
  assert.equal(
    L.transcriptQuery(base, 'dQw4w9WgXcQ', ''),
    'http://127.0.0.1:8000/transcript?url=dQw4w9WgXcQ'
  );
  assert.equal(
    L.languagesQuery(base, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
    'http://127.0.0.1:8000/languages?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ'
  );
});

test('originPattern drops the port and keeps the host', () => {
  assert.equal(L.originPattern('http://203.0.113.5:41334'), 'http://203.0.113.5/*');
  assert.equal(L.originPattern('https://transcripts.example.com/api'), 'https://transcripts.example.com/*');
  assert.equal(L.originPattern('203.0.113.5:8000'), 'http://203.0.113.5/*');
  assert.equal(L.originPattern(''), '');
  assert.equal(L.originPattern('ftp://203.0.113.5'), '');
});

test('transcriptQuery adds paging, range and verbatim options', () => {
  const base = 'http://127.0.0.1:8000';
  assert.equal(
    L.transcriptQuery(base, 'dQw4w9WgXcQ', 'en', { offset: 200, limit: 200 }),
    'http://127.0.0.1:8000/transcript?url=dQw4w9WgXcQ&languages=en&offset=200&limit=200'
  );
  assert.equal(
    L.transcriptQuery(base, 'dQw4w9WgXcQ', 'en', { start: 12.5, end: 30, context: 2 }),
    'http://127.0.0.1:8000/transcript?url=dQw4w9WgXcQ&languages=en&start=12.5&end=30&context=2'
  );
  assert.equal(
    L.transcriptQuery(base, 'dQw4w9WgXcQ', 'en', { verbatimOnly: true }),
    'http://127.0.0.1:8000/transcript?url=dQw4w9WgXcQ&languages=en&verbatim_only=true'
  );
  // Falsy / zero options stay out of the URL.
  assert.equal(
    L.transcriptQuery(base, 'dQw4w9WgXcQ', '', {}),
    'http://127.0.0.1:8000/transcript?url=dQw4w9WgXcQ'
  );
});

test('seekUrl floors and clamps the second', () => {
  assert.equal(L.seekUrl('dQw4w9WgXcQ', 75.9), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=75s');
  assert.equal(L.seekUrl('dQw4w9WgXcQ', -3), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=0s');
});

test('parseTimestamp reads ss, m:ss and h:mm:ss, and refuses the rest', () => {
  assert.equal(L.parseTimestamp('90'), 90);
  assert.equal(L.parseTimestamp(' 90 '), 90);
  assert.equal(L.parseTimestamp('1:30'), 90);
  assert.equal(L.parseTimestamp('1:02:03'), 3723);
  assert.equal(L.parseTimestamp('0:00'), 0);
  // A seconds field past 59 is ambiguous, so it is refused rather than guessed.
  assert.equal(L.parseTimestamp('1:90'), null);
  assert.equal(L.parseTimestamp('1:2:3:4'), null);
  assert.equal(L.parseTimestamp('abc'), null);
  assert.equal(L.parseTimestamp('1:2a'), null);
  assert.equal(L.parseTimestamp(''), null);
  assert.equal(L.parseTimestamp(null), null);
});

test('clampRange orders the ends and keeps them inside the transcript', () => {
  assert.deepEqual(L.clampRange(10, 4, 100), { start: 4, end: 10 });
  assert.deepEqual(L.clampRange(-5, 200, 100), { start: 0, end: 100 });
  assert.deepEqual(L.clampRange(NaN, 5, 100), { start: 0, end: 5 });
  assert.deepEqual(L.clampRange(5, 5, 0), { start: 0, end: 0 });
});

test('segmentEnd and transcriptDuration add duration to the start', () => {
  assert.equal(L.segmentEnd({ start: 4, duration: 1.5 }), 5.5);
  assert.equal(L.segmentEnd({ start: 4 }), 4);
  assert.equal(L.transcriptDuration([]), 0);
  assert.equal(L.transcriptDuration([
    { start: 0, duration: 1 },
    { start: 3, duration: 2 },
  ]), 5);
});

test('sliceContext returns the range plus the N lines either side', () => {
  const segs = 'abcdefg'.split('').map((text, i) => ({ start: i, duration: 1, text }));
  const mid = L.sliceContext(segs, 2, 4, 2);
  assert.deepEqual(mid.before.map((s) => s.text), ['a', 'b']);
  assert.deepEqual(mid.inRange.map((s) => s.text), ['c', 'd']);
  assert.deepEqual(mid.after.map((s) => s.text), ['e', 'f']);
});

test('sliceContext has no phantom context at the edges', () => {
  const segs = 'abc'.split('').map((text, i) => ({ start: i, duration: 1, text }));
  const first = L.sliceContext(segs, 0, 1, 2);
  assert.deepEqual(first.before.map((s) => s.text), []);
  assert.deepEqual(first.inRange.map((s) => s.text), ['a']);
  assert.deepEqual(first.after.map((s) => s.text), ['b', 'c']);

  const last = L.sliceContext(segs, 2, 3, 2);
  assert.deepEqual(last.before.map((s) => s.text), ['a', 'b']);
  assert.deepEqual(last.after.map((s) => s.text), []);
});

test('sliceContext falls back to the nearest line in a gap', () => {
  const segs = [
    { start: 0, duration: 1, text: 'a' },
    { start: 10, duration: 1, text: 'b' },
  ];
  const gap = L.sliceContext(segs, 4, 5, 2);
  assert.equal(gap.inRange.length, 1);
  assert.equal(gap.inRange[0].text, 'a');
  assert.deepEqual(L.sliceContext([], 0, 10, 2), { before: [], inRange: [], after: [] });
});

test('sliceContext treats a zero-width range as a point', () => {
  const segs = 'abc'.split('').map((text, i) => ({ start: i, duration: 1, text }));
  const point = L.sliceContext(segs, 1, 1, 1);
  assert.deepEqual(point.inRange.map((s) => s.text), ['b']);
  assert.deepEqual(point.before.map((s) => s.text), ['a']);
  assert.deepEqual(point.after.map((s) => s.text), ['c']);
});

test('tokenizeWords splits on space and keys ignore case and punctuation', () => {
  const tokens = L.tokenizeWords('Hello, world!  again');
  assert.deepEqual(tokens.map((t) => t.raw), ['Hello,', 'world!', 'again']);
  // Keys are the normalized form used for matching.
  assert.deepEqual(tokens.map((t) => t.key), ['hello', 'world', 'again']);
  assert.equal(L.tokenizeWords('').length, 0);
  assert.equal(L.tokenizeWords(null).length, 0);
});

test('diffWords marks matches, transcript-only and paste-only', () => {
  const runs = L.diffWords('the quick brown fox', 'the slow brown fox');
  assert.deepEqual(runs, [
    { type: 'equal', text: 'the' },
    { type: 'del', text: 'quick' },
    { type: 'ins', text: 'slow' },
    { type: 'equal', text: 'brown fox' },
  ]);
});

test('diffWords finds an inserted word and a missing word', () => {
  const inserted = L.diffWords('a b c', 'a b x c');
  assert.deepEqual(inserted, [
    { type: 'equal', text: 'a b' },
    { type: 'ins', text: 'x' },
    { type: 'equal', text: 'c' },
  ]);

  const missing = L.diffWords('a b x c', 'a b c');
  assert.deepEqual(missing, [
    { type: 'equal', text: 'a b' },
    { type: 'del', text: 'x' },
    { type: 'equal', text: 'c' },
  ]);
});

test('diffWords matches through case and punctuation differences', () => {
  const runs = L.diffWords('Hello, world!', 'hello world');
  assert.deepEqual(runs, [{ type: 'equal', text: 'Hello, world!' }]);
  // Punctuation-only tokens are not treated as equal to each other.
  const dots = L.diffWords('...', '???');
  assert.equal(dots.some((r) => r.type === 'equal'), false);
});

test('diffWords handles empty inputs both ways', () => {
  assert.deepEqual(L.diffWords('', ''), []);
  assert.deepEqual(L.diffWords('', 'new words'), [{ type: 'ins', text: 'new words' }]);
  assert.deepEqual(L.diffWords('old words', ''), [{ type: 'del', text: 'old words' }]);
});

test('diffStats counts each side and scores the overlap', () => {
  const stats = L.diffStats(L.diffWords('a b c d', 'a x c d'));
  assert.deepEqual(stats, { equal: 3, del: 1, ins: 1, percent: 60 });
  assert.deepEqual(L.diffStats([]), { equal: 0, del: 0, ins: 0, percent: 100 });
});
