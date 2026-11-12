# Even Messenger

Read your WhatsApp chats on Even Realities G2 glasses and answer them by voice. Everything runs on your own server: no third party sees your messages or your recordings.

| Unread box | Reading a chat |
| --- | --- |
| ![Unread box](docs/img/inbox.png) | ![Reading a chat](docs/img/chat.png) |

Screenshots are from the Even Hub simulator, with made-up data.

## What it does

- **Unread box.** The home screen lists the chats with unread messages, four boxes per page: a round avatar with the person's initials, then name, time and the newest message.
- **Unanswered and All chats.** Two more boxes, listed on the home screen with the number of chats in each: read chats that still wait for your reply, and every chat.
- **Reading.** A chat opens as message bubbles, theirs on the left and yours on the right, each with the sender's name and the time. It opens on the newest page; scroll up for older messages.
- **Voice reply.** Hold the touchpad and speak. The recording is transcribed on your server and the text appears on the glasses. A click sends it; a double click cancels. Nothing is sent without that click.
- **Ring or temple.** All gestures work from the R1 ring and from the temple touchpads.

Email (IMAP/SMTP) is planned and not written yet.

## Status

Early, and built for one person's daily use.

| Part | State |
| --- | --- |
| Gateway, WhatsApp link, history, live messages | Runs on a home server with a real account |
| Lists with avatars, reading and ring input on real G2 glasses | Works |
| Transcription (Romanian and English) through the gateway | Tested with recorded speech |
| Recording on the glasses and sending the reply | Covered by automated tests and the simulator; not yet confirmed on real glasses |

## How it works

```
G2 glasses  <-BLE->  Even app on the phone  <-HTTPS over your VPN->  gateway  <->  WhatsApp
                     (runs glasses/ in a WebView)                    (Go, Docker)
                                                                        |
                                                                        +-> speech-to-text server (optional)
```

