# Sopralluogo

<p align="center">
  <img src="https://github.com/user-attachments/assets/706ca21e-4842-4242-a09b-d87796d6d8c8" alt="Sopralluogo">
</p>

<p align="center">
  <strong>Trasforma uno o più video dello stesso evento in una scena 3D esplorabile, sincronizzata e misurabile.</strong>
</p>

<p align="center">
  <a href="https://github.com/gabrielevierti/sopralluogo">
    <img src="https://img.shields.io/github/stars/gabrielevierti/sopralluogo?style=for-the-badge" alt="GitHub Stars">
  </a>
  <a href="https://github.com/gabrielevierti/sopralluogo">
    <img src="https://img.shields.io/github/license/gabrielevierti/sopralluogo?style=for-the-badge" alt="License">
  </a>
  <img src="https://img.shields.io/badge/Python-3.10%2B-3776AB?style=for-the-badge&logo=python&logoColor=white" alt="Python">
  <img src="https://img.shields.io/badge/Node.js-18%2B-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/FFmpeg-required-007808?style=for-the-badge&logo=ffmpeg&logoColor=white" alt="FFmpeg">
  <img src="https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-555555?style=for-the-badge" alt="Platforms">
  <img src="https://img.shields.io/badge/Privacy-local--first-111111?style=for-the-badge" alt="Local First">
</p>

---

## Overview

**Sopralluogo** è una pipeline locale di computer vision progettata per trasformare uno o più filmati dello stesso evento in una rappresentazione tridimensionale della scena, collegata temporalmente ai video originali.

Può lavorare con filmati provenienti da telecamere di videosorveglianza, bodycam, smartphone o altre sorgenti video. L'obiettivo non è semplicemente visualizzare un video in 3D, ma ricostruire uno spazio che possa essere esplorato, interrogato e analizzato, mantenendo contemporaneamente il riferimento al materiale originale.

La scena risultante può essere osservata da diverse prospettive, sincronizzata con il video, misurata e utilizzata per analizzare il movimento di persone e veicoli. Quando sono disponibili più telecamere dello stesso evento, Sopralluogo può inoltre tentare di sincronizzarle temporalmente e allinearle all'interno di un'unica rappresentazione spaziale.

L'intera elaborazione è progettata secondo un approccio **local-first**: i filmati rimangono sul computer dell'utilizzatore e, dopo il download iniziale dei modelli e delle dipendenze, la pipeline può essere eseguita anche senza connessione Internet.

> **Nota importante**
>
> Le ricostruzioni e le misure prodotte da Sopralluogo sono stime ottenute attraverso immagini, modelli di computer vision e procedure di calibrazione. Non devono essere considerate automaticamente come misure forensi o probatorie. Prima di utilizzare un risultato in un contesto ufficiale, è necessario verificarlo mediante almeno una misura reale effettuata sul posto.
>
> La metodologia, le assunzioni e i limiti del sistema sono descritti in [`docs/METODO.md`](docs/METODO.md).

---

## Cosa fa

A partire da uno o più video, Sopralluogo costruisce una scena 3D orbitabile nella quale la geometria viene rappresentata in coordinate metriche dopo la calibrazione. Il video originale rimane sincronizzato con la scena, consentendo di passare dall'osservazione del filmato alla ricostruzione spaziale senza perdere il riferimento temporale.

Il sistema rileva e traccia persone e veicoli, ricostruendone le traiettorie sul piano del terreno e stimando, quando possibile, posizione, velocità, altezza, intervallo temporale di presenza, camera di origine, confidenza e margine d'errore.

La scena può essere calibrata utilizzando una distanza reale conosciuta, permettendo di trasformare la scala relativa della ricostruzione in una scala metrica. Il viewer consente inoltre di effettuare misurazioni punto-punto direttamente nello spazio 3D, inserire marker temporali e salvare lo stato dell'analisi.

Quando vengono forniti più video appartenenti allo stesso evento, Sopralluogo può tentare di sincronizzarli automaticamente attraverso eventi acustici comuni e di determinare l'allineamento spaziale utilizzando informazioni condivise tra le diverse sorgenti.

L'intera elaborazione viene registrata all'interno del caso, compresi modelli, parametri, versioni, timestamp, operazioni effettuate e hash SHA-256 dei file, tramite `manifest.json`.

