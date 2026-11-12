# Instalarea gateway-ului pe homelab

Gateway-ul rulează în Docker, în spatele nginx-ului existent. Nu se expune pe internet: telefonul ajunge la el doar prin VPN.

## 1. Pornește containerul

```bash
git clone https://github.com/antonioeram/even-app-messenger.git
cd even-app-messenger/deploy
cp .env.example .env
```

Completează `GATEWAY_TOKEN` în `.env` cu rezultatul comenzii `openssl rand -hex 32`, apoi:

```bash
docker compose up -d --build
docker compose ps
curl -s http://127.0.0.1:8080/health
```

Starea trebuie să fie `healthy`, iar `curl` să răspundă `{"status":"ok","version":"dev"}`.

Dacă nginx rulează pe altă mașină decât Docker, pune în `.env` `GATEWAY_PUBLISH=<adresa LAN a mașinii Docker>:8080`.

## 2. DNS și certificat

1. În Cloudflare, creează un token API cu un singur drept: `Zone → DNS → Edit`, limitat la zona domeniului.
2. Adaugă o înregistrare `A` pentru subdomeniu, către adresa internă a mașinii cu nginx. Proxy-ul Cloudflare oprit („DNS only”).
3. Cere certificatul Let's Encrypt prin validare DNS. Nu se deschide niciun port.

Nginx Proxy Manager: `SSL Certificates → Add → Let's Encrypt`, bifează `Use a DNS Challenge`, alege Cloudflare și lipește tokenul.

Nginx simplu:

```bash
sudo certbot certonly --dns-cloudflare \
  --dns-cloudflare-credentials /root/.secrets/cloudflare.ini \
  -d gateway.example.com
```

Fișierul `cloudflare.ini` conține linia `dns_cloudflare_api_token = <token>` și are permisiuni `600`.

## 3. Host în nginx

Nginx Proxy Manager: `Proxy Hosts → Add`, domeniul subdomeniului, `Forward` către `http://<adresa gateway>:8080`, certificatul de la pasul 2, `Force SSL` activ.

Nginx simplu:

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name gateway.example.com;

    ssl_certificate     /etc/letsencrypt/live/gateway.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/gateway.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Nu adăuga headere CORS în nginx. Gateway-ul le trimite deja, iar headerele dublate fac WebView-ul să respingă răspunsul.

## 4. Verifică de pe un dispozitiv conectat prin VPN

```bash
curl -i https://gateway.example.com/health
```

```bash
curl -i -X OPTIONS https://gateway.example.com/hello \
  -H 'Origin: https://test.invalid' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: authorization'
```

```bash
curl -s https://gateway.example.com/hello -H "Authorization: Bearer $GATEWAY_TOKEN"
```

Răspunsuri așteptate: `200` cu `Access-Control-Allow-Origin: *`; `204` cu `Access-Control-Allow-Headers: Authorization, Content-Type`; un JSON cu câmpul `text`.

## Varianta cu Nginx Proxy Manager în Docker

Când NPM rulează în Docker pe aceeași mașină, gateway-ul se atașează la rețeaua lui și nu mai are nevoie de un port în LAN. În `deploy/.env`:

```
COMPOSE_FILE=docker-compose.yml:docker-compose.npm.yml
GATEWAY_PUBLISH=127.0.0.1:8791
```

În NPM, proxy host-ul trimite către `http://even-messenger-gateway:8080`.

Dacă subdomeniul este public (înregistrare Cloudflare către adresa de acasă) și certificatul se cere prin validare HTTP, accesul din exterior trebuie refuzat în nginx pentru tot, mai puțin calea `/.well-known/acme-challenge/`. Telefonul ajunge la gateway printr-o rescriere DNS internă a subdomeniului către adresa mașinii cu NPM, deci traficul nu trece prin Cloudflare.

## Configurare

| Variabilă | Implicit | Rol |
| --- | --- | --- |
| `GATEWAY_TOKEN` | fără | Tokenul cerut pe apelurile API. `/health` rămâne deschis. |
| `GATEWAY_PUBLISH` | `127.0.0.1:8080` | Adresa pe care Docker publică portul. |
| `GATEWAY_CORS_ORIGINS` | `*` | Origini permise, separate prin virgulă. |
| `TZ` | `Europe/Bucharest` | Fusul orar al orelor afișate. |

Jurnalul gateway-ului (`docker compose logs -f gateway`) arată pentru fiecare apel metoda, calea, codul și originea trimisă de WebView.
