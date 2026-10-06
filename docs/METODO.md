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

Poi:

- i pixel la cui profondità è entro il 10% di quella del pavimento vengono **portati esattamente sul piano**, così il suolo è piatto e misurabile;
- i triangoli che attraversano un salto di profondità vengono scartati, per non creare "tende" tra oggetti vicini e lontani.

**Limite importante:** fuori dal pavimento (muri, alberi, oggetti) la forma 3D è quella stimata dalla rete neurale. È plausibile ma non è un rilievo: muri lontani possono risultare inclinati o deformati. Le misure affidabili sono quelle **sul pavimento** e quelle **sui soggetti**.

## 4. Soggetti

- Rilevamento con YOLO11n ogni N fotogrammi (default 10 al secondo).
- Tracciamento con previsione a velocità costante e assegnazione ungherese sull'IoU. I buchi brevi (meno di 1 s) vengono interpolati e marcati come tali: nel video il riquadro è tratteggiato, nel 3D il soggetto è più trasparente.
- **Posizione**: il centro del bordo inferiore del riquadro (i piedi) viene proiettato sul pavimento.
- **Incertezza**: si sposta il punto dei piedi di ±(2 px + 3% dell'altezza del riquadro) e si misura quanto si sposta il punto sul suolo. Il cerchio disegnato a terra è 2 sigma. Cresce molto con la distanza: un pixel a 80 m vale decine di centimetri.
- **Velocità**: spostamento su una finestra di ±1 s, non da fotogramma a fotogramma (che misurerebbe solo il tremolio del rilevatore). Per tracce più brevi di 1,5 s o troppo incerte la velocità non viene mostrata.
- **Altezza**: dal bordo superiore del riquadro, solo quando il soggetto è interamente nell'immagine. Riporta la mediana. **Attenzione:** è calcolata con una calibrazione che assume 1,70 m come media, quindi è un'altezza *relativa agli altri presenti*. Non è un dato antropometrico: dipende da postura, capelli, cappelli, scarpe e da quanto bene il riquadro aderisce alla persona.

## 5. Più camere

- **Tempo**: correlazione incrociata dell'inviluppo degli attacchi sonori (onset) dei due audio. L'affidabilità riportata è il rapporto tra il picco principale e il secondo picco: sotto 1,5 il risultato è da controllare a vista.
- **Spazio**: ogni camera ha già il suo pavimento a y = 0 e l'asse Y verso l'alto. Mancano solo una rotazione attorno alla verticale, una traslazione sul suolo e una piccola correzione di scala. Per ogni coppia di tracce contemporanee nelle due camere si ipotizza che siano la stessa persona e si stima la trasformazione (Umeyama 2D). Vince l'ipotesi confermata dal maggior numero di altre coppie. In alternativa si forniscono a mano almeno due punti comuni.

Le camere che si muovono (telefoni, dashcam, bodycam) **non sono ancora supportate**: il programma lo rileva e lo segnala nella scheda Caso. Per quelle serve la ricostruzione Structure-from-Motion (COLMAP), prevista come sviluppo successivo.

## 6. Integrità

- Gli originali vengono **solo letti**. Di ognuno si registrano SHA-256, dimensione, metadati del contenitore e il percorso.
- Il visualizzatore usa una copia di consultazione H.264 con fotogrammi chiave fitti, per poter scorrere fotogramma per fotogramma. La numerazione dei fotogrammi è quella dell'originale a frequenza costante; con video a frequenza variabile può differire di qualche fotogramma.
- `manifest.json` contiene versioni del software, impronte dei modelli, parametri, registro dell'elaborazione e SHA-256 di ogni file prodotto. Rieseguire con gli stessi ingressi e parametri dà gli stessi risultati (l'esecuzione è deterministica su CPU).

## 7. Cosa verificare prima di usare un risultato

1. Scheda **Caso**: camera ferma "sì", errore di calibrazione di pochi pixel, molte persone e linee verticali usate.
2. Vista **Dalla camera** (tasto C): i cilindri dei soggetti devono stare esattamente sulle persone del video.
3. Una **misura nota** sul posto, applicata con Calibra scala. Una seconda misura nota, *non* usata per calibrare, va misurata nel 3D come controllo indipendente.
4. Le **velocità di cammino** devono stare tra 3 e 6 km/h: valori fuori scala per chi cammina tranquillo indicano una scala sbagliata.
5. Riportare sempre il **margine d'errore** insieme al valore.

## 8. Riferimenti

- A. Criminisi, I. Reid, A. Zisserman, *Single View Metrology*, IJCV 2000.
- F. Lv, T. Zhao, R. Nevatia, *Camera Calibration from Video of a Walking Human*, PAMI 2006.
- L. Yang et al., *Depth Anything V2*, 2024.
- S. Umeyama, *Least-squares estimation of transformation parameters between two point patterns*, PAMI 1991.
- R. Grompone von Gioi et al., *LSD: a Line Segment Detector*, IPOL 2012.