---

## Architettura della pipeline

La pipeline parte dall'estrazione dei fotogrammi tramite FFmpeg. I frame vengono quindi analizzati per ottenere una rappresentazione dello sfondo, una stima della profondità, le detections degli oggetti e le relative traiettorie.

La profondità viene stimata tramite **Depth Anything V2**, mentre **YOLO11** viene utilizzato per il rilevamento di persone e veicoli. Un tracker associa le detections tra fotogrammi consecutivi, consentendo di costruire una traiettoria individuale per ciascun soggetto.

La pipeline procede quindi con la stima dei parametri della telecamera e con l'identificazione del piano del terreno. I punti di contatto dei soggetti con il terreno vengono utilizzati come riferimento geometrico e la scena viene successivamente riportata a una scala metrica attraverso la calibrazione.

Il risultato finale è una rappresentazione nella quale geometria, tempo, video originale e informazioni sui soggetti possono essere analizzati insieme.

```text
Video
  │
  ▼
Frame Extraction
  │
  ├── Background Reconstruction
  │
  ├── Depth Estimation ──────► Depth Anything V2
  │
  ├── Object Detection ──────► YOLO11
  │
  ├── Object Tracking
  │
  ├── Camera Calibration
  │
  ├── Ground Plane
  │
  └── Metric Reconstruction
             │
             ▼
        3D Scene + Tracks
             │
             ▼
       Interactive Viewer
```

---

## Installazione

Sopralluogo richiede **Python 3.10 o superiore**, **Node.js 18 o superiore** e **FFmpeg**. È compatibile con macOS, Linux e Windows. Una GPU non è obbligatoria, anche se l'elaborazione può risultare sensibilmente più lenta senza accelerazione hardware.

### FFmpeg

FFmpeg deve essere disponibile nel `PATH`.

Su macOS con Apple Silicon:

```bash
brew install ffmpeg
```

È possibile verificare l'installazione con:

```bash
ffmpeg -version
```

Su Linux:

```bash
sudo apt install ffmpeg
```

Su Windows è possibile installare FFmpeg tramite un package manager oppure aggiungerlo manualmente al `PATH`.

### Pipeline

```bash
cd pipeline

python -m venv .venv
```

Su macOS e Linux:

```bash
source .venv/bin/activate
```

Su Windows:

```powershell
.venv\Scripts\activate
```

Installare quindi il progetto:

```bash
pip install -e .
```

I modelli possono essere scaricati con:

```bash
sopralluogo models
```

Il download iniziale dei modelli è di circa **110 MB**, salvo variazioni dovute alle versioni dei modelli.

### Viewer

```bash
cd ../viewer

npm install
npm run build
```

### Installazione automatica

È disponibile anche uno script che prepara l'ambiente e installa le dipendenze necessarie:

```bash
./scripts/install.sh
```

---

## Utilizzo

L'elaborazione di un singolo video può essere avviata con:

```bash
sopralluogo process video.mp4 \
  -o casi/piazza \
  --title "Piazza, 6 ottobre"
```

La pipeline crea una nuova cartella contenente gli artefatti necessari per l'analisi.

Il caso può quindi essere aperto nel visualizzatore locale tramite:

```bash
sopralluogo serve casi/piazza
```

Il browser verrà aperto sulla relativa interfaccia di analisi.

---

## Più telecamere

Sopralluogo può lavorare con più sorgenti appartenenti allo stesso evento:

```bash
sopralluogo process \
  cam_ingresso.mp4 \
  cam_parcheggio.mp4 \
  telefono.mp4 \
  -o casi/evento
```

Quando le diverse sorgenti contengono informazioni comuni sufficienti, la pipeline tenta di ricostruire una scena condivisa e di portare le singole telecamere all'interno dello stesso sistema di riferimento.

### Sincronizzazione temporale

Quando i video contengono audio, Sopralluogo può cercare eventi acustici comuni per determinare automaticamente l'offset temporale tra le sorgenti.

Per esempio, un singolo evento come un clacson può essere utilizzato come riferimento comune:

```text
cam1 ──────────────── CLACSON ────────────────
cam2 ─────────── CLACSON ─────────────────────
                       ▲
                   stesso evento
```

