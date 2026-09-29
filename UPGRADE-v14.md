# Upgrade v13 / v13.1 → v14 Cloud

La v14 sostituisce il piano Oracle/DuckDNS con Cloudflare Workers + D1 + GitHub Actions.

## Applicazione patch

1. Ferma `run.ps1` con `Ctrl+C` se è aperto.
2. Estrai la patch v14 sopra la cartella esistente e scegli **Sostituisci tutti**.
3. Non cancellare `backend\data`, `backend\.tus-session`, `backend\.tus-browser-profile`, `backend\.venv`, `backend\secrets` o `config.ps1`.
4. Dalla root esegui:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\GO-LIVE.ps1
```

Il deploy è ri-eseguibile: se un passaggio viene interrotto, rilancia `GO-LIVE.ps1` e verranno riutilizzate le risorse già create quando possibile.

## Manutenzione successiva

Se la sorgente TUS richiede nuovamente autenticazione:

```powershell
.\RECONNECT-AND-PUBLISH.ps1
```

Non condividere `.cloud.local.json`, la sessione TUS, cookie, token GitHub/Cloudflare o chiavi private.
