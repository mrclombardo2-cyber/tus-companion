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

## Ripristino TUS quando hai soltanto GitHub

Su un PC Windows, scarica e avvia [RECOVER-TUS-PORTABLE.cmd](https://github.com/mrclombardo2-cyber/tus-companion/raw/refs/heads/main/RECOVER-TUS-PORTABLE.cmd). Non occorrono una cartella locale preesistente, `.cloud.local.json` o conoscere le credenziali Cloudflare.

Il file scarica automaticamente la versione aggiornata del progetto, installa GitHub CLI/Python/Chromium quando necessario, e riutilizza il login locale TUS finché è valido. Al primo utilizzo richiede di autorizzare GitHub nel browser; quando Microsoft richiede login o MFA bisogna completare quella schermata ufficiale. Il programma verifica la sessione e carica lo stato del browser come **GitHub Actions Secret cifrato**, avvia il workflow `recover-tus-from-browser.yml` che lo cifra per Cloudflare e controlla una nuova sincronizzazione del catalogo. Al termine elimina il secret temporaneo da GitHub. Se il programma viene terminato prima, eliminare `TUS_RECOVERY_STATE_B64` da **Settings → Secrets and variables → Actions**.

**Non** incollare password o sessioni nei workflow input, commit, issue, messaggi, log o link. Se la password universitaria è stata condivisa in chat, va cambiata. Nessun sistema può aggirare una richiesta Microsoft di verifica interattiva. L'app, il cron Cloudflare e il controllo dello stato continuano a funzionare da remoto quando il PC è spento, nei limiti delle sessioni rilasciate dal fornitore.

## Freshness e monitoraggio automatico (v16.6.2)

- L'ultima ora visualizzata come `Updated` è l'**ultima sincronizzazione riuscita**, non l'ora corrente.
- Se il dato risale a più di **6 minuti** o la sorgente segnala un errore, la PWA visualizza soltanto `Not updated` in alto a destra: nessun banner invasivo o pulsante di ripetizione. Il vecchio orario resta consultabile ma non è presentato come aggiornato.
- La pipeline `.github/workflows/tus-health-monitor.yml` verifica ogni **15 minuti circa** il cron Cloudflare, la sessione TUS e i gruppi attivi. In caso di anomalia persistente apre/riapre una issue GitHub e la chiude solo a recupero avvenuto.
- La disponibilità delle esecuzioni pianificate GitHub non è un SLA: il cron Cloudflare è il principale meccanismo di sincronizzazione.
- Quando TUS/Microsoft richiede accesso interattivo o MFA, non è possibile automatizzare il superamento del controllo: su un PC Windows autorizzato avviare `RECOVER-TUS-NOW.cmd`, completare il normale login e verificare `/health` e l'ora di ultima sincronizzazione. Non cancellare i dati locali come rimedio alla scadenza della sessione sorgente.

## Stato legale

TUS Companion è indipendente e non ufficiale, non affiliato, approvato, sponsorizzato o autorizzato da TUS. Il sistema ufficiale TUS resta la fonte autorevole.
