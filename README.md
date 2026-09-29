# TUS Companion — Cloud v14

PWA indipendente per gli orari TUS Athlone. Gli studenti scelgono Department e Student Group una volta; non inseriscono credenziali TUS/Microsoft nell'app.

## Architettura v14

La v14 non richiede Oracle, VPS, DuckDNS, dominio personale o un PC acceso 24/7.

```text
TUS / Microsoft
      ↓
GitHub Actions (collector Playwright, circa ogni 5 min)
      ↓
Cloudflare Worker + D1
      ↓
https://tus-companion.<account>.workers.dev
      ↓
PWA degli studenti
```

- **Cloudflare Worker** pubblica frontend/API in HTTPS su `workers.dev`.
- **Cloudflare D1** conserva catalogo, ultimo timetable, modifiche, stato sync e sottoscrizioni push; alla prima creazione lo script richiede la giurisdizione `eu` per mantenere il database nell’Unione Europea.
- **GitHub Actions** esegue il collector Playwright su un runner Linux temporaneo. Il collector interroga i gruppi attivi in sequenza perché Scientia conserva la selezione del timetable nella sessione server-side.
- La sessione TUS centrale viene salvata in D1 **solo cifrata AES-GCM**. La chiave di cifratura è un GitHub Actions Secret e non viene salvata nel database Cloudflare.
- Il repository GitHub viene creato **pubblico** per usare i runner standard pubblici senza il normale monte-minuti dei repository privati. I segreti non vengono committati.

## Mettila online: un comando

Dalla cartella del progetto:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\GO-LIVE.ps1
```

`GO-LIVE.ps1`:

1. verifica/installa Git, GitHub CLI e Node.js LTS tramite `winget` se mancanti;
2. usa la sessione TUS centrale già presente (oppure apre il normale login TUS/Microsoft se manca);
3. apre il login Cloudflare nel browser quando necessario;
4. crea D1, applica lo schema e distribuisce Worker + PWA su `workers.dev`;
5. genera e conserva in locale le chiavi tecniche necessarie senza stamparle;
6. cifra e carica la sessione TUS centrale;
7. apre il login GitHub nel browser quando necessario;
8. crea un repository pubblico, configura gli Actions Secrets e avvia il primo aggiornamento del catalogo;
9. stampa il link pubblico finale, `/health`, repository e pagina Actions.

Non incollare in chat token, cookie, chiavi private, `.cloud.local.json` o file della sessione TUS.

## Dopo il deploy

Il PC personale può essere spento. Il sito e D1 restano su Cloudflare e il collector viene avviato da GitHub Actions. La pianificazione mira a circa cinque minuti, ma GitHub può ritardare una esecuzione programmata: non è un timer real-time.

Quando un gruppo viene selezionato per la prima volta, il primo snapshot può quindi richiedere alcuni minuti. Le notifiche push successive vengono inviate dal collector quando rileva una modifica.

## Se la sessione TUS scade

Sul PC amministratore esegui:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\RECONNECT-AND-PUBLISH.ps1
```

Completa solo il normale login Microsoft/MFA nella finestra che si apre. Lo script cifra il nuovo `storage_state` e lo pubblica nel cloud. Non serve ridistribuire l'app.

## Segreti che non devono finire su GitHub

`.gitignore` esclude almeno:

```text
.cloud.local.json
backend/.tus-session/
backend/.tus-browser-profile/
backend/data/
backend/secrets/
backend/fixtures/
backend/.venv/
config.ps1
cloud/worker/.wrangler/
cloud/worker/.dev.vars
cloud/worker/.env
```

`GO-LIVE.ps1` fa inoltre un controllo dei file staged prima del primo commit e si ferma se trova un percorso sensibile.

## Modalità locale

La vecchia modalità FastAPI locale resta disponibile per sviluppo/test:

```powershell
.\run.ps1
```

Apre `http://127.0.0.1:8000`. Non è necessaria per mantenere online la v14 Cloud.

## Test

Backend:

```powershell
cd backend
.\.venv\Scripts\python.exe -m pytest -q
```

Controllo cloud pubblico dopo il deploy:

```text
https://<tuo-worker>.workers.dev/health
```

## Note operative

- Il collector usa una sola sessione TUS centrale e sincronizza per **Student Group**, non per studente.
- Vengono interrogati solo i gruppi con interesse recente o con notifiche push attive.
- D1 conserva un solo snapshot corrente per gruppo e non riscrive l'intero timetable quando il payload non cambia.
- Il catalogo TUS viene aggiornato periodicamente.
- Un piccolo workflow mensile crea attività nel repository per evitare la disattivazione automatica degli scheduled workflow pubblici dopo lunghi periodi senza attività.

## Stato legale

TUS Companion è un progetto indipendente e non ufficiale, non affiliato, approvato, sponsorizzato o autorizzato da TUS. Il sistema ufficiale TUS resta la fonte autorevole. La presenza di un disclaimer non sostituisce la verifica dei termini applicabili prima di una distribuzione pubblica ampia.
