# Etapa 0: verificări pe ochelarii reali

Etapa 0 este gata când pe ochelari apare un text venit de la gateway-ul de acasă, prin HTTPS. Pe drum se lămuresc necunoscutele de mai jos.

Verificat deja în simulator (12 noiembrie 2026): pornirea, textul de la gateway cu preflight CORS și token, clic pentru reîncărcare, ecranul de eroare când gateway-ul e oprit, revenirea, dublu clic pentru ieșire, împachetarea `.ehpk`.

## Pregătire

1. Gateway-ul rulează pe homelab și răspunde prin HTTPS: [deploy/README.md](../deploy/README.md).
2. În `glasses/.env.local`:

   ```
   VITE_GATEWAY_URL=https://<subdomeniul tău>
   VITE_GATEWAY_TOKEN=<valoarea GATEWAY_TOKEN>
   ```

3. Telefonul este conectat la VPN, aplicația Even este la versiunea 2.2.10 sau mai nouă.

## Varianta A: sideload prin cod QR (rapid)

```bash
cd glasses
npm install
npm run dev
```

În alt terminal, cu adresa LAN a Mac-ului:

```bash
npx evenhub qr --url "http://<adresa LAN a Mac-ului>:5173"
```

Scanezi codul din tabul Even Hub al aplicației Even (secțiunea pentru dezvoltatori, `Scan QR`).

Dacă scanarea nu deschide nimic: firewall-ul macOS blochează Node. `System Settings → Network → Firewall → Options`, adaugă binarul `node` cu `Allow incoming connections`.

Varianta A nu validează whitelist-ul și nu supraviețuiește blocării telefonului. Pentru acestea este nevoie de varianta B.

## Varianta B: build privat pe canalul beta

```bash
cd glasses
npm run pack
npx evenhub login
npx evenhub create messenger-0.0.1.ehpk --name "Messenger" --tagline "Mesaje de pe serverul tau"
npx evenhub promote 0.0.1 --to beta
npx evenhub testers add <emailul contului tău Even>
```

Instalezi din secțiunea Beta a aplicației Even. La o versiune nouă: crești `version` în `glasses/package.json`, apoi `npm run pack` și `npx evenhub upload messenger-<versiune>.ehpk -m "<ce s-a schimbat>"`, urmat de `promote`.

## Ce verifici și ce îmi raportezi

Pagina aplicației de pe telefon arată un jurnal; cele mai noi rânduri sunt sus. Jurnalul gateway-ului se vede cu `docker compose logs -f gateway`.

| # | Verificare | Cum | Ce raportezi |
| --- | --- | --- | --- |
| 1 | Textul ajunge pe ochelari | Deschizi aplicația | Apare „Salut de la gateway!” cu ora serverului, sau textul erorii |
| 2 | Diacritice | Rândul „Diacritice: ăâîșț ĂÂÎȘȚ” | Ce litere lipsesc sau apar greșit |
| 3 | Whitelist (varianta B) | Aplicația instalată din beta | Dacă textul apare; dacă nu, rândul de eroare din jurnal |
| 4 | Originea WebView-ului | Jurnalul gateway-ului, câmpul `origin` | Valoarea exactă, pentru variantele A și B |
| 5 | Gesturi | Clic, dublu clic, derulare, apăsare lungă | Rândurile `gest: …` sau `eveniment necunoscut: …` din jurnal |
| 6 | Ieșire | Dublu clic | Apare dialogul de sistem pentru ieșire |
| 7 | Telefon blocat (varianta B) | Blochezi telefonul 5 minute, apoi deschizi aplicația Even | Rândurile noi din jurnal: `JavaScript oprit N s`, `pornire la rece…`, `gest: foregroundEnter`; dacă textul se reîncarcă singur |
| 8 | Fără VPN | Oprești VPN-ul, clic | Textul erorii de pe ochelari |

## Întrebări lămurite din documentație

Vezi [platforma-even-hub.md](platforma-even-hub.md).
