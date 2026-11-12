# Platforma Even Hub: ce se știe

Citit pe 12 noiembrie 2026 din [documentația Even Hub](https://hub.evenrealities.com/docs/get-started/overview), din pachetul `@evenrealities/even_hub_sdk` 0.0.16 și din simulatorul 0.9.5. Ce nu e marcat altfel vine din documentație și nu a fost încă probat pe ochelari.

## Rețea

- Fiecare apel trece prin două filtre independente: whitelist-ul din `app.json`, aplicat de aplicația Even, și CORS, aplicat de WebView. Whitelist-ul nu ocolește CORS. ([Networking](https://hub.evenrealities.com/docs/build/networking))
- Whitelist-ul cere originea completă, de exemplu `https://api.example.com`. Wildcard-urile și numele de host fără schemă nu sunt acceptate.
- `http://` este documentat doar pentru dezvoltare în LAN. O adresă IP locală cu `ws://` în whitelist a funcționat într-un proiect anterior pe aceiași ochelari, conform notelor de atunci; neprobat aici.
- Serverul trebuie să răspundă la preflight (`OPTIONS`) cu `Access-Control-Allow-Methods` și `Access-Control-Allow-Headers` pentru apelurile cu `Authorization`. Gateway-ul face asta.
- WebSocket-urile urmează aceleași reguli de whitelist.

## Fundal și telefon blocat

([Background & Lifecycle](https://hub.evenrealities.com/docs/build/background-lifecycle))

| | iOS (WKWebView) | Android (Chromium WebView) |
| --- | --- | --- |
| Aplicația Even trece în fundal | WebView-ul continuă să ruleze; starea din memorie rămâne | Poate fi suspendat la presiune de memorie; starea din memorie se pierde |
| WebSocket deschis | De obicei rămâne | De obicei cade |
| `localStorage` | Rămâne | Rămâne |
| Captură audio | Se oprește dacă WebView-ul e suspendat | Se oprește dacă WebView-ul e suspendat |

- Secțiunea de întrebări frecvente spune că apelurile de rețea pornite în fundal se blochează până la revenire. Aplicația reîncarcă datele la `FOREGROUND_ENTER_EVENT`.
- Aplicațiile nu primesc notificări push și rulează doar în prim-plan pe ochelari.
- Sideload-ul prin QR nu supraviețuiește blocării telefonului. Comportamentul real se testează doar cu un build beta.
- SDK-ul înlocuiește `setTimeout` și `setInterval` cu o variantă proprie („ShadowTimers”), vizibilă în consola simulatorului.

## Afișaj

([Display & UI System](https://hub.evenrealities.com/docs/build/display))

- Ecran de 576×288 pixeli pe ochi, 16 niveluri de verde.
- Cel mult 4 containere de imagine și 8 de alt tip pe pagină. Exact unul are `isEventCapture: 1`.
- Limite de text: 1000 de caractere la `createStartUpPageContainer` și `rebuildPageContainer`, 2000 la `textContainerUpgrade`. Un container pe tot ecranul arată circa 400–500 de caractere; restul se derulează dacă acel container captează evenimentele.
- Liste: cel mult 20 de elemente, 64 de caractere fiecare, fără actualizare pe loc.
- Un singur font, fără dimensiuni, fără aliniere. Caracterele care lipsesc din font sunt eliminate fără eroare. Prezența diacriticelor românești se verifică în etapa 0.
- `textContainerUpgrade` actualizează fără pâlpâire; `rebuildPageContainer` redesenează tot și șterge meniul dacă `menuObject` lipsește.
- Pe pagina principală ieșirea se face cu `shutDownPageContainer(1)`, care arată dialogul de sistem.

## Intrare și sunet

([Device APIs](https://hub.evenrealities.com/docs/build/device-apis))

- Gesturi: clic (0), derulare sus (1), derulare jos (2), dublu clic (3), apăsare lungă (9) și eliberare (10). Intrarea și ieșirea din prim-plan sunt 4 și 5.
- Documentația spune că gesturile ajung ca `textEvent` sau `listEvent`. **Observat în simulatorul 0.9.5:** clicul și dublul clic pe un container de text ajung ca `sysEvent`, cu `eventSource` setat; la clic `eventType` lipsește, pentru că valoarea 0 este eliminată. Aplicația tratează ambele forme.
- O atingere urmată de apăsare lungă deschide meniul sistemului, deci apăsarea lungă nu ajunge întotdeauna la aplicație.
- Sunet: PCM 16 kHz, 16 biți cu semn, little-endian, mono. Simulatorul trimite 100 ms pe eveniment (3200 de octeți). `audioControl(true, AudioInputSource.Glasses)` cere ca pagina de start să existe.

## Manifest și împachetare

([Packaging & Deployment](https://hub.evenrealities.com/docs/ship/packaging))

- `package_id` în format domeniu inversat, doar litere mici și cifre. `name` de cel mult 20 de caractere. `supported_languages` acceptă doar `en, de, fr, es, it, zh, ja, ko`; româna nu este în listă.
- `min_app_version` se deduce la împachetare din versiunea SDK-ului (`--sdk-ver`). SDK 0.0.16 cere aplicația Even 2.2.10.
- Secretele puse în pachet pot fi extrase de oricine are fișierul `.ehpk`.
- Un pachet are un singur slot beta și o singură listă de testeri. Build-urile beta apar în meniul ochelarilor doar pentru testerii activi.

## Simulator

([Simulator](https://hub.evenrealities.com/docs/test/simulator))

- `evenhub-simulator <url> --automation-port 9898` pornește și un API HTTP: `GET /api/screenshot/glasses`, `GET /api/console`, `POST /api/input` cu `up`, `down`, `click`, `double_click`, `long_press`, `long_press_release`, `context_menu`.
- Simulatorul nu reproduce whitelist-ul, permisiunile, Bluetooth-ul sau ciclul de viață din fundal.

## Licențe

- `whatsmeow` este sub MPL-2.0 (verificat în repo-ul `tulir/whatsmeow`). MPL-2.0 permite folosirea într-un proiect Apache-2.0; modificările aduse fișierelor bibliotecii rămân sub MPL.
- SDK-ul și simulatorul Even Hub sunt sub MIT.
