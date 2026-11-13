# Fleetora — OCR local sécurisé (optionnel, non activé par défaut)

Le module `server/tools/document_ocr.py` ne transmet **aucun document à une API distante**.
Il analyse une **copie privée temporaire** de l'image ou de la première page du PDF.
L'original reste inchangé; les suggestions ne sont **jamais approuvées automatiquement**.

## Dépendances et limites
- Python 3.11+; Tesseract OCR avec langues utiles `eng`, `fra`, `ara`.
- Python : `opencv-python-headless`, `pytesseract`, `numpy`.
- Pour les PDF : `poppler-utils` (commande `pdftoppm`).
- Il faut prévoir une image de déploiement contenant ces outils et langues. L'environnement Railway existant **n'a pas été vérifié** pour ces dépendances. Ne pas activer avant leur présence.
- Le traitement utilise des limites de taille d'image/fichier et un délai d'exécution. Éviter l'OCR public de masse; réservé au gérant.

### Installation de test sur Ubuntu/Debian (machine de test, PAS en production)
```bash
sudo apt-get update
sudo apt-get install -y python3-venv tesseract-ocr tesseract-ocr-eng tesseract-ocr-fra tesseract-ocr-ara poppler-utils
python3 -m venv .venv-ocr
. .venv-ocr/bin/activate
python -m pip install opencv-python-headless pytesseract numpy
tesseract --list-langs
python -m unittest discover -s server/tools -p 'test_*.py'
python server/tools/document_ocr.py /chemin/vers/une_image_SYNTHETIQUE.jpg id_front
```
Les commandes ci-dessus n'intègrent pas les paquets à Railway automatiquement.

Pour le serveur Node, lorsque la procédure d'installation est terminée **dans un environnement isolé** :
```bash
FLEETORA_OCR_ENABLED=true
FLEETORA_OCR_PYTHON=/chemin/absolu/vers/.venv-ocr/bin/python
FLEETORA_OCR_LANG=fra+eng+ara
```
`FLEETORA_OCR_PYTHON` doit désigner le Python contenant les bibliothèques et accessible au serveur.
Si `FLEETORA_OCR_ENABLED` n'est pas égal à `true`, l'API retourne `503 ocr_disabled` et n'ouvre pas le fichier.

## Ce que l'OCR fait réellement
- Détecte une faible netteté, luminosité extrême ou résolution insuffisante.
- Tente une petite correction d'inclinaison, améliore le contraste avec CLAHE.
- Interroge Tesseract localement; l'extraction est indicative.
- Pour les passeports TD3, utilise les chiffres de contrôle de la zone MRZ pour vérifier le numéro et certaines dates.
- Pour CIN marocaine, suggère seulement un numéro par motif; il n'est **pas vérifié** et sa confiance est basse.
- Calcule un `dHash` perceptuel sur l'image transformée; les images recadrées/tournées peuvent produire des valeurs très différentes.
- Le serveur garde les chiffres de qualité et le hachage visuel de l'image, mais **ne conserve pas le texte OCR brut**.
- Renvoie les propositions au navigateur du gérant sans modifier la fiche du client, le permis, la réservation ou le contrat.

## Ce que l'OCR ne garantit pas
Il ne garantit **pas** la lecture correcte de l'arabe, la détection automatique du cadre de toute carte, la suppression réelle du flou, la distinction entre fausses et vraies pièces ni la fiabilité d'un document réel.
Une détection de qualité n'est pas une validation de l'identité. Pour des photos déjà très floues, il faut refaire la prise de vue.

Avant d'utiliser sur de vrais documents : vérifier le comportement sur plusieurs appareils et typologies de documents, corriger les performances, établir un traitement licite des données personnelles avec une durée de conservation, et faire un essai de restauration d'une sauvegarde.
