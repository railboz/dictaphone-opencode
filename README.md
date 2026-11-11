# dictaphone-opencode

Dictée vocale pour **OpenCode Desktop**, avec une vraie icône microphone juste
à côté du bouton d'envoi.

![Icône microphone dans OpenCode](docs/mic-button.png)

![Transcription insérée dans le prompt](docs/dictation.png)

*L'icône micro à côté du bouton d'envoi, et le texte transcrit inséré dans le
prompt sans être envoyé.*

## Ce que fait le plugin

- Icône microphone dessinée en SVG, à côté du bouton d'envoi (icône seule,
  sans libellé).
- Raccourci `Ctrl+Maj+M` (ou `Cmd+Maj+M` sur macOS) et commande `/voice`.
- Pastille d'état au-dessus du prompt : écoute, durée, transcription.
- Le texte transcrit est **inséré dans le prompt**, jamais envoyé tout seul.
- Trois moteurs : serveur local, OpenAI, ou tout endpoint compatible OpenAI.
- Réglages intégrés dans **Settings › Dictaphone**.
- Audio converti en WAV 16 kHz mono avant l'envoi.
- Transcription locale rapide : ~0,5 s sur GPU, quelques secondes sur CPU.

## Comment ça marche

```text
Micro → MediaRecorder → WAV 16 kHz mono → RPC OpenCode → service de transcription
                                                       ↓
                          prompt OpenCode ← texte ←────┘
```

Le plugin a deux parties : une partie GUI (icône micro, capture audio,
insertion dans le prompt) et une partie serveur (appel HTTP vers le service
configuré). L'audio ne transite qu'entre OpenCode et ce service.

## Performances mesurées

Sur un i9-9900K et une RTX 2080 Ti, phrase française de 7,5 s :

| Configuration | Temps |
|---|---|
| `large-v3-turbo` sur GPU (float16, beam 5) | **~0,5 s** |
| `large-v3` sur GPU (float16, beam 5) | ~1,1 s |
| `small` sur CPU (int8, beam 5) | ~1,6 s |
| `large-v3-turbo` sur CPU (int8, beam 5) | ~4,9 s |

Le modèle `large-v3-turbo` est utilisé par défaut quand un GPU NVIDIA est
détecté : bien plus exact que `small`, notamment sur les noms propres et les
phrases ambiguës. Sur CPU, l'installeur garde `small` pour rester rapide ;
`large-v3-turbo` reste disponible en le demandant explicitement.

## Prérequis

- **OpenCode Desktop 2.2.7 ou plus récent** (API des plugins GUI
  `gui-experimental`).
