# opencode-whisper

Dictée vocale Whisper pour **OpenCode Desktop**, avec un vrai bouton
microphone dans l'en-tête de session.

![Bouton microphone dans OpenCode](docs/mic-button.png)

![Transcription insérée dans le prompt](docs/dictation.png)

*Le bouton « Dicter » dans l'en-tête, et le texte Whisper inséré dans le
prompt sans être envoyé.*

## Ce que fait le plugin

- Bouton microphone dessiné en SVG dans l'en-tête de session.
- Raccourci `Ctrl+Maj+M` (ou `Cmd+Maj+M` sur macOS) et commande `/voice`.
- Pastille d'état au-dessus du prompt : écoute, durée, transcription.
- Le texte transcrit est **inséré dans le prompt**, jamais envoyé tout seul.
- Trois moteurs : serveur Whisper local, OpenAI, ou tout endpoint compatible
  OpenAI (`whisper.cpp`, `faster-whisper`, Groq…).
- Réglages intégrés dans **Settings › Whisper dictation**.
- Audio converti en WAV 16 kHz mono avant l'envoi.
- Transcription locale en ~1 à 2 secondes pour une phrase courte (`small`).

## Comment ça marche

```text
Micro → MediaRecorder → WAV 16 kHz mono → RPC OpenCode → Whisper
                                                      ↓
                         prompt OpenCode ← texte ←────┘
```

Le plugin a deux parties : une partie GUI (bouton, capture micro, insertion
dans le prompt) et une partie serveur (appel HTTP vers Whisper). L'audio ne
transite que entre OpenCode et le service configuré.

## Performances mesurées

Sur un i9-9900K, modèle `small`, phrase française de 7,5 s :

| Étape | Temps |
|---|---|
| Enregistrement + conversion WAV | inclus dans l'interface |
| Transcription locale | **~1,1 s** |
| Insertion dans le prompt | instantanée |

Le modèle `large-v3-turbo` améliore la précision mais prend ~5 s pour la même
phrase. `small` est le compromis par défaut.

## Prérequis

- **OpenCode Desktop 2.2.7 ou plus récent** (API des plugins GUI
  `gui-experimental`).
- **Python 3.12** et [`uv`](https://docs.astral.sh/uv/) pour le serveur local.
  `uv` s'installe en une commande :
  `curl -LsSf https://astral.sh/uv/install.sh | sh`
- Facultatif : une clé API OpenAI si vous préférez le mode cloud.

> Le serveur local fourni utilise systemd (Linux). Sur macOS ou Windows,
> utilisez OpenAI ou un endpoint compatible OpenAI : le bouton microphone et
> l'insertion dans le prompt fonctionnent de la même façon.

## Installation clé en main

```bash
git clone <votre-depot>/opencode-whisper.git
cd opencode-whisper
./install.sh small
```

Le script :

1. construit le bundle GUI si `dist/` est absent ;
2. installe le serveur Whisper local dans
   `~/.local/share/opencode-whisper` et le service systemd utilisateur ;
3. ajoute le dossier du plugin à `~/.config/opencode/opencode.json`.

Redémarrez OpenCode Desktop. Le bouton **Dicter** apparaît dans l'en-tête
d'une session.

Pour utiliser uniquement OpenAI (sans serveur local) :

```bash
OPENCODE_WHISPER_SKIP_SERVER=1 ./install.sh
```

puis renseignez la clé dans **Settings › Whisper dictation**.

## Utilisation

1. Ouvrez une session.
2. Cliquez sur **Dicter**, appuyez sur `Ctrl+Maj+M`, ou tapez `/voice`.
3. Parlez : le bouton devient rouge et affiche le niveau du micro.
4. Cliquez à nouveau pour arrêter. Whisper transcrit et insère le texte.
5. Relisez, corrigez si besoin, puis envoyez.

La durée maximale (30, 60, 120 ou 300 s) se règle dans les paramètres.
L'enregistrement s'arrête automatiquement à la limite.

## Réglages

**Settings › Whisper dictation** :

| Champ | Rôle |
|---|---|
| Service | `Serveur Whisper local`, `OpenAI Whisper`, ou `Compatible OpenAI` |
| URL du service | Endpoint HTTP qui reçoit l'audio |
| Modèle | Nom du modèle pour les services compatibles OpenAI |
| Langue | `fr`, `en`, … ou `auto` |
| Clé API | Stockée localement ; vide = utilise `OPENAI_API_KEY` |
| Vocabulaire / contexte | Termes techniques, noms de projets (prompt Whisper) |
| Durée maximale | Arrêt automatique de l'enregistrement |

### Serveur local

```bash
systemctl --user status opencode-whisper
curl http://127.0.0.1:8178/health
journalctl --user -u opencode-whisper -f
```

Modèle par défaut : `small` (rapide, ~500 Mo). Pour une meilleure précision :

```bash
./local-server/install.sh large-v3-turbo
```

Le serveur accepte aussi les requêtes `multipart/form-data` sur `/inference`
et `/v1/audio/transcriptions`, pour les clients compatibles whisper.cpp/OpenAI.

### OpenAI

Choisissez `OpenAI Whisper`, gardez l'URL
`https://api.openai.com/v1/audio/transcriptions`, mettez votre clé dans le
champ **Clé API**, ou exportez `OPENAI_API_KEY` avant de lancer OpenCode.

### whisper.cpp ou autre serveur compatible

Choisissez `Compatible OpenAI`, puis l'URL de votre serveur (par exemple
`http://127.0.0.1:8080/inference`). Le plugin envoie un `multipart/form-data`
avec `file`, `model`, `language` et `response_format=json`.

## Confidentialité

- En mode local, l'audio ne quitte pas la machine (OpenCode → serveur local →
  Whisper).
- En mode OpenAI, l'audio est envoyé à l'API configurée.
- La clé API est stockée dans le stockage local d'OpenCode, pas dans le code.

## Dépannage

- **Le bouton n'apparaît pas** : vérifiez la version d'OpenCode Desktop
  (≥ 2.2.7), la présence du plugin dans `opencode.json`, puis
  `~/.local/share/opencode/log/opencode.log`.
- **Microphone inaccessible** : autorisez le micro dans les réglages du
  système (*Paramètres › Son › Entrée*).
- **Erreur de transcription** : testez
  `curl http://127.0.0.1:8178/health` et
  `journalctl --user -u opencode-whisper -f`.
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
