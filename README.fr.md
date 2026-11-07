# Dictaphone OpenCode

Dictée locale et hors ligne pour **OpenCode Desktop**.

Un bouton **Parler** au-dessus du composeur enregistre ta voix, la transcrit
avec [whisper.cpp](https://github.com/ggml-org/whisper.cpp) directement sur ta
machine, puis insère le texte dans le composeur. L'audio ne quitte jamais
l'ordinateur.

[English](README.md) · **Français**

## Fonctionnalités

- Entièrement local : aucun cloud, aucune clé API, aucun compte.
- whisper.cpp avec backend CUDA pour les GPU NVIDIA, ou backend CPU en secours.
- Arrêt automatique après 1,5 seconde de silence.
- Sélection du micro par son nom.
- Insertion directe de la transcription dans le composeur OpenCode.
- Commande `/voice`.
- Langue, durée de silence et durée maximale configurables.
- Les hallucinations courantes de Whisper sont filtrées avant l'insertion.

## Prérequis

- Windows 10 ou 11, 64 bits.
- [OpenCode Desktop](https://opencode.ai) (le plugin utilise l'API de l'interface
  Desktop, pas celle du terminal).
- PowerShell 5.1 ou plus récent.
- Environ 600 Mo d'espace disque pour le modèle multilingue. Le build CUDA
  ajoute environ 1,2 Go.
- Un microphone.
- Facultatif : un GPU NVIDIA et un pilote récent pour le build CUDA.

## Installation

1. Clone le dépôt :

   ```powershell
   git clone https://github.com/railboz/dictaphone-opencode.git
   cd dictaphone-opencode
   ```

2. Télécharge whisper.cpp et le modèle :

   ```powershell
   # GPU NVIDIA (recommandé)
   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Backend cuda

   # CPU uniquement
   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
   ```

   Le script installe les fichiers d'exécution dans :

   ```text
   %USERPROFILE%\.local\share\dictaphone-opencode
   ```

   Pour mettre à jour une installation existante, ferme d'abord OpenCode
   Desktop : Windows verrouille `whisper-server.exe` pendant son utilisation.

3. Déclare le plugin dans `C:\Users\<toi>\.config\opencode\opencode.json` :

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": [
       {
         "package": "C:/chemin/vers/dictaphone-opencode",
         "options": {
           "language": "fr",
           "micLabel": "HyperX",
           "vadSilenceMs": 1500,
           "vadMaxMs": 120000
         }
       }
     ]
   }
   ```

   `package` doit pointer vers le dépôt cloné. Les slashs `/` fonctionnent.
   Si tu as installé les fichiers ailleurs, ajoute
   `"root": "C:/chemin/vers/runtime"`.

4. Redémarre OpenCode Desktop, puis clique sur **Parler**.

## Utilisation

- Clique sur **Parler** (ou `Ctrl+Shift+Espace`).
- Parle : l'enregistrement s'arrête automatiquement après environ 1,5 seconde
  de silence.
- Clique à nouveau sur **Parler** pour arrêter plus tôt.
- La transcription est insérée dans le composeur ; appuie sur `Entrée` pour
  l'envoyer.
- `/voice` lance la même dictée.

## Configuration

Toutes les options sont facultatives.

| Option | Défaut | Description |
| --- | --- | --- |
| `language` | `fr` | Langue envoyée à Whisper (`fr`, `en`, `es`, ...). |
| `micLabel` | `""` | Sélectionne le premier micro dont le nom contient cette chaîne. Vide = micro par défaut du système. |
| `vad` | `true` | Mets `false` pour désactiver l'arrêt automatique au silence. |
| `vadSilenceMs` | `1500` | Durée de silence avant l'arrêt automatique, en millisecondes. |
| `vadMaxMs` | `120000` | Durée maximale d'un enregistrement, en millisecondes. |
| `vadThreshold` | `0.012` | Seuil de détection de la voix. À augmenter dans un environnement bruyant. |
| `vadMinSpeechMs` | `250` | Durée cumulée de parole requise avant que l'arrêt au silence puisse se déclencher, en millisecondes. |
| `proxyPort` | `8897` | Port du proxy local. |
| `sttPort` | `8891` | Port de whisper-server. |
| `threads` | `8` | Nombre de threads CPU passés à whisper-server. |
| `root` | `%USERPROFILE%\.local\share\dictaphone-opencode` | Dossier d'exécution contenant `bin/` et `models/`. |
| `whisperServer` | `<root>/bin/whisper-server.exe` | Chemin personnalisé de whisper-server. |
| `whisperModel` | `<root>/models/ggml-large-v3-turbo-q5_0.bin` | Chemin personnalisé du modèle. |

## Fonctionnement

1. L'interface enregistre l'audio en mono 16 kHz avec la Web Audio API.
2. Un VAD simple basé sur l'énergie arrête l'enregistrement après un silence.
3. Le WAV est envoyé à un petit proxy HTTP local démarré par `server.js`.
4. Le proxy le transmet à `whisper-server.exe`, exécuté sur CUDA ou CPU.
5. La transcription est filtrée (hallucinations courantes), puis insérée dans
   le composeur.

Le plugin préchauffe Whisper après le chargement du modèle pour que la première
vraie dictée soit rapide. CUDA compile ses noyaux à la première inférence ; le
préchauffage absorbe ce coût.

## Dépannage

**Le microphone n'est pas trouvé.** `micLabel` est une sous-chaîne du nom du
périphérique, insensible à la casse. Mets `""` pour utiliser le micro par défaut
de Windows. Autorise l'accès au microphone dans Paramètres Windows →
Confidentialité et sécurité → Microphone.

**`Ctrl+Shift+Espace` ne fait rien.** Une autre application ou un autre plugin
possède peut-être ce raccourci. Désactive-le ou modifie le `bind` dans
`gui-experimental.cjs`.

**HTTP 503 / « whisper n'est pas prêt ».** whisper-server n'a pas démarré.
Vérifie que `bin/whisper-server.exe` et
`models/ggml-large-v3-turbo-q5_0.bin` existent, puis consulte
`%USERPROFILE%\.local\state\dictaphone-opencode\debug.log`.

**La première dictée est lente.** Le backend CUDA compile ses noyaux à la
première utilisation. Le plugin envoie une requête de préchauffage au démarrage ;
les dictées suivantes sont beaucoup plus rapides.

**CUDA ne fonctionne pas.** Relance l'installateur avec `-Backend cpu`, ou mets
à jour le pilote NVIDIA. Le build CPU fonctionne sans GPU, mais il est plus lent.

**Le port est déjà utilisé.** Modifie `proxyPort` ou `sttPort` dans les options.

## Confidentialité

- L'audio est encodé en WAV en mémoire et envoyé uniquement au proxy local
  `127.0.0.1:8897`, qui le transmet à whisper-server sur `127.0.0.1:8891`.
- Aucun audio, aucune transcription et aucune télémétrie ne partent vers un
  serveur distant.
- Le script d'installation télécharge whisper.cpp depuis GitHub et le modèle
  depuis Hugging Face. La transcription en fonctionnement est hors ligne.

## Désinstallation

1. Supprime l'entrée du plugin dans `opencode.json`.
2. Supprime `%USERPROFILE%\.local\share\dictaphone-opencode`.
3. Supprime le dépôt cloné.
4. Supprime éventuellement `%USERPROFILE%\.local\state\dictaphone-opencode`.

## Licence

MIT. Voir [LICENSE](LICENSE).

whisper.cpp est distribué sous licence MIT. Les fichiers du modèle Whisper sont
publiés par le projet whisper.cpp. OpenCode est un projet séparé, non affilié à
ce plugin.

## Crédits

- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) par Georgi Gerganov et les contributeurs.
- [OpenCode](https://opencode.ai) pour l'API des plugins Desktop.