L'offset può anche essere calcolato manualmente:

```bash
sopralluogo sync cam1.mp4 cam2.mp4
```

oppure specificato direttamente durante l'elaborazione:

```bash
--offset cam2=1.35
```

L'offset rappresenta il numero di secondi da aggiungere alla timeline di `cam2`.

---

## Allineamento spaziale

Quando più telecamere osservano una porzione comune della scena, Sopralluogo tenta di determinare automaticamente la trasformazione spaziale necessaria per riportarle nello stesso sistema di coordinate.

Uno degli approcci utilizzati consiste nell'identificare soggetti comuni osservati nello stesso momento dalle diverse sorgenti.

Quando le corrispondenze automatiche non sono sufficienti, è possibile fornire manualmente dei punti comuni:

```bash
--align-points punti.json
```

Un file di allineamento può avere questa struttura:

```json
{
  "cam2": [
    {
      "src": [1.2, -14.0],
      "dst": [-3.5, -22.1]
    },
    {
      "src": [6.0, -18.3],
      "dst": [0.8, -27.9]
    }
  ]
}
```

`src` rappresenta le coordinate `x,z` del punto nella scena della seconda telecamera, mentre `dst` rappresenta le coordinate dello stesso punto nella scena di riferimento. Le coordinate possono essere ottenute direttamente utilizzando lo strumento **Misura** del viewer.

---

## Configurazione

I parametri principali possono essere utilizzati per adattare l'elaborazione alle caratteristiche della sorgente video.

```text
--hfov 62
```

imposta il campo visivo orizzontale della telecamera quando questo valore è conosciuto.

```text
--person-height 1.75
```

definisce l'altezza media assunta per le persone.

```text
--imgsz 1280
```

aumenta la risoluzione utilizzata durante la detection.

```text
--analysis-fps 15
```

determina quanti fotogrammi al secondo vengono analizzati.

```text
--mesh-stride 1
```

aumenta la densità della superficie 3D.

Un'elaborazione più dettagliata richiede naturalmente più tempo e memoria.

Per esempio:

```bash
sopralluogo process video.mp4 \
  -o casi/evento \
  --hfov 62 \
  --person-height 1.75 \
  --analysis-fps 15 \
  --imgsz 1280
```

---

## Visualizzatore 3D

Il viewer costituisce l'interfaccia principale per l'analisi del caso e permette di osservare contemporaneamente la ricostruzione spaziale e il materiale video originale.

La scena può essere orbitata, ingrandita e traslata, osservata dall'alto oppure dalla prospettiva della telecamera. La timeline del video rimane sincronizzata con la scena 3D, consentendo di seguire l'evoluzione dell'evento nel tempo.

```text
                 ┌─────────────────────────┐
                 │        3D SCENE         │
                 │                         │
                 │    ● Person #07         │
                 │       ╲                 │
                 │        ╲ trajectory     │
                 │                         │
                 └─────────────────────────┘
                           │
                    synchronized
                           │
                 ┌─────────────────────────┐
                 │      ORIGINAL VIDEO     │
                 └─────────────────────────┘
```

### Controlli

| Tasto | Funzione |
|:---:|---|
| `Space` | Play / pausa |
| `←` / `→` | Frame precedente / successivo |
| `Shift + ←` / `→` | Salta 10 frame |
| `M` | Misura una distanza |
| `K` | Calibra la scala |
| `B` | Inserisce un marker temporale |
| `C` | Vista camera |
| `T` | Vista dall'alto |
| `O` | Vista complessiva |
| `Esc` | Torna alla modalità Esplora |

---

## Misurazioni

Lo strumento **Misura** permette di selezionare due punti all'interno della scena e calcolare la distanza tra loro nello spazio 3D ricostruito.

```text
       A ●────────────────────● B
                    4.72 m
```

La distanza risultante dipende dalla qualità della ricostruzione e dalla corretta calibrazione della scena.

### Calibrazione metrica

Una ricostruzione monoculare produce inizialmente una geometria caratterizzata da una scala relativa. Per ottenere coordinate metriche è necessario fornire almeno una distanza reale conosciuta.

Per esempio:

```text
Distanza reale:       8.40 m
Distanza ricostruita: 6.72 unità

scale = 8.40 / 6.72
```

