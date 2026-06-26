# WhatsApp Export Viewer

A local, browser-based viewer for exported WhatsApp group chats and media.

This project was built to preserve and review a WhatsApp group archive after the group itself is deleted. It lets you import a WhatsApp exported chat file and its media folder, then browse the conversation in a WhatsApp-like interface.

## Why This Exists

WhatsApp exports are useful, but reading a long `.txt` file with separate media files is painful. This viewer turns that export into a searchable local archive with message bubbles, sender names, date separators, and inline media previews.

The original use case was a stock market cohort group where members shared text, images, chart analysis, voice notes, videos, GIFs, and other files over several weeks.

## Features

- Import a WhatsApp exported `.txt` chat file.
- Import the exported media folder.
- View messages in a WhatsApp-style chat timeline.
- Display group sender names.
- Show date separators.
- Preview images inline.
- Play videos and audio files.
- Open or download document attachments.
- Mark missing exported media clearly.
- Search messages by keyword.
- Filter by sender.
- Filter by media type.
- Jump to a specific date.
- Store imported archives locally in the browser using IndexedDB.

## Privacy

This app runs locally in your browser.

Your chat export and media files are not uploaded to a server. Imported data is stored in your browser's local IndexedDB storage for this site.

## How To Use

1. Export your WhatsApp group chat with media from WhatsApp.
2. Open this project locally in a browser.
3. Select the exported `.txt` chat file.
4. Select the exported media folder.
5. Click **Build archive**.
6. Browse, search, and filter the preserved conversation.

## Run Locally

Because this is a static app, you can serve it with any simple local web server.

Using Python:

```powershell
python -m http.server 5173 --bind 127.0.0.1
```

Then open:

```text
http://127.0.0.1:5173/
```

## Project Structure

```text
index.html   Main app markup
styles.css   WhatsApp-style responsive UI
app.js       Browser app, IndexedDB storage, filters, rendering
parser.js    WhatsApp export parser and media type detection
```

## Supported Export Patterns

The parser supports common WhatsApp export formats such as:

```text
01/06/26, 9:15 AM - Alice: Message text
[01/06/26, 9:15:00 AM] Alice: Message text
```

It also handles multiline messages and common media references such as:

```text
IMG-20260601-WA0001.jpg (file attached)
<attached: PTT-20260601-WA0002.opus>
<Media omitted>
```

## Current Version

V1 - WhatsApp export viewer

This version focuses on preserving and browsing an exported WhatsApp chat locally.

## Planned Improvements

Possible V2 improvements:

- Bookmarks for important messages.
- Personal notes on messages.
- Tags such as chart-analysis, breakout, risk, or homework.
- Better large-archive performance.
- Export/import saved archive metadata.
- Multiple group archive management.
- Advanced date and media gallery views.
- Local SQLite or file-backed storage option.

## License

No license has been selected yet.
