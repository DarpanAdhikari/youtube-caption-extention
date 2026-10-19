# YouTube Transcript - DRP

A Chrome side-panel extension that shows the full transcript of any YouTube video
with clickable timestamps that jump the player — plus a Focus mode for reading a
single time range, and a word-by-word compare against your own text.

Give it a YouTube URL (or press **This page** on the video you are watching) and it
reads the transcript from a local FastAPI service. The extension never scrapes
YouTube pages, never needs an account, and sends nothing anywhere except the API
address you configure.

## Features

- **Side panel** that works on any page — open it on a video, or paste any YouTube URL.
- **Clickable timestamps** — click a line to seek the player in place; if the video is
  in another tab, it opens at the right second.
- **Language picker** — the video's available transcript languages are listed, and the
  best match against your preferences (default `ne,en`) is chosen automatically.
- **Focus mode** — read one time range with a few context lines around it. Set the
  range by typing times, clicking lines, or dragging an optional slider. Only the
  window you need is fetched, so five-hour videos stay fast.
- **Compare** — paste your own text (a draft, subtitles, notes) and see a green/red
  word-by-word diff against the selected range, with a match percentage. Everything is
  computed in the browser; the pasted text never leaves it.
- **Lines / Paragraph view** — timestamped rows or flowing prose, in Full and Focus.
- **Copy** — the whole transcript or just the selected range, as plain text.
- **Recent** — the last N fetched videos as tiny summaries (no segments stored).
- **Long transcripts are paged** — 300 lines at a time, loaded as you scroll.

## Quick start

### 1. Run the transcript API

This extension is only the interface. Transcripts come from the companion FastAPI
app in [`python_proj/get-youtube-transcript-by-url`](https://github.com/DarpanAdhikari):

```bash
uvicorn app.main:app
```

It listens on `http://127.0.0.1:8000` by default. See that project's README for
setup, proxies and troubleshooting.

### 2. Load the extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Pin **YouTube Transcript - DRP** to the toolbar.

Requires Chrome 114+ (the side panel API).

### 3. Use it

- Watching a YouTube video? Open the side panel — the URL fills in and the
  transcript loads automatically.
- On any other page? Paste a YouTube URL and press **Fetch**.
- Click any timestamp to jump the video. Use the **Transcript** tab to switch between
  **Full** and **Focus** views.

## Focus mode

The **Transcript** tab has two views: **Full** (the whole transcript) and **Focus**
(one time range plus context lines before and after).

- Set the range with the `start` / `end` boxes — type `ss`, `mm:ss` or `h:mm:ss` and
  press Enter. The boxes commit on Enter/blur on purpose, so a half-typed `1:3` is not
  read as `1:03` while you are still typing.
- Or click a line to pin the range to it; **Shift+click** moves the end of the range.
- **Show slider** reveals a two-handle slider over the whole transcript — drag the
  handles or type in the boxes, they stay in sync.
- **Play from start** seeks the video to the range start. **Copy range** copies only
  the selected lines. **Reset** snaps back to the whole transcript.
- How many context lines appear on each side is configurable (default 2, range 0–5).
- Focus fetches just its time window from the API — moving the range triggers a
  debounced fetch, so dragging stays smooth on long videos.

## Compare with your text

In Focus mode, **Compare…** opens a field to paste text and compares it word by word
against the selected range (narrow the range first on long videos):

- **Green** — words in the transcript. A *dotted underline* marks transcript words
  your pasted text left out.
- **Red** — words that appear only in what you pasted.

Matching ignores case and punctuation, so `Hello,` matches `hello`. A summary line
shows the percentage match and how many words are only on each side. Very large inputs
fall back to a coarser (block-level) diff so the panel cannot freeze.

## Settings

Reachable from the panel's gear or the extension's options page.

| Setting | Meaning |
| --- | --- |
| Transcript API address | Where the FastAPI app listens, e.g. `http://127.0.0.1:8000` |
| Preferred languages | Comma-separated codes, most wanted first, e.g. `ne,en` |
| Recent history | How many transcripts to keep locally (max 50) |
| Context lines | Lines shown above and below the range in Focus mode (0–5) |

**Test connection** hits `GET /health` through the same path the panel uses, so it
reports whether the app is actually reachable.

## Project layout

| File | Role |
| --- | --- |
| `lib.js` | Pure helpers: URL/id parsing, time formatting, language pick, history summaries, query builders, word diff |
| `background.js` | Service worker: all API calls, active-tab lookup, seek routing, history storage |
| `seek.js` | Content script on youtube.com; moves the playhead of the open player |
| `sidepanel.html/js` | The URL row, language picker, transcript, Full/Focus views, compare, Recent list |
| `popup.html/js` | Launcher: says whether this tab is a video and opens the panel |
| `options.html/js` | Settings page |
| `style.css` | Dark ground, DRP red accent |
| `tests/view-logic.mjs` | Tests for the pure helpers |

Run the tests:

```bash
node --test tests/view-logic.mjs
```

## Troubleshooting

**"Cannot reach" error even though the API is running.**
The extension only has standing permission for `127.0.0.1` / `localhost`. If you set
a different address in Settings, the browser will ask you to allow access to that host
— without that grant the request is blocked. Press **Save** after changing the address
and accept the prompt.

**`youtube_blocked` from the API.**
YouTube is refusing the server's IP. Route the app through a proxy (see the API
project's README). Cloud hosts are blocked most.

**`no_transcript_found`.**
The video has no captions in the languages you asked for. Open
`/languages?url=…` on the API to see what exists, or pick another entry in the
**Transcript** list.

**Timestamp click opened a new tab instead of seeking.**
Clicking a timestamp can only seek a video that is already the active tab. Anywhere
else it opens the video at the right second, which costs a page load by necessity.

**Paging / Focus range fetches misbehave.**
The panel relies on the API's `offset`/`limit`, `start`/`end`/`context` and
`verbatim_only` parameters. An older API build will still answer, but these features
need the current one.

## Notes

- No account, no telemetry — the extension talks only to the API address you configure.
- All fetching happens in the service worker, which is why the FastAPI app needs no
  CORS headers.
- The popup's **Open the side panel** button works on any page, not just YouTube.

## Author

Built by [Darpan Adhikari](https://github.com/DarpanAdhikari) as part of the DRP
extension family.
