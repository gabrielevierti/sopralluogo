# Metodo e limiti

Questo documento spiega come Sopralluogo ricava misure da un video, quanto ci si può fidare e cosa può andare storto. È scritto per chi deve usare o difendere i risultati, non solo per chi scrive codice.

## 1. Modello della camera

La camera è un modello stenopeico (pinhole) senza distorsione, con il punto principale al centro dell'immagine. Sono incogniti:

- la **focale** (equivalente al campo visivo orizzontale), salvo che venga indicata con `--hfov`;
- l'**inclinazione** verso il basso (pitch) e il **rollio**;
- l'**altezza** della camera dal suolo.

Il mondo ha l'asse Y verso l'alto, il pavimento a y = 0 e la camera in (0, altezza, 0). Le unità sono metri.

Le ottiche grandangolari delle telecamere di sorveglianza distorcono (linee dritte che appaiono curve). La distorsione non è ancora corretta: i bordi dell'immagine sono la zona meno affidabile.

## 2. Auto-calibrazione

### Persone come metro

Per ogni persona in piedi interamente visibile, il riquadro del rilevatore fornisce il pixel dei piedi e quello della testa. Fissata un'altezza media H (default 1,70 m), si cercano i parametri della camera per cui ogni coppia piedi-testa corrisponde a un segmento verticale lungo H appoggiato al pavimento. Il residuo minimizzato è la distanza, in pixel, tra la testa osservata e quella prevista. La perdita è robusta (soft-L1), quindi persone sedute, coperte o rilevate male pesano poco.

È la metrologia da singola vista (Criminisi, Reid, Zisserman 2000; Lv, Zhao, Nevatia 2006).

### Spigoli verticali

Pali, angoli di edifici e stipiti sono verticali nel mondo reale, quindi nell'immagine convergono in un unico punto di fuga. Il punto di fuga dipende dall'inclinazione e dalla focale. Gli spigoli vengono trovati con LSD (Line Segment Detector) sullo sfondo statico, filtrati con RANSAC e aggiunti alla stessa ottimizzazione. Sono molto precisi (errore sub-pixel) e vincolano la focale meglio delle persone.

### Cosa fissa la scala

La scala dipende **solo** dall'altezza media assunta. Se nella scena ci sono soprattutto bambini, o persone molto alte, tutte le distanze sono sbagliate nella stessa proporzione. Per questo esiste la **calibrazione con misura nota**: una distanza misurata sul posto (larghezza di una porta, interasse dei lampioni, lato di una piastrella × numero) corregge la scala di tutto: misure, velocità e altezze.

### Ripiego senza persone

