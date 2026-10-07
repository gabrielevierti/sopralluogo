# Traccia per una dimostrazione (5-7 minuti)

Prima della demo:

```bash
sopralluogo process video.mp4 -o casi/demo --title "Nome del caso"
sopralluogo serve casi/demo
```

Usa Chrome o Edge a schermo intero, con la finestra già aperta sul caso.

## 1. Il problema (30 s)
"Un video di sorveglianza è piatto: non si misura, non ci si gira attorno, e con più telecamere si salta da un filmato all'altro. Questo programma lo trasforma in una scena 3D in metri."

## 2. La scena (1 min)
- Premi **Spazio**: video in alto a destra e scena 3D si muovono insieme.
- Trascina per girare attorno: le persone sono le loro vere sagome, ritagliate dal video e trasformate in volumi, con posa e vestiti reali.
- Indica il riquadro in basso a destra "Ricostruito senza dati certi": tutto ciò che è inventato per completare la scena è rigato in viola. Spegnilo per vedere la scena pulita, poi riaccendilo: e' il punto di forza per la credibilita'.
- Premi **C**: la vista si mette esattamente dove sta la telecamera, e le figure coincidono con le persone del video. È la prova visiva che la geometria torna.

## 3. Un soggetto (1-2 min)
- Clicca una persona (nella scena, nel video o nell'elenco). Mostra:
  - il percorso;
  - la velocità con il margine d'errore (per esempio 5,4 ± 1,8 km/h);
  - l'altezza stimata;
  - le inquadrature migliori, cliccabili per saltare a quel fotogramma.
- "Focus volto nel video": zoom che segue la testa. Spiega che sono pixel veri, senza "miglioramenti" artificiali che inventerebbero lineamenti.
- Scorri fino al palo: chi passa dietro resta "coperto" nella posizione stimata e viene riconosciuto quando ricompare (tratto giallo tratteggiato).

## 4. Misure (1 min)
- **M** e due clic: una distanza in metri, **con il suo margine d'errore** (es. 7,54 m ±0,53). Un punto preso fuori inquadratura diventa giallo con l'avviso; uno su una zona ricostruita viola, e non vale come misura.
- **K**: la scala si corregge con una misura presa sul posto, per esempio la larghezza di una porta. Da quel momento misure, velocità e altezze sono ancorate a un dato reale.

## 5. Affidabilità (1 min)
- Scheda **Caso**: come si è calibrata la telecamera (persone e linee verticali usate, errore in pixel), impronte SHA-256 dell'originale e dei modelli usati.
- Badge accanto al titolo: **impronta del caso**, da scrivere a verbale. Se un file cambia, o se qualcuno rigenera il manifest, la verifica (o l'impronta) non coincide più.
- **Esporta → Relazione tecnica**: un PDF con fonti, calibrazione, misure con incertezza, soggetti e registro di tutto ciò che l'operatore ha fatto.
- Tutto gira in locale: nessun file lascia il computer.

## 6. Chiusura (30 s)
Premi **P** (presentazione): la scena gira lentamente in loop.
"Prossimi passi: validazione su una scena misurata e video da cellulare in movimento."

## Domande probabili, risposte oneste
- *Quanto è preciso?* Dipende dalla distanza e da dove si clicca: il programma mostra il margine d'errore di ogni misura e posizione, e lo stringe quando si corregge la scala con una misura sul posto. Il modello d'errore va validato su una scena con misure note, ed è il prossimo passo.
- *Come so che nessuno ha toccato il caso?* L'impronta del caso a verbale e `sopralluogo verify`: se cambia un solo byte, l'esito è "non integro".
- *Le figure 3D sono la vera postura?* Il davanti sì: è la sagoma reale del fotogramma. Il retro e lo spessore sono ricostruiti, e infatti sono evidenziati.
- *Le zone dietro gli oggetti?* Sono ricostruite (contenuto inventato) solo per la visualizzazione. Si spengono da Livelli e non vanno usate come prova.
- *Riconosce i volti?* No, e non "migliora" i volti. Mostra i pixel originali; a bassa risoluzione un volto non è identificabile.
- *Video da telefono?* Non ancora: oggi lavora con telecamere fisse.
