# Zero-cost cloud deployment (Oracle Always Free + DuckDNS + Caddy)

This deployment is designed so TUS Companion does **not** depend on your PC being switched on.

## What remains free

- Oracle Cloud Always Free Ampere A1 VM (within Oracle's Always Free allowance)
- DuckDNS subdomain
- Caddy HTTPS certificate / reverse proxy
- TUS Companion itself

No custom domain is required. A public URL can be `https://yourname.duckdns.org`.

## Important limitation of "free"

Oracle documents that idle Always Free compute instances can be reclaimed. Free cloud products also do not carry a paid production SLA. This deployment is suitable for a zero-cost launch, but no third-party provider can promise permanent free hosting with paid-service uptime guarantees.

## Recommended VM

Create one OCI **VM.Standard.A1.Flex** instance, Ubuntu 24.04 ARM64, using 2 OCPUs and 4 GB RAM (well within the Always Free A1 allowance). Do not select a paid shape.

In the OCI VCN Security List / Network Security Group allow inbound:

- TCP 22 from your IP (SSH)
- TCP 80 from 0.0.0.0/0
- TCP 443 from 0.0.0.0/0

## 1. Get a free hostname

Create a DuckDNS subdomain and copy its token. Example: `tusathlone.duckdns.org`.

## 2. Upload this project to the VM

From Windows PowerShell (replace paths/IP/key):

```powershell
scp -i C:\path\oci.key .\tus-companion-central-v13.zip ubuntu@YOUR_VM_IP:/home/ubuntu/
```

SSH to the VM:

```powershell
ssh -i C:\path\oci.key ubuntu@YOUR_VM_IP
```

On Ubuntu:

```bash
sudo apt-get update && sudo apt-get install -y unzip
unzip tus-companion-central-v13.zip
cd tus-companion-central-v13
sudo bash deploy/oracle-free/install-oracle-free.sh
```

Enter the DuckDNS subdomain/token and legal contact details when prompted.

## 3. Transfer the existing TUS source session

Back on the Windows PC where TUS login currently works, run from the project root:

```powershell
.\deploy\oracle-free\push-session-to-cloud.ps1 -Server YOUR_VM_IP -KeyPath C:\path\oci.key
```

The script uploads only `storage_state.json`, tests `status`, rebuilds the live course catalogue, and starts the cloud service. The state file is an authentication secret: never publish it or commit it.

If cloud `status` reports `login-required`, the Azure/TUS session did not survive the IP/device move. In that case do not paste cookies into chat. Reconnect locally and retry; if TUS enforces device/IP binding, use an interactive cloud login method instead.

## 4. Open the public URL

Once DuckDNS points to the VM and ports 80/443 are open, Caddy automatically obtains HTTPS:

`https://YOURNAME.duckdns.org`

HTTPS is required for normal PWA installation and Web Push outside localhost.

## 5. Operations

```bash
sudo systemctl status tus-companion
sudo journalctl -u tus-companion -f
curl http://127.0.0.1:8000/health
sudo systemctl status caddy
```

The timetable scheduler remains one process and polls active Student Groups every five minutes. Do not configure multiple Uvicorn workers while the scheduler lives inside the web process.

## 6. When the TUS session expires

On your Windows admin PC:

1. run the normal local TUS reconnect/login,
2. rerun `push-session-to-cloud.ps1`.

The public app stays hosted in Oracle throughout; your PC is only used for the occasional administrator authentication step, not for hosting or uptime.