- **Python 3.12** et [`uv`](https://docs.astral.sh/uv/) pour le serveur local.
  `uv` s'installe en une commande :
  `curl -LsSf https://astral.sh/uv/install.sh | sh`
- Facultatif : un GPU NVIDIA avec un pilote récent pour la transcription locale
  rapide avec `large-v3-turbo`. L'installeur ajoute les bibliothèques CUDA
  nécessaires dans l'environnement virtuel.
- Facultatif : une clé API OpenAI si vous préférez le mode cloud.

> Le serveur local fourni utilise systemd (Linux). Sur macOS ou Windows,
> utilisez OpenAI ou un endpoint compatible OpenAI : l'icône microphone et
> l'insertion dans le prompt fonctionnent de la même façon.

## Installation clé en main

```bash
git clone https://github.com/railboz/dictaphone-opencode.git
cd dictaphone-opencode
./install.sh
```

Sur une machine avec GPU NVIDIA, le modèle par défaut est `large-v3-turbo` ;
sinon `small`. Pour forcer un modèle : `./install.sh large-v3`.

Le script :

1. construit le bundle GUI si `dist/` est absent ;
2. installe le serveur local dans `~/.local/share/dictaphone-opencode` et le
   service systemd utilisateur ;
3. ajoute le dossier du plugin à `~/.config/opencode/opencode.json`.

Redémarrez OpenCode Desktop. L'icône micro apparaît à côté du bouton d'envoi
d'une session.

Pour utiliser uniquement OpenAI (sans serveur local) :

```bash
DICTAPHONE_SKIP_SERVER=1 ./install.sh
```

puis renseignez la clé dans **Settings › Dictaphone**.

## Utilisation

1. Ouvrez une session.
2. Cliquez sur l'icône **micro**, appuyez sur `Ctrl+Maj+M`, ou tapez `/voice`.
3. Parlez : l'icône devient rouge.
4. Cliquez à nouveau pour arrêter. Le service transcrit et insère le texte.
5. Relisez, corrigez si besoin, puis envoyez.

La durée maximale (30, 60, 120 ou 300 s) se règle dans les paramètres.
L'enregistrement s'arrête automatiquement à la limite.

## Réglages

**Settings › Dictaphone** :

| Champ | Rôle |
|---|---|
| Service | `Serveur local`, `OpenAI`, ou `Compatible OpenAI` |
| URL du service | Endpoint HTTP qui reçoit l'audio |
| Modèle | Nom du modèle pour les services compatibles OpenAI |
| Langue | `fr`, `en`, … ou `auto` |
| Clé API | Stockée localement ; vide = utilise `OPENAI_API_KEY` |
| Vocabulaire / contexte | Termes techniques et noms de projets, envoyés comme contexte au moteur |
| Durée maximale | Arrêt automatique de l'enregistrement |

### Serveur local

```bash
systemctl --user status dictaphone-opencode
curl http://127.0.0.1:8178/health
journalctl --user -u dictaphone-opencode -f
```

Le modèle par défaut dépend du matériel : `large-v3-turbo` (~1,6 Go) si un GPU
NVIDIA est détecté, sinon `small` (~500 Mo). Le serveur choisit automatiquement
CUDA/float16 et retombe sur CPU/int8 en cas de problème.

```bash
./local-server/install.sh large-v3    # précision maximale sur GPU
./local-server/install.sh small       # vitesse maximale sur CPU
```

`curl http://127.0.0.1:8178/health` indique le modèle et le matériel utilisés :

```json
{"ok": true, "model": "large-v3-turbo", "device": "cuda", "compute_type": "float16"}
```

Le serveur accepte aussi les requêtes `multipart/form-data` sur `/inference`
et `/v1/audio/transcriptions`, pour les clients compatibles OpenAI.

### OpenAI

Choisissez `OpenAI`, gardez l'URL
`https://api.openai.com/v1/audio/transcriptions`, mettez votre clé dans le
champ **Clé API**, ou exportez `OPENAI_API_KEY` avant de lancer OpenCode.

### Autre serveur compatible OpenAI

Choisissez `Compatible OpenAI`, puis l'URL de votre serveur (par exemple
`http://127.0.0.1:8080/inference`). Le plugin envoie un `multipart/form-data`
avec `file`, `model`, `language` et `response_format=json`.

## Confidentialité

- En mode local, l'audio ne quitte pas la machine (OpenCode → serveur local).
- En mode OpenAI, l'audio est envoyé à l'API configurée.
- La clé API est stockée dans le stockage local d'OpenCode, pas dans le code.

## Dépannage

- **L'icône n'apparaît pas** : vérifiez la version d'OpenCode Desktop
  (≥ 2.2.7), la présence du plugin dans `opencode.json`, puis
  `~/.local/share/opencode/log/opencode.log`.
- **Microphone inaccessible** : autorisez le micro dans les réglages du
  système (*Paramètres › Son › Entrée*).
- **Erreur de transcription** : testez
  `curl http://127.0.0.1:8178/health` et
  `journalctl --user -u dictaphone-opencode -f`.
- **Le GPU n'est pas utilisé** : `/health` doit afficher `"device": "cuda"`.
  Vérifiez `nvidia-smi`, puis relancez `./local-server/install.sh` pour
  installer les bibliothèques CUDA dans l'environnement virtuel.
- **Texte vide** : parlez plus fort ou augmentez la durée ; le serveur local
  filtre les silences avec VAD.

## Développement

```bash
npm install
npm run build     # bundle GUI dans dist/gui-experimental.cjs
npm run typecheck
```

Le serveur de plugin (`src/index.ts`) et le contrat RPC (`src/rpc.ts`) sont
rechargés par OpenCode ; le bundle GUI est rechargé à chaque build.

## Licence

MIT.
