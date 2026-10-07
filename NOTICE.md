# Componenti di terze parti

I pesi dei modelli non sono inclusi nel repository: `sopralluogo models` li scarica in `~/.cache/sopralluogo/models` (o in `$SOPRALLUOGO_MODELS`).

| Modello | Uso | Licenza |
|---|---|---|
| Depth Anything V2 Small, export ONNX di fabio-sim/Depth-Anything-ONNX | profondità della scena | Apache-2.0 |
| YOLO11n, Ultralytics | rilevamento persone e veicoli | **AGPL-3.0** |
| YOLO11n-seg, Ultralytics | sagome delle persone | **AGPL-3.0** |
| OpenCV res10 SSD face detector | rilevamento volti | BSD-3 (OpenCV) |

**Attenzione per un uso commerciale:** YOLO11 è AGPL-3.0. Distribuire un prodotto che lo include, o offrirlo come servizio, richiede di rispettare l'AGPL oppure una licenza commerciale Ultralytics. In alternativa si può sostituire il rilevatore (`pipeline/sopralluogo/nets.py`, classe `Detector`) con un modello a licenza permissiva, ad esempio RT-DETR (Apache-2.0).

Il visualizzatore usa three.js (MIT), React (MIT), react-three-fiber e drei (MIT), zustand (MIT) e i caratteri Barlow (SIL Open Font License).
