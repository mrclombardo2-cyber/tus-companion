# Put TUS Companion online

## Fastest test link (no domain required)

From the project root:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\share-online.ps1
```

The script starts the local app if needed, downloads the official `cloudflared.exe` client into `tools/` if missing, and opens a Cloudflare Quick Tunnel to `http://127.0.0.1:8000`.

Cloudflare prints an HTTPS address similar to:

```text
https://random-words.trycloudflare.com
```

Share that link to test the PWA on iPhone, Android and other PCs. The PC running the collector must remain powered on and connected. Quick Tunnel URLs are temporary and intended for testing, not the final release.

## Stable public URL

The current architecture keeps the authenticated TUS source session and collector on this Windows machine. The simplest stable deployment therefore keeps the app on this always-on machine and places a named Cloudflare Tunnel in front of it.

1. Create a Cloudflare account and add/choose a domain you control.
2. In Cloudflare Zero Trust / Networking / Tunnels, create a remotely managed tunnel.
3. Configure a public hostname (for example `timetable.example.com`) whose service is `http://localhost:8000`.
4. Copy the tunnel token.
5. Add the token to `config.ps1`:

```powershell
$env:CLOUDFLARE_TUNNEL_TOKEN = "your-private-tunnel-token"
```

6. Run:

```powershell
.\share-online.ps1
```

With a configured token, `share-online.ps1` runs the permanent tunnel rather than a random Quick Tunnel.

Never commit or share the tunnel token, TUS session state, cookies, `config.ps1`, database, or VAPID private key.

## Availability

Because this design deliberately keeps the TUS session on the central collector machine, the public app stops refreshing if that machine is off. For 24/7 production, use an always-on Windows mini-PC/server/VPS where the source session can be securely maintained, then point the same tunnel hostname at it.
