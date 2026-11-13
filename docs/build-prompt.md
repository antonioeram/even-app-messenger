# The build prompt

This project was built in conversation with an AI coding agent over two days. The prompt below condenses everything that was asked for along the way, including the corrections made after trying each version on real glasses. Give it to a coding agent to rebuild the project from an empty repository, or use it as a starting point for a variant of your own (another messenger, another pair of glasses).

It describes the result, not the path: the first version used a native list container, which real glasses accepted and never drew. [platform-notes.md](platform-notes.md) records what the hardware did differently from the documentation.

Replace the values in angle brackets with your own.

---

```text
Build "Even Messenger": a personal app for Even Realities G2 glasses (with the
R1 ring) that shows my WhatsApp chats and lets me answer them by voice or with
ready-made replies. Everything runs on my own server. No third party sees my
messages or my recordings.

## Constraints

- One gateway written in Go. It links to WhatsApp as a companion device
  (whatsmeow), stores chats and messages in SQLite (no CGO) and serves a small
  JSON API. No Matrix server, no bridge software.
- The gateway is never reachable from the internet. The phone reaches it
  through my VPN to the home network. No Tailscale, no Cloudflare Tunnel.
- HTTPS with a Let's Encrypt certificate obtained by DNS validation, behind my
  existing nginx. The proxy accepts private source addresses only.
- The glasses app is installed through a private Even Hub beta channel.
- Alerts for new messages stay with the phone's native notifications. The app
  is for reading and answering.
- Nothing is ever sent without a confirming click.
- All text on the glasses is English and plain ASCII: the firmware font drops
  the glyphs it lacks, without an error. Message text is transliterated
  (accents removed, emoji shown as "[emoji]"); what I send keeps its accents.
- No passwords, tokens or WhatsApp session in the repository. The repository
  is public (Apache-2.0): no host names, addresses or personal data in code,
  documents or commit messages.
- Write every part test first: Go with `go test ./...`, the glasses app with
  vitest and `tsc --noEmit`. Verify in the Even Hub simulator before each
  release, and say plainly what was not verified on real glasses.

## Repository layout

- gateway/   Go: config, HTTP server, SQLite store, ASCII transliteration,
             WhatsApp connector, speech-to-text client
- glasses/   TypeScript, Vite, @evenrealities/even_hub_sdk: the web app that
             the Even app runs in a WebView on the phone
- deploy/    Docker Compose, reverse proxy notes
- contrib/   an example speech-to-text server (faster-whisper)
- docs/      what was learned about the platform

## Gateway

Configuration comes from environment variables: listen address, bearer token,
CORS origins, data directory, WhatsApp on/off, speech-to-text URL and
languages, quick replies, time zone.

API. Every call needs the bearer token, except /health and the empty /admin
page. CORS allows any origin, because the WebView origin is
http://127.0.0.1:<port> with a port that changes on every start.

- GET  /health                       status and version
- GET  /chats?limit&offset&filter    one page of a chat list; filter is
                                     "unread" or "unanswered"; each chat has
                                     id, name, group, unread, clock, preview,
                                     last_from_me
- GET  /counts                       number of chats: unread, unanswered, all
- GET  /chats/{id}/messages          newest messages, or with before and
                                     before_id the page that precedes a
                                     message (same-second messages must not
                                     be skipped)
- POST /chats/{id}/read              clears the gateway's own unread counter;
                                     sends no read receipt
- POST /chats/{id}/send              sends text to an existing chat
- POST /transcribe                   raw PCM (16 kHz, 16 bit, mono) in, text
                                     out, plus an ASCII form and the language
- GET  /replies                      the quick replies: text and ASCII form
- GET  /changes?since=N              long poll: answers when a message
                                     arrives or an unread count changes, or
                                     after 25 seconds with the same number
- GET  /admin, /admin/status,
  POST /admin/pair                   QR pairing page for WhatsApp

Rules for the data:
- "Unanswered" means a direct chat (no groups) that is read and whose newest
  message is not mine. "Unread" means the unread counter is above zero.
- Lists are ordered unread first, then newest first.
- The preview of a chat is always its last message in reading order.
- A message's sender is shown by the current contact name, never by a bare
  phone number when a name is known.
- Media shows as a label such as "[Photo]" or "[Voice message 0:12]".
- Speech-to-text goes to a Whisper server on my own network. Detection is
  limited to the languages I speak; when it picks another one, transcribe
  again in the first of mine.
- Logs carry method, path, status and origin. Never message text, recordings,
  transcripts or the pairing code.
- Databases are upgraded in place at start.

## Glasses app

The display is 576 x 288, green, one proportional font, at most 8 text
containers and 4 image containers per page.

Screens:
- Home is the Unread list. Its last two rows open the other lists:
  "Unanswered" and "All chats", one line each, centred vertically in the box,
  without numbers.
- A list shows four bordered boxes per page. A chat box has the name and the
  time on the first line and the newest text on the second, prefixed "Me:"
  when I wrote it and followed by the number of unread messages. Leave space
  between the boxes, and keep the text away from the box edge.
- The selected box is marked by a narrow framed cell attached to its left
  side, with a ">" drawn in lines, centred vertically, and by brighter text.
  It must stand out without being distracting. No avatars or decorative
  images.
- The title of a list shows how many chats it holds. A long list loads the
  next page as the selection reaches the last loaded chat.
- A chat is message bubbles, theirs on the left and mine on the right, each
  headed by the sender and the time. It opens on the newest page. Scrolling
  up turns to older pages and, past the first one, loads older messages.
- Opening a chat on the glasses marks it read on the gateway.

Gestures, from the ring and from the temples alike:
- list: scroll moves the selection, click opens, double click goes home, and
  on the home list double click asks to exit
- chat: scroll turns pages, click lists the quick replies, hold records a
  voice reply, double click goes back to the list it came from
- quick replies: scroll and click choose one, hold records instead, double
  click goes back
- a chosen or dictated reply is shown first: click sends, double click cancels

Behaviour:
- While the app is open it waits on /changes and reloads the list or the open
  chat by itself. It must not disturb me: not while I read an older page, not
  while a reply is in progress, not when the selection is far down a long
  list. A reload keeps the selection where it was.
- Gestures can arrive faster than the glasses draw: draw only the last state.
- When the gateway cannot be reached, show the address and the reason on the
  glasses, with the gesture that retries.
- The phone page of the app shows the build, the gateway address and a log
  that survives restarts.

What real hardware taught us (follow these):
- Use text containers only. A rebuild with a native list container was
  accepted and never drawn.
- The container that captures input must fit its text exactly, or the
  firmware scrolls it internally and swallows swipes. Use a one-line title
  strip without padding for input.
- textContainerUpgrade changes text and brightness without flicker; position,
  size, border and padding need a rebuild. Keep the list layout stable and
  change texts in place.
- A click from the ring arrives as a system event with an event source and no
  event type. Treat it as a click.
- Draw the selection marker as small images beside the rows and update their
  pixels in place. If the glasses refuse them, fall back to ">" in the text.
- The page's localStorage does not survive a restart; use the bridge storage.
- The Even app does not update a beta build by itself.

## Deployment

Docker Compose for the gateway, with the data in a named volume. Document the
reverse proxy for plain nginx and for Nginx Proxy Manager, the certificate by
DNS validation and its renewal, the checks to run from a device on the VPN,
and the check that a request from outside fails.

`npm run pack` builds the app for one gateway: it writes the gateway origin
into the network whitelist of the manifest and produces the .ehpk. The token
is compiled into that package, so the package stays private.

## Documentation

A README in English: what it does, status with what is and is not confirmed
on real glasses, how it works, warnings (unofficial WhatsApp client, never
expose the gateway, the token inside the package), requirements, step by step
installation, gestures, configuration, development, known limits, license.

My values: gateway host <gateway.example.com>, package id
<com.yourname.messenger>, languages I dictate in <ro,en>, time zone
<Europe/Bucharest>, quick replies <OK|Yes|No|Thanks|On my way>.
```

---

## What the prompt leaves out

- **Email.** Reading and answering mail (IMAP/SMTP) is planned as a second source next to WhatsApp and is not written.
- **Other messengers.** Telegram and Signal would each be another connector in the gateway and another row on the home screen.
- **Your infrastructure.** VPN, DNS, certificate and reverse proxy are yours to set up; [deploy/README.md](../deploy/README.md) lists the steps.