La scala risultante viene applicata alla scena, consentendo di riportare le coordinate in metri.

La qualità della misura dipende direttamente dalla qualità della ricostruzione, dalla calibrazione della telecamera e dalla precisione della distanza utilizzata come riferimento.

---

## Tracking di persone e veicoli

Le persone e i veicoli vengono prima rilevati nei singoli fotogrammi e successivamente associati tra frame consecutivi. In questo modo è possibile costruire una traiettoria individuale per ciascun soggetto.

Un soggetto può essere rappresentato, per esempio, in questo modo:

```text
Person #07

00:00:12.240
X:       4.31 m
Z:      -8.72 m
Speed:   1.42 m/s

00:00:12.307
X:       4.40 m
Z:      -8.63 m
Speed:   1.47 m/s

00:00:12.373
X:       4.50 m
Z:      -8.53 m
Speed:   1.51 m/s
```

La traiettoria può essere visualizzata direttamente nella scena 3D e collegata alla timeline del video.

---

## Ricostruzione dello sfondo

Per le sorgenti con telecamera sostanzialmente statica, lo sfondo può essere stimato utilizzando la mediana di numerosi fotogrammi.

Gli elementi che si muovono all'interno della scena vengono progressivamente esclusi dalla rappresentazione dello sfondo, permettendo di ottenere una descrizione più stabile dell'ambiente osservato.

Questo passaggio viene successivamente utilizzato insieme alla depth estimation e agli altri componenti della pipeline per costruire la scena.

---

## Depth estimation

La profondità relativa della scena viene stimata tramite **Depth Anything V2**.

La depth monoculare non rappresenta direttamente una misura metrica. La stessa scena può essere ricostruita con una geometria plausibile ma con una scala o una profondità assoluta non corrette.

Per questo motivo la depth deve essere interpretata attraverso la calibrazione della scena e, quando possibile, attraverso riferimenti reali.

---

## Camera calibration

La pipeline stima i parametri necessari a rendere coerente la geometria della ricostruzione.

A seconda della sorgente e delle informazioni disponibili, questi possono comprendere l'altezza della telecamera, l'inclinazione, il rollio, il campo visivo, l'orientamento e il piano del terreno.

La calibrazione costituisce uno dei passaggi fondamentali per trasformare una ricostruzione visivamente plausibile in una rappresentazione geometrica utilizzabile per l'analisi.

---

## Ground plane

Il piano del terreno viene utilizzato come riferimento geometrico della scena.

I punti di contatto dei soggetti con il terreno vengono riportati su questo piano, permettendo di rappresentare persone e veicoli attraverso coordinate coerenti e di costruire le relative traiettorie sul piano della scena.

---

## Struttura di un caso

Ogni elaborazione produce una cartella indipendente contenente la scena, i dati di elaborazione, il materiale originale e gli artefatti generati per ciascuna telecamera.

```text
caso/
│
├── scene.json
├── manifest.json
├── workspace.json
│
├── media/
│   ├── cam1.mp4
│   ├── cam2.mp4
│   └── ...
│
└── cameras/
    ├── cam1/
    │   ├── background.*
    │   ├── depth.*
    │   ├── mesh.*
    │   └── tracks.json
    │
    └── cam2/
        ├── background.*
        ├── depth.*
        ├── mesh.*
        └── tracks.json
```

### `scene.json`

`scene.json` contiene la descrizione geometrica della scena, comprese telecamere, calibrazione, trasformazioni, sincronizzazione, allineamento e sistema di coordinate.

### `manifest.json`

`manifest.json` costituisce il registro dell'elaborazione. Contiene gli SHA-256 dei file originali e generati, i modelli utilizzati, le relative versioni, i parametri di esecuzione, i timestamp, le operazioni effettuate e le informazioni sull'ambiente.

Questo permette di ricostruire come è stato prodotto un determinato risultato e di verificare l'integrità degli artefatti.

### `workspace.json`

`workspace.json` conserva lo stato del lavoro effettuato all'interno del viewer. Può contenere misure, marker, note, correzioni della scala, selezioni e impostazioni della scena.

Il workspace può essere salvato insieme al caso e riaperto successivamente per continuare l'analisi.

---

## Esportazione

