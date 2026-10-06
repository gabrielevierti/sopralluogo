# Sopralluogo

**Trasforma uno o più video dello stesso evento in una scena 3D esplorabile, sincronizzata e misurabile**

Sopralluogo trasforma filmati provenienti da telecamere di videosorveglianza, bodycam, smartphone o altre sorgenti video in una **scena 3D esplorabile e misurabile**, mantenendo il collegamento temporale con i filmati originali.

L'obiettivo è fornire uno strumento locale per l'analisi tecnica di una scena: ricostruzione dello spazio, tracciamento dei soggetti, misurazioni, sincronizzazione di più telecamere e conservazione dell'integrità dei dati.

> **Attenzione:** le misure e le ricostruzioni sono stime ottenute da immagini e modelli di computer vision. Non devono essere considerate automaticamente come misure forensi/probatorie. Prima di utilizzare un risultato in un contesto ufficiale, verificarlo con almeno una misura reale effettuata sul posto. Per metodologia, assunzioni e limiti vedere [docs/METODO.md](docs/METODO.md).

## Cosa fa

A partire da uno o più video, Sopralluogo produce:

- una **scena 3D orbitabile**;
- una rappresentazione spaziale in **metri**;
- il **video originale sincronizzato** con la scena 3D;
- rilevamento e tracking di **persone e veicoli**;
- traiettorie dei soggetti sul piano del terreno;
- velocità stimata;
- altezza stimata;
- margine d'errore;
- misurazioni punto-punto;
- calibrazione della scala tramite una distanza reale conosciuta;
- sincronizzazione automatica di più video;
- allineamento spaziale di più telecamere;
- esportazione dei dati in formati elaborabili;
- verifica dell'integrità tramite **SHA-256**;
- registrazione di modelli, parametri e risultati in `manifest.json`.

L'intera pipeline è progettata per funzionare **localmente**, senza inviare i filmati a servizi cloud.

Dopo il primo download dei modelli, l'analisi può essere eseguita anche senza connessione Internet.

# Installazione

## Requisiti

- Python **3.10+**
- Node.js **18+**
- FFmpeg
- macOS, Linux o Windows
- GPU opzionale

La pipeline può funzionare anche senza GPU, anche se l'elaborazione può risultare sensibilmente più lenta.

### FFmpeg

FFmpeg deve essere disponibile nel `PATH`.

Su macOS con Apple Silicon:

```bash
brew install ffmpeg
```

Verifica:

```bash
ffmpeg -version
```

Su Linux:

```bash
sudo apt install ffmpeg
```

Su Windows è possibile installare FFmpeg tramite un package manager oppure aggiungerlo manualmente al `PATH`.

## Installazione manuale

### Pipeline

```bash
cd pipeline

python -m venv .venv

# macOS / Linux
source .venv/bin/activate

# Windows
.venv\Scripts\activate

pip install -e .
```

Scarica i modelli:

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

## Installazione automatica

È disponibile anche:

```bash
./scripts/install.sh
```

che prepara l'ambiente e installa le dipendenze necessarie.

# Utilizzo

## Analizzare un video

```bash
sopralluogo process video.mp4 \
  -o casi/piazza \
  --title "Piazza, 6 ottobre"
```

La pipeline crea una nuova cartella contenente tutti gli artefatti necessari per l'analisi.

Successivamente:

```bash
sopralluogo serve casi/piazza
```

Il browser verrà aperto sul visualizzatore locale.

# Più telecamere

È possibile analizzare più video appartenenti allo stesso evento:

```bash
sopralluogo process \
  cam_ingresso.mp4 \
  cam_parcheggio.mp4 \
  telefono.mp4 \
  -o casi/evento
```

Sopralluogo tenta di ricostruire un'unica scena utilizzando le informazioni comuni alle diverse sorgenti.

## Sincronizzazione temporale

Se i video contengono audio, la sincronizzazione può essere effettuata automaticamente cercando eventi acustici comuni.

Ad esempio:

```text
cam1 ──────────────── CLACSON ────────────────
cam2 ─────────── CLACSON ─────────────────────
                       ▲
                  stesso evento
```

È inoltre possibile calcolare manualmente l'offset:

```bash
sopralluogo sync cam1.mp4 cam2.mp4
```

oppure specificarlo durante l'elaborazione:

```bash
--offset cam2=1.35
```

L'offset indica i secondi da aggiungere alla timeline di `cam2`.