| Directory | Contents | Technology |
| --- | --- | --- |
| `gateway/` | Keeps the WhatsApp session, stores chats and messages in SQLite, serves the API and the pairing page | Go, [whatsmeow](https://github.com/tulir/whatsmeow) |
| `glasses/` | The web app that the Even app runs for the glasses | TypeScript, Vite, Even Hub SDK |
| `deploy/` | Docker Compose files and reverse proxy notes | Docker |
| `contrib/stt-server/` | Example speech-to-text server (faster-whisper) | Python |
| `docs/` | What we learned about the Even Hub platform | |

The gateway is the only component that talks to WhatsApp. It links to your account as a companion device, like WhatsApp Web.

## Before you start

Read this first.

- **WhatsApp forbids unofficial clients in its terms of service.** Your account can be restricted or banned. The risk is yours.
- **Do not expose the gateway to the internet.** Whoever reaches it with the token can read and send your messages. Reach it through a VPN to your home network.
- **The token is inside the `.ehpk` package.** Anyone who has the file can extract it. Keep the package private and install it through your own private beta channel.
- This project is not affiliated with Even Realities, WhatsApp or Meta.

## Requirements

- Even Realities G2 glasses, the Even app 2.2.10 or newer, and a developer account on [hub.evenrealities.com](https://hub.evenrealities.com).
- A server at home with Docker, always on.
- A VPN from the phone to the home network (WireGuard, for example).
- A host name for the gateway with a valid HTTPS certificate. The Even app WebView does not accept plain `http` outside development. A Let's Encrypt certificate obtained by DNS validation needs no open port.
- Node.js 22 and Go 1.27 on the machine where you build.
- Optional, for voice replies: a machine that can run Whisper. A GPU makes it fast; a CPU works with a small model.

## Installation

### 1. Start the gateway

```bash
git clone https://github.com/antonioeram/even-app-messenger.git
cd even-app-messenger/deploy
cp .env.example .env
```

Put a token in `.env`: set `GATEWAY_TOKEN` to the output of `openssl rand -hex 32`. Then:

```bash
docker compose up -d --build
```

```bash
curl -s http://127.0.0.1:8080/health
```

The answer is `{"status":"ok","version":"0.6.0"}`.

### 2. Put HTTPS in front of it

Add a reverse proxy host with a valid certificate that forwards to the gateway, and allow only your LAN and VPN ranges. [deploy/README.md](deploy/README.md) has the details for plain nginx and for Nginx Proxy Manager.

Check from a device on the VPN:

```bash
curl -s https://gateway.example.com/health
```

### 3. Link WhatsApp

1. Open `https://gateway.example.com/admin` in a browser on your home network.
2. Type the gateway token and press **Connect**. A QR code appears.
3. On the phone: WhatsApp > Settings > Linked devices > Link a device. Scan the code.

The page shows `connected`, and the device appears in WhatsApp as "Even Messenger". The gateway then receives your recent history. Pairing codes are offered for 20 minutes after a start; the page has a button to ask for new ones.

### 4. Build the glasses app

```bash
cd ../glasses
npm install
cp .env.example .env.local
```

In `.env.local`, set `VITE_GATEWAY_URL` to the gateway origin (`https://gateway.example.com`) and `VITE_GATEWAY_TOKEN` to the same token as the gateway.

In `app.json`, change `package_id` to an identifier of your own, for example `com.yourname.messenger`.

```bash
npm run pack
```

The command writes the gateway origin into the network whitelist of the manifest, builds the app and produces `messenger-<version>.ehpk`. The Even app only lets the WebView call origins on that whitelist.

### 5. Install it on the glasses

```bash
npx evenhub login
```

```bash
npx evenhub create messenger-0.6.0.ehpk --name "Messenger" --tagline "Messages from your own server"
```

```bash
npx evenhub promote 0.6.0 --to beta
```

```bash
npx evenhub testers add you@example.com
```

Use the email of your Even account. Accept the tester invitation, then install Messenger from the beta section of Even Hub in the Even app. For later versions, replace `create` with `npx evenhub upload messenger-<version>.ehpk` and promote again.

### 6. Optional: voice replies

Run a speech-to-text server on your home network. [contrib/stt-server](contrib/stt-server/stt_server.py) is a small example built on faster-whisper:

```bash
pip install fastapi uvicorn python-multipart faster-whisper
```

```bash
WHISPER_MODEL=large-v3 uvicorn stt_server:app --host 0.0.0.0 --port 8770
```

Then set `GATEWAY_STT_URL=http://<server address>:8770/stt` in `deploy/.env`, set `GATEWAY_STT_LANGS` to the languages you speak, and run `docker compose up -d` again. Any server that accepts a WAV file in a multipart field named `audio` and answers `{"text": "...", "lang": "..."}` works.

## Using it

| Where | Gesture | Effect |
| --- | --- | --- |
| A box | Scroll | Moves the selection |
| A box | Click | Opens the selected chat or box |
| Unread box | Double click | Asks to exit the app |
| Other boxes | Double click | Back to the Unread box |
| A chat | Scroll | Older (up) or newer (down) page |
| A chat | Click | Reloads the chat |
| A chat | Double click | Back to the box |
| A chat | Hold | Records a reply; release to stop |
| Transcript | Click | Sends the reply |
| Transcript | Double click | Cancels the reply |

Opening a chat on the glasses removes it from the Unread box. This is local to the gateway: no read receipt is sent, and the phone still shows the chat as unread. Reading or answering on the phone clears it too.

Text on the glasses is plain ASCII, because the firmware font drops the characters it lacks: accents are removed and emoji become `[emoji]`. The reply you dictate is sent with its accents.

## Configuration

Gateway, in `deploy/.env`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `GATEWAY_TOKEN` | none, required | Bearer token for every API call. `/health` and the empty `/admin` page stay open. |
| `GATEWAY_PUBLISH` | `127.0.0.1:8080` | Address where Docker publishes the port |
| `GATEWAY_CORS_ORIGINS` | `*` | Allowed origins, comma separated |
| `GATEWAY_WHATSAPP` | `on` | `off` disables the WhatsApp connection |
| `GATEWAY_STT_URL` | empty | Speech-to-text endpoint; empty disables dictation |
| `GATEWAY_STT_LANGS` | `ro,en` | Languages you dictate in; the first is the fallback |
| `TZ` | `Europe/Bucharest` | Time zone of the clock next to messages |

The WhatsApp session (`whatsapp.db`) and your messages (`messages.db`) live in the Docker volume `gateway-data`. Treat both as secrets, and back them up.

## Development

```bash
cd gateway && go test ./...
```

```bash
cd glasses && npm install && npm test && npx tsc --noEmit
```

To try the app without glasses, run the gateway locally and open the simulator:

```bash
GATEWAY_ADDR=127.0.0.1:8080 GATEWAY_DATA_DIR=./data GATEWAY_WHATSAPP=off go run ./cmd/gateway
```

```bash
VITE_GATEWAY_URL=http://127.0.0.1:8080 npm run dev
```

```bash
npm run simulate
```

Both parts are written test first. [docs/platform-notes.md](docs/platform-notes.md) lists what the Even Hub documentation says and what real glasses did differently.

## Known limits

- One WhatsApp account, text messages only. Media shows as a label such as `[Photo]` or `[Voice message 0:12]`.
- A chat shows its newest 30 messages.
- No read receipts and no quick replies yet.
- The gateway does not alert you when the phone unlinks the session.
- The Even app does not update a beta build by itself; install each new version from Even Hub.
- Tested on iOS only.

## License

[Apache License 2.0](LICENSE). Dependencies keep their own licenses; see [NOTICE](NOTICE). whatsmeow is under the Mozilla Public License 2.0.

Contributions are welcome: open an issue or a pull request.