Il viewer permette di esportare le informazioni prodotte durante l'analisi, comprese immagini della vista corrente, posizioni dei soggetti, traiettorie, misure, timestamp, marker e workspace.

I dati numerici possono inoltre essere esportati in formato CSV per essere elaborati successivamente con altri strumenti.

---

## Integrità e riproducibilità

Sopralluogo non tratta il caso come una semplice sessione temporanea del viewer.

I file originali e gli artefatti generati vengono registrati nel `manifest.json` attraverso hash **SHA-256**, mentre modelli, versioni, parametri, timestamp e ambiente di esecuzione vengono conservati insieme al caso.

L'obiettivo è rendere l'elaborazione il più possibile **riproducibile e verificabile**, mantenendo traccia di come è stato ottenuto un determinato risultato.

---

## Local-first e privacy

Sopralluogo è progettato per l'elaborazione locale dei dati.

La pipeline non richiede, durante l'analisi, l'upload dei filmati, un account cloud, l'elaborazione remota o API esterne. Una volta scaricati modelli, dipendenze e pacchetti necessari, l'elaborazione può essere eseguita anche in assenza di connessione Internet.

Questo approccio è particolarmente importante quando i filmati contengono materiale che non deve essere trasferito a servizi di terze parti.

L'utilizzatore rimane comunque responsabile di assicurarsi che acquisizione, conservazione, trattamento e utilizzo dei filmati siano conformi alla normativa applicabile e alle procedure dell'organizzazione di appartenenza.

---

## Limiti tecnici

Una ricostruzione 3D ottenuta da una singola telecamera non equivale a una scansione 3D effettuata tramite LiDAR o a una fotogrammetria multi-view controllata.

Il risultato dipende fortemente dalle caratteristiche del materiale acquisito. Qualità e compressione del video, motion blur, illuminazione, ottiche grandangolari, distorsione, prospettive estreme, superfici prive di texture, movimento della telecamera, occlusioni e soggetti parzialmente nascosti possono influire sulla ricostruzione.

Anche la qualità della depth estimation, la calibrazione della telecamera, il riferimento utilizzato per la scala e l'accuratezza del tracking possono introdurre errori.

Il problema più importante è la profondità monoculare, che è intrinsecamente ambigua. Una scena può quindi risultare geometricamente plausibile senza essere necessariamente metricamente corretta.

> **Una misura ottenuta dal sistema deve essere considerata una stima fino a quando non viene verificata attraverso un riferimento reale.**

La metodologia completa, comprese formule, assunzioni e limiti, è disponibile in [`docs/METODO.md`](docs/METODO.md).

---

## Privacy e utilizzo responsabile

Sopralluogo nasce come strumento tecnico per la ricostruzione e l'analisi di scene video.

Il fatto che l'elaborazione sia locale non elimina gli obblighi relativi alla gestione dei dati. L'utilizzatore deve assicurarsi che l'acquisizione, la conservazione, l'analisi e l'eventuale esportazione dei filmati siano effettuate nel rispetto della normativa applicabile e delle procedure dell'organizzazione di appartenenza.

---

## Licenza

Il codice di Sopralluogo è distribuito sotto licenza **MIT**.

```text
LICENSE
```

I modelli e le librerie di terze parti possono essere soggetti a condizioni di licenza differenti. Per i relativi termini e attribuzioni consultare:

```text
NOTICE.md
```

---

## Disclaimer

Sopralluogo è uno strumento di analisi e ricostruzione basato su tecniche di computer vision.

Il sistema non garantisce che una ricostruzione, una posizione, una velocità, un'altezza o una distanza siano esatte. Ogni risultato deve essere interpretato considerando l'incertezza introdotta dal metodo, le condizioni di acquisizione, la qualità del materiale originale e i limiti descritti nella documentazione tecnica.

Per utilizzi tecnici, investigativi o probatori, i risultati devono essere sottoposti a verifica indipendente secondo le procedure applicabili.

**Sopralluogo non nasce semplicemente per visualizzare un video in 3D.**

L'obiettivo è costruire una pipeline **locale, riproducibile e verificabile** capace di trasformare materiale video in una rappresentazione spaziale che possa essere esplorata, sincronizzata, misurata e analizzata mantenendo il collegamento con le sorgenti originali.