# Allineamento spaziale

Quando più telecamere osservano una parte comune della scena, Sopralluogo tenta di determinare automaticamente la trasformazione spaziale.

Uno degli approcci utilizzati è il riconoscimento di soggetti comuni osservati nello stesso momento.

Quando non esistono abbastanza corrispondenze automatiche, è possibile fornire manualmente dei punti comuni:

```bash
--align-points punti.json
```

Esempio:

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

Dove:

- `src` = coordinate `x,z` del punto nella scena della seconda telecamera;
- `dst` = coordinate dello stesso punto nella scena di riferimento;
- le coordinate possono essere ottenute utilizzando lo strumento **Misura** del viewer.

---

# Opzioni principali

| Opzione | Descrizione |
|---|---|
| `--hfov 62` | Campo visivo orizzontale della telecamera, se conosciuto |
| `--person-height 1.75` | Altezza media assunta per le persone |
| `--imgsz 1280` | Aumenta la risoluzione di detection |
| `--analysis-fps 15` | Numero di frame analizzati al secondo |
| `--mesh-stride 1` | Aumenta la densità della superficie 3D |

Esempio:

```bash
sopralluogo process video.mp4 \
  -o casi/evento \
  --hfov 62 \
  --person-height 1.75 \
  --analysis-fps 15 \
  --imgsz 1280
```

Aumentare la qualità dell'analisi aumenta anche il tempo e il consumo di memoria.

# Visualizzatore 3D

Il viewer permette di analizzare contemporaneamente la ricostruzione spaziale e il materiale video.

La scena 3D può essere:

- orbitata;
- ingrandita;
- spostata;
- osservata dall'alto;
- osservata dalla prospettiva della telecamera;
- sincronizzata con il video.

## Controlli

| Tasto | Funzione |
|---|---|
| `Spazio` | Play / pausa |
| `←` / `→` | Frame precedente / successivo |
| `Shift + ←` / `→` | Salta 10 frame |
| `M` | Misura una distanza |
| `K` | Calibra la scala |
| `B` | Inserisce un marker temporale |
| `C` | Vista camera |
| `T` | Vista dall'alto |
| `O` | Vista complessiva |
| `Esc` | Torna alla modalità Esplora |

# Misurazioni

Lo strumento **Misura** permette di selezionare due punti della scena:

```text
       A ●────────────────────● B
                    4.72 m
```

La distanza viene calcolata nello spazio 3D ricostruito.

## Calibrazione metrica

La ricostruzione monoculare produce inizialmente una geometria con scala relativa.

È possibile correggere la scala utilizzando una distanza reale conosciuta.

Esempio:

```text
Distanza reale:       8.40 m
Distanza ricostruita: 6.72 unità

scale = 8.40 / 6.72
```

Dopo la calibrazione, le coordinate della scena vengono riportate in metri.

> La qualità della misura dipende direttamente dalla qualità della ricostruzione, dalla calibrazione della telecamera e dalla precisione della distanza utilizzata come riferimento.

# Tracciamento dei soggetti

Le persone e i veicoli vengono rilevati e successivamente associati tra frame consecutivi.

Per ogni soggetto possono essere disponibili:

- ID;
- categoria;
- posizione;
- traiettoria;
- velocità stimata;
- altezza stimata;
- intervallo temporale di presenza;
- camera di origine;
- confidenza;
- errore stimato.

Esempio concettuale:

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

La traiettoria può essere visualizzata direttamente nella scena 3D.

# Pipeline di computer vision

Sopralluogo combina diversi passaggi di computer vision.

### 1. Estrazione dei frame

FFmpeg viene utilizzato per ottenere una sequenza di frame analizzabili.

### 2. Ricostruzione dello sfondo

Lo sfondo statico viene stimato utilizzando la mediana di numerosi fotogrammi.

Gli oggetti che si muovono vengono quindi progressivamente eliminati dalla rappresentazione dello sfondo.

### 3. Depth estimation

**Depth Anything V2** viene utilizzato per stimare la profondità relativa della scena.

La depth monoculare non costituisce direttamente una misura metrica: deve essere interpretata e calibrata.

### 4. Object detection

**YOLO11** viene utilizzato per individuare persone e veicoli.

### 5. Tracking

Un tracker associa le detections tra fotogrammi consecutivi, costruendo le traiettorie individuali.

### 6. Camera calibration

