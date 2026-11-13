# Deploying the gateway

The gateway runs in Docker behind a reverse proxy that terminates HTTPS. It must not be reachable from the internet: the phone reaches it through a VPN to the home network.

## 1. Start the container

```bash
cp .env.example .env
```

Set `GATEWAY_TOKEN` in `.env` to the output of `openssl rand -hex 32`, then:

```bash
docker compose up -d --build
```

```bash
docker compose ps
```

The state must be `healthy`. If the reverse proxy runs on another machine, set `GATEWAY_PUBLISH=<LAN address of the Docker host>:8080`.

## 2. Certificate without an open port

The Even app WebView needs a valid certificate. With DNS validation, Let's Encrypt only asks for a TXT record, so nothing has to be reachable from outside.

1. At your DNS provider, create an API token that can edit the records of the zone.
2. Add an `A` record for the gateway host name. Point it at the internal address of the proxy, or at your public address if your router sends LAN clients back in (hairpin NAT). Do not put a CDN proxy in front of it.
3. Request the certificate with a DNS plugin, for example Cloudflare:

```bash
sudo certbot certonly --dns-cloudflare \
  --dns-cloudflare-credentials /root/.secrets/cloudflare.ini \
  -d gateway.example.com
```

The credentials file holds `dns_cloudflare_api_token = <token>` and has mode `600`.

In Nginx Proxy Manager: SSL Certificates > Add > Let's Encrypt, tick "Use a DNS Challenge", choose the provider and paste the token.

## 3. Proxy host

Plain nginx:

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name gateway.example.com;

    ssl_certificate     /etc/letsencrypt/live/gateway.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/gateway.example.com/privkey.pem;

    # Home network and VPN only. Adjust the ranges to yours.
    allow 192.168.0.0/16;
    allow 10.0.0.0/8;
    allow 172.16.0.0/12;
    deny all;

    # A voice recording is up to 4 MB.
    client_max_body_size 8m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 90s;
    }
}
```

Nginx Proxy Manager: Proxy Hosts > Add, forward to `http://<gateway address>:8080`, select the certificate, enable "Force SSL", and attach an access list that allows only your LAN and VPN ranges.

The app keeps one call to `/changes` open for up to 25 seconds at a time, to learn about new messages. Keep the proxy read timeout above that; nginx defaults to 60 seconds.

Do not add CORS headers in the proxy. The gateway sends them, and duplicated headers make the WebView reject the answer.

### Nginx Proxy Manager in Docker on the same host

The gateway can join the proxy's Docker network, so no LAN port is needed. In `deploy/.env`:

```
COMPOSE_FILE=docker-compose.yml:docker-compose.npm.yml
GATEWAY_PUBLISH=127.0.0.1:8791
```

The proxy host then forwards to `http://even-messenger-gateway:8080`. Set `NPM_NETWORK` if the proxy's network is not named `nginx-proxy-manager_default`.

## 4. Check from a device on the VPN

```bash
curl -i https://gateway.example.com/health
```

```bash
curl -i -X OPTIONS https://gateway.example.com/chats \
  -H 'Origin: http://127.0.0.1:50000' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: authorization'
```

```bash
curl -s https://gateway.example.com/chats -H "Authorization: Bearer $GATEWAY_TOKEN"
```

Expected: `200`; `204` with `Access-Control-Allow-Headers: Authorization, Content-Type`; a JSON object with a `chats` list.

Then check from mobile data with the VPN off. The request must fail.

## Certificate renewal

A certificate requested with certbot renews through certbot's own timer. If you requested it by hand inside a container that does not track it (Nginx Proxy Manager only renews certificates it created itself), add a scheduled `certbot renew` followed by an nginx reload.

## Logs

```bash
docker compose logs -f gateway
```

Each request is logged with method, path, status and the origin the WebView sent. Message text, recordings, transcripts and the pairing code are never logged.

## Updating

```bash
git pull && docker compose up -d --build
```

The databases are upgraded in place at start.
