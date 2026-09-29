# Copy this file to config.ps1 before a public deployment. config.ps1 is git-ignored.
$env:TUS_OPERATOR_NAME = "Your name or organisation"
$env:TUS_CONTACT_EMAIL = "you@example.com"
$env:VAPID_SUBJECT = "mailto:you@example.com"
# Generate a long random token and keep it private if you use admin endpoints.
$env:TUS_ADMIN_TOKEN = "replace-with-a-long-random-secret"

# Optional: token for a stable Cloudflare Tunnel. Leave empty for a temporary Quick Tunnel.
$env:CLOUDFLARE_TUNNEL_TOKEN = ""

# Production freshness. 300 = every 5 minutes, 24/7.
$env:TUS_SYNC_INTERVAL_SECONDS = "300"
# Concurrent Web Push deliveries; 16 is conservative for a small VPS/PC.
$env:TUS_PUSH_WORKERS = "16"
