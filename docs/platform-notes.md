# Even Hub platform notes

What the [Even Hub documentation](https://hub.evenrealities.com/docs/get-started/overview) says, and what we saw. Sources: the documentation, `@evenrealities/even_hub_sdk` 0.0.16, simulator 0.9.5, and G2 glasses with an R1 ring on iOS (Even app 2.2.10+), November 2026. Items marked **Seen on glasses** were observed on real hardware; the rest comes from the documentation.

## Network

- Every call passes two independent filters: the whitelist in `app.json`, applied by the Even app, and CORS, applied by the WebView. The whitelist does not bypass CORS.
- The whitelist takes full origins such as `https://api.example.com`. Wildcards and bare host names are rejected.
- The server must answer the preflight (`OPTIONS`) with `Access-Control-Allow-Methods` and `Access-Control-Allow-Headers` for calls that carry `Authorization`.
- **Seen on glasses:** the WebView origin is `http://127.0.0.1:<port>`, and the port changes on every start of the app. An exact CORS origin list is therefore not practical; the gateway allows `*` and relies on its token.
- **Seen on glasses:** because the origin changes, the page's `localStorage` does not survive a restart of the app. Use `bridge.setLocalStorage` for anything that must persist.
- **Seen on glasses:** a call to a host that is unreachable (VPN off) fails with `Load failed`; the WebView does not say whether the whitelist, CORS or the network was the cause.

## Background and locked phone

| | iOS (WKWebView) | Android (Chromium WebView) |
| --- | --- | --- |
| Even app goes to the background | WebView keeps running; memory state stays | May be suspended under memory pressure |
| Open WebSocket | Usually stays | Usually drops |

- Apps get no push notifications and run only while they are in the foreground on the glasses.
- The app reloads its data on `FOREGROUND_ENTER_EVENT`.
- **Seen on glasses:** with the page hidden for 75 seconds, JavaScript timers kept running on iOS. A locked phone for several minutes was not tested.

## Display

- 576 x 288 pixels per eye, 16 levels of green.
- At most 4 image containers and 8 others per page. Exactly one has `isEventCapture: 1`.
- Text limits: 1000 characters in `createStartUpPageContainer` and `rebuildPageContainer`, 2000 in `textContainerUpgrade`. A full-screen container shows about 400 to 500 characters.
- One font, proportional, no sizes. Characters missing from the font are dropped without an error, so the app shows ASCII only.
- `textContainerUpgrade` updates without flicker.
- **Seen on glasses:** `rebuildPageContainer` with a full-screen list container of 20 items returned success, and the glasses kept showing the previous page. The same page rendered in the simulator. The cause was not isolated (the list container, the size of the page, or the rebuild itself). Since then the app avoids list containers: the lists are text containers created at start-up and changed with `textContainerUpgrade`, which is proven on glasses. Chat pages and notes use `rebuildPageContainer` with text containers only; that path works in the simulator and is not confirmed on glasses yet.
- A text container whose text does not fit its height scrolls internally and swallows swipes: in the simulator, a one-line title strip with padding reported only the first swipe. The container that captures input must fit its text (the title strip here has no padding).
- Image containers are 20 to 288 px wide and 20 to 144 px high, at most 4 per page, and start empty; pixels are sent afterwards with `updateImageRawData`, one image at a time. The simulator accepts the bytes of a PNG file (here drawn on a canvas). On glasses this is not confirmed yet; the app falls back to a layout without images when a page with image containers is refused.
- On the root page, leave with `shutDownPageContainer(1)`, which shows the system exit dialog. **Seen on glasses:** the dialog appears, and the app gets `FOREGROUND_ENTER` and `FOREGROUND_EXIT` events around it.

## Input

- Gestures: click (0), scroll up (1), scroll down (2), double click (3), long press (9) and its release (10). Foreground enter and exit are 4 and 5.
- The documentation routes gestures to the capturing container as `textEvent` or `listEvent`. **Seen in the simulator:** click and double click on a text container arrive as `sysEvent` with `eventSource` set; for a click `eventType` is missing, because the value 0 is dropped on the way. **Seen on glasses:** a click from the ring arrives the same way, as `sysEvent` with `eventSource`. In the simulator a click on a list item arrives as `listEvent`, and index 0 is missing for the same reason.
- `eventSource` tells the right temple (1), the ring (2) and the left temple (3) apart. **Seen on glasses:** the R1 ring works without any setup in the app.
- The selection cursor and the page turning rely on each swipe arriving as a scroll event when the text fits the screen. This works in the simulator; on glasses it is not confirmed yet.
- A tap followed by a long press opens the system menu, so a long press does not always reach the app.
- Audio: PCM, 16 kHz, signed 16 bit, little endian, mono. The simulator sends 100 ms per event (3200 bytes). `audioControl(true, AudioInputSource.Glasses)` needs the start-up page to exist.

## Manifest and packaging

- `package_id` is reverse-domain, lower case letters and digits. `name` has at most 20 characters. `supported_languages` accepts `en, de, fr, es, it, zh, ja, ko` only.
- `min_app_version` is derived from the SDK version at pack time (`--sdk-ver`). SDK 0.0.16 needs Even app 2.2.10.
- Secrets inside the package can be read by anyone who has the `.ehpk` file.
- A package has one beta slot and one tester list. Flow: `evenhub create` (first build) or `evenhub upload`, then `evenhub promote <version> --to beta`, then `evenhub testers add <email>`. The tester must accept the invitation.
- **Seen on glasses:** the Even app does not replace an installed beta build on its own; the new version has to be installed from Even Hub. Right after an update the app once failed with `bad state: host shutdown not complete`; closing and reopening the Even app fixed it.

## Simulator

- `evenhub-simulator <url> --automation-port 9898` also starts an HTTP API: `GET /api/screenshot/glasses`, `GET /api/console`, `POST /api/input` with `up`, `down`, `click`, `double_click`, `long_press`, `long_press_release`.
- The simulator does not reproduce the whitelist, permissions, Bluetooth or the background life cycle, and it rendered a page that real glasses did not. Test on hardware.

## Licenses

- whatsmeow is under MPL 2.0, which allows use in an Apache 2.0 project; changes to the library's own files stay under MPL.
- The Even Hub SDK and simulator are under MIT.