Se non ci sono abbastanza persone, il pavimento viene stimato direttamente dalla mappa di profondità (RANSAC sulla parte bassa dell'immagine) e la scala viene fissata da un'altezza camera ipotetica (`--camera-height`, default 3 m). In questo caso il caso viene marcato come **scala non verificata**: senza una misura nota le misure non hanno valore assoluto.

## 3. Profondità della scena

Depth Anything V2 restituisce una profondità **relativa**: l'inverso della profondità, a meno di una trasformazione affine sconosciuta (disp ≈ a / z + b). I due parametri a e b vengono ricavati confrontando la rete con il pavimento calibrato nei punti dove le persone hanno camminato: lì la profondità vera è nota dalla geometria.

La rete, però, è liscia ovunque: tra un palo e il pavimento dietro di lui non stacca, ma sfuma. Ricostruita pixel per pixel, quella sfumatura diventa un lenzuolo teso dal palo al suolo, e cercare "piani verticali" su tutta l'immagine incolla al muro di un palazzo qualsiasi cosa gli stia davanti alla stessa altezza (un lampione, un cestino, una scala). Per questo la superficie è costruita **a tratti piani** (`planar.py`):

1. L'immagine dello sfondo è divisa in circa 4.000 **superpixel** (SLIC), piccole zone che seguono i contorni dei colori. Ogni decisione è presa per superpixel, e due superpixel si possono unire solo se sono vicini nell'immagine.
2. **Suolo**: un superpixel è pavimento se la maggior parte dei suoi pixel concorda entro l'8% con il piano calibrato e la superficie locale è orizzontale; si tiene solo la parte collegata al pavimento principale. Il suolo è portato esattamente sul piano. I pixel di un superpixel di suolo chiaramente davanti al pavimento (il bordo di un palo) non diventano pavimento: resterebbero stirati sul suolo come strisce scure.
3. **Muri**: superpixel verticali vicini si uniscono se stanno sullo stesso piano verticale *e* non c'è un salto di profondità tra loro. Solo i gruppi grandi diventano muri, raddrizzati come piani esatti; si estendono ai superpixel vicini solo se il piano, lungo il loro raggio di vista, cade alla loro profondità.
4. **Oggetti**: il resto (pali, cestini, cespugli, alberi, la scala) si raggruppa per continuità di profondità e complanarità. Una superficie orizzontale (un gradino, una pedana) resta un piano; tutto il resto diventa una **sagoma verticale** rivolta verso la camera, alla profondità robusta dell'oggetto: un palo resta dritto, un albero resta un albero, invece di inclinarsi a caso.
5. **Mesh**: dentro un oggetto non si taglia mai; tra oggetti diversi si taglia appena c'è un salto di profondità. Si scartano i triangoli di un oggetto molto più lunghi in 3D dei pixel che coprono (sono lenzuoli tesi, non superfici) e i frammenti isolati.

**Limite importante:** fuori dal pavimento e dai muri, la forma è un'approssimazione per sagome: posizione e altezza di un oggetto sono plausibili, il suo spessore no. Una scala appare come una sagoma, non come gradini. Le misure affidabili sono quelle **sul pavimento**, **sui muri** e **sui soggetti**.

## 4. Soggetti

- Rilevamento con YOLO11n ogni N fotogrammi (default 10 al secondo).
- Tracciamento con previsione a velocità costante e assegnazione ungherese sull'IoU. I buchi brevi (meno di 1 s) vengono interpolati e marcati come tali: nel video il riquadro è tratteggiato, nel 3D il soggetto è più trasparente.
- **Posizione**: il centro del bordo inferiore del riquadro (i piedi) viene proiettato sul pavimento.
- **Incertezza**: si sposta il punto dei piedi di ±(2 px + 3% dell'altezza del riquadro) e si misura quanto si sposta il punto sul suolo. Il cerchio disegnato a terra è 2 sigma. Cresce molto con la distanza: un pixel a 80 m vale decine di centimetri.
- **Velocità**: spostamento su una finestra di ±1 s, non da fotogramma a fotogramma (che misurerebbe solo il tremolio del rilevatore). Per tracce più brevi di 1,5 s o troppo incerte la velocità non viene mostrata.
- **Altezza**: dal bordo superiore del riquadro, solo quando il soggetto è interamente nell'immagine. Riporta la mediana. **Attenzione:** è calcolata con una calibrazione che assume 1,70 m come media, quindi è un'altezza *relativa agli altri presenti*. Non è un dato antropometrico: dipende da postura, capelli, cappelli, scarpe e da quanto bene il riquadro aderisce alla persona.

### Superficie più leggibile

Da una sola vista, le superfici che la camera vede quasi di taglio (alberi in fila, il suolo lontanissimo) non hanno informazione di profondità affidabile: una ricostruzione ingenua le stira in lunghe strisce. Tre accorgimenti:

1. **Superficie a tratti piani**: vedi la sezione 3. Muri e suolo sono piani esatti, gli oggetti sagome in piedi.
2. **Taglio dei triangoli radenti e stirati**: le facce con normale quasi perpendicolare alla linea di vista e quelle molto più lunghe dei pixel che coprono vengono eliminate.
3. **Qualità per vertice**: ogni vertice porta un indice di quanto la camera lo vedeva "di fronte", calcolato sul piano del superpixel e non sul rumore della rete. Il visualizzatore sfuma le zone a bassa qualità con bordi morbidi (alpha-to-coverage), disattivabile in Livelli.

4. **Zone nascoste ricostruite** (strato separato, disattivabile in Livelli): dove un oggetto libero (albero, fioriera, palo, chiosco) nasconde il pavimento o un muro, quella superficie viene prolungata dietro l'oggetto. La geometria è quella del piano già noto. Il colore è inventato con l'inpainting FSR di OpenCV, che prosegue bordi e trame. Non si inventano mai forme libere, e il pavimento non viene esteso dentro gli edifici. Questo strato sta *dietro* la superficie reale: dalla camera non cambia nulla, si vede solo girando attorno agli oggetti.
5. **Texture a piena risoluzione**: i colori non sono più legati ai vertici ma proiettati dall'immagine originale (con filtro anisotropo), quindi la scena è nitida quanto il video.

6. **Edifici completati** (spenti di default): ogni muro piano che non è vegetazione diventa un volume. L'impronta segue la facciata per il tratto visto e si estende lontano dalla camera per 6-14 m; l'altezza è quella della facciata. I lati non visti sono rivestiti con la facciata vera raddrizzata (vista frontale, buchi riempiti con FSR). Un volume attraversato da almeno tre punti di traiettoria viene scartato: le persone non camminano dentro gli edifici.
7. **Bordi morbidi**: a ridosso di ogni bordo di informazione mancante, la superficie sfuma nelle ultime 6 celle della griglia invece di finire con un taglio netto.
8. **Dettaglio del pavimento lontano**: una porzione di pavimento vicina alla camera viene raddrizzata in vista dall'alto (1 cm/pixel), resa ripetibile e ridotta alla sola trama fine. Dove l'immagine originale ha meno pixel dello schermo (pavimento lontano, stirato), il visualizzatore aggiunge questa trama. Il colore resta quello vero.
9. **Pavimento attorno alla scena**: un disco con il colore del pavimento e la sua trama, che sfuma verso il bordo, così la scena non resta "appesa" nel vuoto.

**Evidenziazione**: tutte queste parti ricostruite sono rigate in viola quando il livello "Evidenzia le parti ricostruite" è attivo (predefinito).

Il risultato è più bello, ma non più vero: fuori da pavimento e muri la forma resta una stima, e lo strato ricostruito è **contenuto inventato** che non va mai usato come prova di cosa c'era dietro un oggetto.

Limite noto: gli oggetti sottili vicini alla camera (pali, paletti) vengono spesso stimati con la profondità di ciò che c'è dietro, e finiscono "dipinti" sul pavimento come una lunga ombra.

## 5. Aspetto, re-identificazione e volti

- **Firma di aspetto**: istogrammi colore (HSV) di busto (18-50% dell'altezza del riquadro) e gambe (55-90%), calcolati solo sui pixel che differiscono dallo sfondo statico. Così il pavimento dietro la persona non conta.
- **Tracciamento in due passate.** La prima, nell'immagine, serve solo a calibrare la camera. La seconda lavora **sul pavimento, in metri**. Per ogni soggetto si stima la velocità reale; il costo di assegnazione combina:
  - la distanza tra la posizione prevista e quella osservata, con una soglia che cresce col tempo passato nascosto e con l'incertezza della misura;
  - la sovrapposizione dei riquadri;
  - la somiglianza degli abiti, che pesa di più (60%) quando i riquadri si sovrappongono.

  I colori misurati mentre due persone si sovrappongono non aggiornano l'aspetto memorizzato, perché sono un miscuglio di due persone. Due persone affiancate sono a 60 cm l'una dall'altra anche quando sullo schermo i riquadri coincidono.
- **Re-identificazione dopo un'occlusione**: una traccia che finisce e una che inizia entro `--reid-gap` secondi vengono unite se:
  - la seconda compare dove la prima sarebbe arrivata continuando a camminare alla stessa velocità (tolleranza 1,5 m + 0,7 m per secondo nascosto);
  - gli abiti sono simili.

  Per i frammenti più corti di 1 s (spesso mezzi coperti) la velocità non è affidabile, quindi si usa solo la posizione, con tolleranze più larghe. Le unioni sono elencate nella scheda del soggetto e nel file (`links`), con l'errore di posizione e la somiglianza. Il tratto non visto è tratteggiato in giallo e in quell'intervallo il soggetto è marcato "nascosto".
- **Correzione manuale**: dalla scheda del soggetto, "E' la stessa persona del soggetto N" unisce due tracce. Le correzioni si salvano con l'area di lavoro (`workspace.json`) e restano distinguibili da quelle automatiche. L'ultima parola spetta all'operatore.
- **Persone dalla sagoma (modalità predefinita)**: YOLO11n-seg segmenta ogni soggetto in ogni fotogramma analizzato; la maschera (32 × 64, normalizzata sul riquadro) viene salvata in un atlante. Nel visualizzatore la sagoma viene "gonfiata" in un volume: spessa al centro del corpo, sottile ai bordi (spessore massimo circa 0,4 volte la larghezza). Il ritaglio combina la maschera di segmentazione (forma affidabile) con la sottrazione dello sfondo (bordi fini). Il davanti mostra il video vero. Il retro ripete la sagoma più scuro ed è marcato come ricostruito. La figura è rivolta verso la telecamera che l'ha ripresa e ruota solo in parte verso chi guarda, per restare leggibile.
- **Manichini (opzionale)**: un manichino articolato per le persone, un mezzo stilizzato per i veicoli (dimensioni tipiche per classe: auto 4,4 × 1,8 m, autobus 12 m...). Vengono dal video:
  - la posizione ai piedi;
  - l'altezza, fotogramma per fotogramma, o la mediana;
  - la direzione, presa dallo spostamento nell'ultimo secondo e mantenuta quando il soggetto si ferma;
  - i colori di busto e gambe.

  La postura invece **non** è misurata: il passo è un ciclo generico, legato alla distanza percorsa, per cui scorrendo avanti e indietro si vede sempre lo stesso passo nello stesso punto. Sul lato rivolto alla telecamera vengono proiettati i pixel reali del fotogramma, solo dove differiscono dallo sfondo. Quando il soggetto è coperto il manichino resta nella posizione stimata, con l'etichetta "coperto".
- **Sagome** (alternativa al 3D, da Livelli): nel visualizzatore ogni soggetto è un rettangolo verticale ai suoi piedi, alto quanto la sua altezza stimata, che ruota verso chi guarda. È ritagliato dal fotogramma corrente sottraendo lo sfondo statico. Nella proiezione del video sulla scena le aree dei soggetti vengono escluse.
- **Colori**: il colore dominante (k-means) di busto e gambe, dopo un bilanciamento del bianco "grey world" calcolato sullo sfondo, viene nominato con regole HSV esplicite. È riportato anche l'accordo tra i fotogrammi. Luce, ombre e compressione cambiano i colori: un "blu" è un'indicazione, non un fatto.
- **Viste e volti**: per ogni soggetto si conservano le 4 inquadrature migliori (grandezza, nitidezza della testa, confidenza, non tagliate dal bordo), ritagliate dai fotogrammi decodificati, senza alcun miglioramento. Nella zona della testa si cerca un volto con il rilevatore SSD di OpenCV (soglia 0,7). Il "focus volto" del visualizzatore è un ingrandimento a pixel netti (nearest neighbour): ogni quadrato è un pixel reale.

**Sui volti, chiaramente:** sotto i 40-50 pixel di altezza della testa un volto non è riconoscibile, e nessun software può recuperare dettagli che il sensore non ha registrato. Gli strumenti di "super-risoluzione" con IA *inventano* lineamenti plausibili: non vanno mai usati per identificare una persona. Sopralluogo non li usa di proposito.

## 6. Più camere

- **Tempo**: correlazione incrociata dell'inviluppo degli attacchi sonori (onset) dei due audio. L'affidabilità riportata è il rapporto tra il picco principale e il secondo picco: sotto 1,5 il risultato è da controllare a vista.
- **Spazio**: ogni camera ha già il suo pavimento a y = 0 e l'asse Y verso l'alto. Mancano solo una rotazione attorno alla verticale, una traslazione sul suolo e una piccola correzione di scala. Per ogni coppia di tracce contemporanee nelle due camere si ipotizza che siano la stessa persona e si stima la trasformazione (Umeyama 2D). Vince l'ipotesi confermata dal maggior numero di altre coppie. In alternativa si forniscono a mano almeno due punti comuni.

Le camere che si muovono (telefoni, dashcam, bodycam) **non sono ancora supportate**: il programma lo rileva e lo segnala nella scheda Caso. Per quelle serve la ricostruzione Structure-from-Motion (COLMAP), prevista come sviluppo successivo.

## 7. Integrità

- Gli originali vengono **solo letti**. Di ognuno si registrano SHA-256, dimensione, metadati del contenitore e il percorso.
- Il visualizzatore usa una copia di consultazione H.264 con fotogrammi chiave fitti, per poter scorrere fotogramma per fotogramma. La numerazione dei fotogrammi è quella dell'originale a frequenza costante; con video a frequenza variabile può differire di qualche fotogramma.
- `manifest.json` contiene versioni del software, impronte di tutti i modelli usati, parametri, registro dell'elaborazione e SHA-256 e dimensione di ogni file prodotto. Rieseguire con gli stessi ingressi e parametri dà gli stessi risultati (l'esecuzione è deterministica su CPU).
- I modelli vengono scaricati da URL fissati a una versione e accettati solo se la loro impronta coincide con quella scritta nel codice (`models.py`).

### Impronta del caso

Controllare i file contro il manifest prova solo che non sono cambiati *rispetto al manifest*: chi modifica un file può riscrivere anche il manifest. Per questo la pipeline stampa a fine elaborazione l'**impronta del caso**, cioè lo SHA-256 di `manifest.json`. Va riportata a verbale, fuori dalla cartella. Da quel momento:

```bash
sopralluogo verify casi/piazza --impronta <impronta a verbale> --originali video.mp4
```

segnala file modificati, mancanti o aggiunti, confronta l'impronta con quella a verbale e controlla che i video originali siano quelli elaborati. Esce con codice 0 solo se tutto coincide. Il visualizzatore fa la stessa verifica (badge accanto al titolo; i casi sotto 300 MB sono verificati all'apertura) e calcola le impronte a blocchi, quindi anche video di diversi GB non vengono caricati in memoria. `workspace.json` è dell'operatore e non fa parte dell'elaborazione: non è nel manifest e non conta come file aggiunto.

### Registro delle operazioni

Ogni azione dell'operatore che cambia ciò che il caso dice (misure aggiunte o eliminate, correzione di scala, unione o separazione di soggetti, istanti segnati, verifiche, esportazioni) viene registrata con data e ora, salvata in `workspace.json` e stampata nella relazione tecnica. Le unioni manuali di soggetti si possono annullare; restano comunque nel registro.

### Esportazioni

Ogni immagine esportata porta sotto una didascalia con titolo del caso, tempo e fotogramma, stato e incertezza della scala, impronta del caso e data, e accanto il fotogramma originale corrispondente. Se sono visibili superfici completate senza dati, la didascalia lo dice. I CSV hanno in prima riga impronta e stato della scala. La **relazione tecnica** (Esporta → Relazione tecnica) è una pagina stampabile in PDF con impronta ed esito della verifica, fonti, calibrazione, misure con incertezza, soggetti, registro delle operazioni, modelli e spazio per la firma.

## 7-bis. Incertezza delle misure

Ogni punto cliccato registra **dove** è stato preso:

| Provenienza | Significato | Errore del punto |
|---|---|---|
| suolo | pavimento visto dalla camera, piano esatto | geometria del suolo (sotto) |
| muro | piano verticale ricostruito dal suo piede sul suolo | come il suolo a quella distanza, ×1,5 |
| superficie stimata | profondità monoculare (Depth Anything) | ±10% della distanza dalla camera |
| suolo ipotizzato piano | piano del suolo dove non c'è superficie; *fuori inquadratura* se la camera non lo vede | come il suolo, con avviso |
| superficie ricostruita | zone completate senza dati | non utilizzabile: avviso, non accettata come riferimento di scala |

Per un punto sul suolo a distanza orizzontale *d* da una camera alta *h*, con focale *f* in pixel e errore di localizzazione σ<sub>px</sub> (il maggiore tra 1,5 px e metà dell'errore mediano di calibrazione):

- lungo la direzione di vista: σ = σ<sub>px</sub> (h² + d²) / (f h)
- di traverso: σ = σ<sub>px</sub> √(h² + d²) / f
- inclinazione della camera: un errore σ<sub>θ</sub> sposta il punto radialmente di (h² + d²) σ<sub>θ</sub> / h. È lo stesso errore per tutti i punti di una camera, quindi per una distanza si usa la **differenza** degli spostamenti dei due estremi (si annulla in parte per punti a distanze simili).

Gli errori dei punti si proiettano sulla direzione della misura e si sommano in quadratura con l'errore di **scala**, proporzionale alla lunghezza:

- scala automatica: ±4% per l'altezza media assunta delle persone (errore sistematico: non diminuisce con il numero di persone), combinato con l'incertezza dell'altezza della camera;
- scala corretta con un riferimento misurato sul posto: errore dei due estremi del riferimento diviso la sua lunghezza, più ±1 cm per la misura a nastro. Un riferimento lungo, sul suolo e vicino alla camera dà la scala migliore; il programma avverte se il riferimento scelto è meno preciso della stima automatica.

Il valore è riportato a 1 sigma; l'intervallo al 95% è ±1,96 sigma. È un modello lineare del primo ordine: non tiene conto di distorsione dell'ottica, rollio, errori grossolani (camera mossa, persone non in piedi) né dei limiti della profondità monoculare oltre il 10%. Per questo la validazione su una scena con misure note resta necessaria.

## 8. Cosa verificare prima di usare un risultato

1. Scheda **Caso**: camera ferma "sì", errore di calibrazione di pochi pixel, molte persone e linee verticali usate.
2. Vista **Dalla camera** (tasto C): i cilindri dei soggetti devono stare esattamente sulle persone del video.
3. Una **misura nota** sul posto, applicata con Calibra scala. Una seconda misura nota, *non* usata per calibrare, va misurata nel 3D come controllo indipendente.
4. Le **velocità di cammino** devono stare tra 3 e 6 km/h: valori fuori scala per chi cammina tranquillo indicano una scala sbagliata.
5. Riportare sempre il **margine d'errore** insieme al valore, e scartare le misure con un estremo su superficie ricostruita.
6. Riportare a verbale l'**impronta del caso** e allegare la relazione tecnica.

## 9. Riferimenti

- A. Criminisi, I. Reid, A. Zisserman, *Single View Metrology*, IJCV 2000.
- F. Lv, T. Zhao, R. Nevatia, *Camera Calibration from Video of a Walking Human*, PAMI 2006.
- L. Yang et al., *Depth Anything V2*, 2024.
- S. Umeyama, *Least-squares estimation of transformation parameters between two point patterns*, PAMI 1991.
- A. Bewley et al., *Simple Online and Realtime Tracking (SORT)*, ICIP 2016.
- R. Grompone von Gioi et al., *LSD: a Line Segment Detector*, IPOL 2012.
