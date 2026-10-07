# Codex + ECC setup for TUS Companion

The repository contains project-specific Codex policy in `AGENTS.md` and `.codex/`. ECC is installed through Codex's native plugin lifecycle; it is not copied into this repository.

## Why this setup

TUS Companion already has production-specific behavior around Cloudflare Workers, D1, queues, source-session recovery, PWA caching/offline behavior and live deployment verification. The project instructions therefore constrain AI-assisted work to small, tested changes rather than generic rewrites.

## Install ECC

ECC release pinned for this setup: **v2.2.3**.

From PowerShell or another terminal with a current Codex CLI:

```bash
codex plugin marketplace add affaan-m/ECC --ref v2.2.3
codex plugin add ecc@ecc
codex plugin list --json
```

Restart Codex after first installation.

Inside Codex:
1. open `/plugins` and confirm ECC is enabled;
2. open `/hooks`, review the ECC hook definition and explicitly trust it if desired;
3. run `$configure-ecc` for ECC's provider-aware verification/configuration flow.

Do not use the deprecated ECC sync script that copies configuration into `~/.codex`; the native plugin path is preferred.

## Project-local behavior

When this repository is opened as a trusted Codex project:
- `AGENTS.md` defines the TUS Companion production invariants and required verification;
- `.codex/config.toml` enables project-local multi-agent roles without pinning a model;
- `explorer` is read-only and traces the current implementation before edits;
- `reviewer` is read-only and checks production regressions/security;
- `docs_researcher` is read-only and verifies changing platform behavior against primary documentation.

The project configuration intentionally does **not** add extra MCP servers. ECC's plugin and Codex native capabilities should be preferred unless a concrete task requires another connector.

## Upgrade ECC deliberately

Do not silently follow `main` for a production project. When upgrading, review the ECC release notes first, then update the pinned ref used for installation.

Example:

```bash
codex plugin marketplace upgrade ecc
codex plugin add ecc@ecc
codex plugin list --json
```

After an ECC upgrade, start a new Codex session and re-review `/hooks` if Codex reports that the hook definition changed.

## Repository setup helper

Windows users can run:

```powershell
.\SETUP-CODEX-ECC.ps1
```

The helper installs/verifies the pinned native ECC plugin. It does not approve hooks, alter secrets, deploy TUS Companion or mutate Cloudflare.
