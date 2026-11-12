# even-app-messenger

Aplicație personală pentru ochelarii Even Realities G2: citești conversațiile WhatsApp și emailurile pe ochelari și răspunzi prin voce. Totul rulează pe serverul tău de acasă; niciun terț nu vede mesajele.

Stare: **etapa 0 (schelet și verificări)**. Gateway-ul răspunde la `/health` și `/hello`, iar aplicația de ochelari afișează textul primit de la el. WhatsApp și emailul vin în etapele următoare.

## Componente

| Director | Ce conține | Tehnologie |
| --- | --- | --- |
| `gateway/` | Serviciul de pe serverul de acasă: API HTTP cu token și CORS | Go |
| `glasses/` | Aplicația web care rulează în WebView-ul aplicației Even | TypeScript, Vite |
| `deploy/` | `docker compose` și pașii de instalare în spatele nginx | Docker |
| `docs/` | Ce se știe despre platforma Even Hub, verificările etapei 0 | |

Telefonul ajunge la gateway doar prin VPN. Gateway-ul nu este expus pe internet.

## Dezvoltare locală

Cerințe: Go 1.27, Node.js 22.

Gateway:

```bash
cd gateway
go test ./...
GATEWAY_ADDR=127.0.0.1:8080 GATEWAY_TOKEN=dev-token go run ./cmd/gateway
```

Aplicația de ochelari, în simulator:

```bash
cd glasses
npm install
cp .env.example .env.local   # pune VITE_GATEWAY_URL=http://localhost:8080 și VITE_GATEWAY_TOKEN=dev-token
npm test
npm run dev
npm run simulate             # în alt terminal
```

În simulator: clic reîncarcă textul, dublu clic cere ieșirea. Interfața aplicației este în engleză.

## Pe ochelarii reali

1. Instalează gateway-ul pe homelab: [deploy/README.md](deploy/README.md).
2. Urmează verificările din [docs/etapa-0.md](docs/etapa-0.md).

## Pachetul `.ehpk`

```bash
cd glasses
npm run pack
```

Comanda citește `VITE_GATEWAY_URL` din `.env.local`, scrie originea gateway-ului în whitelist-ul de rețea al manifestului, construiește aplicația și produce `messenger-<versiune>.ehpk`. Whitelist-ul Even Hub acceptă doar origini exacte, de aceea pachetul este legat de un singur gateway.

Dacă `VITE_GATEWAY_TOKEN` este setat, tokenul ajunge în pachet. Păstrează pachetul și canalul beta private.

## Etape

| Etapă | Conținut | Stare |
| --- | --- | --- |
| 0 | Schelet, whitelist, CORS, comportament în fundal | Cod scris; verificarea pe ochelari în curs |
| 1 | WhatsApp, doar citire | |
| 2 | Răspunsuri rapide | |
| 3 | Răspuns prin voce | |
| 4 | Email (Gmail, IMAP și SMTP) | |
| 5 | Stabilitate și instalare din canalul beta | |

## Avertisment

WhatsApp interzice prin termeni clienții neoficiali. Riscul de suspendare rămâne pe contul celui care folosește aplicația.
