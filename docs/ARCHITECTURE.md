# TUS Companion v14 — Architecture

```text
Students / installed PWA
        │ HTTPS
        ▼
Cloudflare Worker + Static Assets
        │
        ├── D1: catalogue, active interests, latest snapshots, changes,
        │       push subscriptions, sync state, encrypted source session
        │
        └── workers.dev public endpoint

GitHub Actions schedule (~5 min, not guaranteed exact)
        │
        ├── decrypts central source session in the ephemeral runner
        ├── Playwright Chromium → authenticated TUS / Scientia
        ├── sequentially fetches active Student Groups
        ├── parses TextSpreadsheet and computes diffs
        ├── updates Worker/D1 through admin-only endpoints
        ├── sends change Web Push notifications
        └── re-encrypts refreshed Playwright storage_state back to D1
```

The AES-GCM source-session key and Worker admin token are GitHub Actions Secrets. D1 contains only the session ciphertext/nonce. No student TUS credentials are collected by the public app.

The local administrator machine is needed only for initial deployment and a normal TUS/Microsoft re-authentication if the central source session expires. It is not in the runtime path after deployment.
