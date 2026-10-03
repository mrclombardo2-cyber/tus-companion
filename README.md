# TUS Companion — v16

PWA indipendente per gli orari TUS Athlone. Lo studente sceglie Department e Student Group una volta; l'app non richiede credenziali TUS/Microsoft.

## Architettura attuale

```text
TUS / Scientia
      ↓
Cloudflare Worker scheduled task
      ↓
Cloudflare Queue (sync timetable) + Browser (recupero sessione)
      ↓
Cloudflare D1
      ↓
Worker API + PWA
```

- Il Worker serve frontend e API HTTPS.
- D1 conserva catalogo, snapshot, modifiche, stato sync e sottoscrizioni push.
- Le sincronizzazioni dei gruppi attivi sono idonee circa ogni **2 minuti**.
- I reminder ordinari vengono valutati direttamente dal cron; la Queue resta per sync e continuation jobs necessari.
- Non viene più pre-caricato continuamente il catalogo dei gruppi non usati.
- GitHub Actions esegue test automatici, deploy e verifica live.

## Funzioni v16

- Today e Week responsive;
- push per cambi di aula/orario/classe;
- reminder 15/30/60 minuti;
- timetable offline con ultimo snapshot salvato sul dispositivo;
- ricerca testuale del corso/gruppo;
- feed calendario ICS per Apple Calendar, Outlook e Google Calendar tramite URL;
- campus map Mappedin;
- rate limiting best-effort sugli endpoint pubblici mutanti;
- test Playwright desktop/mobile/offline prima del deploy.

## Test

La pipeline esegue:
```bash
node --test tests/calendar.test.mjs
npx playwright test
```

I test verificano overflow, etichette orarie, vista Week mobile, ricerca corso, modalità offline e feed calendario. Il deploy parte solo dopo il superamento dei test.

## Offline

L'ultimo snapshot valido viene salvato nel browser. Se rete o API non sono raggiungibili, l'app mostra il timetable salvato e segnala chiaramente la modalità offline/cached. Al ritorno della connessione tenta un refresh automatico.

## Calendario

Ogni gruppo sincronizzato espone:
```text
/api/calendar/<group-id>.ics
```
Il feed restituisce le settimane disponibili nello snapshot cloud corrente.

## Operatività

Il PC personale può restare spento. Stato pubblico:
```text
https://tus-companion.tusathlone.workers.dev/health
```

Per una nuova autenticazione TUS interattiva:
```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\RECONNECT-AND-PUBLISH.ps1
```

Non committare token, cookie, chiavi private, `.cloud.local.json`, file di sessione o `.dev.vars`.

## Stato legale

TUS Companion è indipendente e non ufficiale, non affiliato, approvato, sponsorizzato o autorizzato da TUS. Il sistema ufficiale TUS resta la fonte autorevole.