La pipeline stima i parametri necessari a rendere coerente la geometria della scena.

Tra questi possono rientrare:

- altezza della camera;
- inclinazione;
- rollio;
- campo visivo;
- orientamento;
- piano del terreno.

### 7. Ground plane

Il pavimento viene utilizzato come riferimento geometrico.

I punti di contatto dei soggetti con il terreno vengono quindi riportati sul piano della scena.

### 8. Ricostruzione metrica

La scena viene convertita in coordinate metriche utilizzando la scala derivata dalla calibrazione.

# Struttura di un caso

Ogni elaborazione produce una cartella indipendente:

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

## `scene.json`

Contiene le informazioni geometriche della scena:

- telecamere;
- calibrazione;
- trasformazioni;
- sincronizzazione;
- allineamento;
- sistema di coordinate.

## `manifest.json`

Contiene il registro dell'elaborazione:

- SHA-256 dei file originali;
- SHA-256 dei file generati;
- modelli utilizzati;
- versioni;
- parametri;
- timestamp;
- operazioni effettuate;
- informazioni sull'ambiente.

Questo permette di ricostruire come è stato prodotto un determinato risultato.

## `workspace.json`

Contiene lo stato del lavoro effettuato nel viewer:

- misure;
- marker;
- note;
- correzione della scala;
- selezioni;
- impostazioni della scena.

Può essere salvato nella cartella del caso per poter riprendere successivamente l'analisi.

# Esportazione

Dal viewer è possibile esportare:

- immagini della vista corrente;
- posizioni dei soggetti;
- traiettorie;
- misure;
- timestamp;
- marker;
- workspace.

I dati numerici possono essere esportati in CSV per ulteriori elaborazioni.

# Funzionamento offline

Sopralluogo è progettato secondo un modello **local-first**.

Una volta scaricati:

- modelli;
- dipendenze;
- pacchetti necessari;

la pipeline non richiede l'upload dei filmati a server esterni.

Questo è particolarmente importante quando i filmati contengono materiale che non deve essere trasferito a servizi di terze parti.

# Limiti

Una ricostruzione 3D ottenuta da una singola telecamera non equivale a una scansione 3D effettuata con LiDAR o fotogrammetria multi-view controllata.

I principali fattori che possono influire sul risultato sono:

- qualità del video;
- compressione;
- motion blur;
- bassa illuminazione;
- telecamere grandangolari;
- distorsione ottica;
- prospettiva estrema;
- soggetti parzialmente nascosti;
- superfici prive di texture;
- movimento della telecamera;
- errori nella stima della profondità;
- errore di calibrazione;
- errore della distanza reale utilizzata per la scala;
- occlusioni;
- tracking errato.

In particolare, la profondità monoculare è intrinsecamente ambigua. Una scena può essere geometricamente plausibile senza essere metricamente corretta.

Per questo motivo:

> **Una misura ottenuta dal sistema deve essere considerata una stima fino a quando non viene verificata attraverso un riferimento reale.**

La metodologia completa, le formule e le assunzioni sono documentate in:

[docs/METODO.md](docs/METODO.md)

# Privacy

Sopralluogo è pensato per l'elaborazione locale dei dati.

Il progetto non richiede, per il funzionamento della pipeline:

- upload dei video;
- account cloud;
- elaborazione remota;
- API esterne durante l'analisi.

È comunque responsabilità dell'utilizzatore assicurarsi che l'acquisizione, conservazione e trattamento dei filmati siano conformi alla normativa applicabile e alle procedure dell'organizzazione di appartenenza.

# Licenza

Il codice del progetto è distribuito sotto licenza **MIT**.

Vedere:

```text
LICENSE
```

I modelli e le librerie di terze parti possono essere soggetti a licenze differenti.

Per i relativi termini vedere:

```text
NOTICE.md
```

# Disclaimer

Sopralluogo è uno strumento di analisi e ricostruzione computer vision.

Non garantisce che una ricostruzione, una posizione, una velocità, un'altezza o una distanza siano esatte.

I risultati devono essere interpretati tenendo conto dell'incertezza del metodo, delle condizioni di acquisizione e dei limiti descritti nella documentazione tecnica.

Per utilizzi tecnici, investigativi o probatori, i risultati devono essere sottoposti a verifica indipendente secondo le procedure applicabili.

L'obiettivo è costruire una pipeline riproducibile e verificabile, non semplicemente un visualizzatore 3D di un video.