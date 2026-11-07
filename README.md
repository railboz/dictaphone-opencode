# Dictaphone OpenCode

Local, offline dictation for **OpenCode Desktop**.

A **Parler** pill above the composer records your voice, transcribes it with
[whisper.cpp](https://github.com/ggml-org/whisper.cpp) on your machine, and
inserts the text into the composer. Audio never leaves your computer.

**English** · [Français](README.fr.md)

> The plugin UI is currently in French (`Parler`, `Écoute…`, `Transcription…`).
> Labels live in `gui-experimental.cjs` and are easy to translate.

## Features

- Fully local: no cloud, no API key, no account.
- whisper.cpp with a CUDA build for NVIDIA GPUs, or a CPU build as fallback.
- Automatic stop after 1.5 seconds of silence.
- Device selection by microphone name.
- Inserts the transcription directly into the OpenCode composer.
- Slash command `/voice`.
- Configurable language, silence duration and maximum recording length.
- Common Whisper hallucinations are filtered before insertion.

## Requirements

- Windows 10 or 11, 64-bit.
- [OpenCode Desktop](https://opencode.ai) (the plugin uses the Desktop GUI API,
  not the terminal UI).
- PowerShell 5.1 or newer.
- About 600 MB of disk space for the multilingual model. The CUDA build adds
  about 1.2 GB.
- A microphone.
- Optional: an NVIDIA GPU and a recent driver for the CUDA build.

## Installation

1. Clone the repository:

   ```powershell
   git clone https://github.com/railboz/dictaphone-opencode.git
   cd dictaphone-opencode
   ```

2. Download whisper.cpp and the model:

   ```powershell
   # NVIDIA GPU (recommended)
   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Backend cuda

   # CPU only
   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
   ```

   The script installs the runtime files to:

   ```text
   %USERPROFILE%\.local\share\dictaphone-opencode
   ```

   When upgrading an existing install, quit OpenCode Desktop first: Windows
   locks `whisper-server.exe` while the plugin is using it.

3. Register the plugin in `C:\Users\<you>\.config\opencode\opencode.json`:

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": [
       {
         "package": "C:/path/to/dictaphone-opencode",
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

   `package` must point to the cloned repository. Forward slashes are fine.
   If you installed the runtime files elsewhere, add `"root": "C:/path/to/runtime"`.

4. Restart OpenCode Desktop and click **Parler**.

## Usage

- Click **Parler** (or press `Ctrl+Shift+Espace`).
- Speak. Recording stops automatically after about 1.5 seconds of silence.
- Click **Parler** again to stop earlier.
- The transcript is inserted into the composer; press `Enter` to send it.
- `/voice` triggers the same dictation.

## Configuration

All options are optional.

| Option | Default | Description |
| --- | --- | --- |
| `language` | `fr` | Language passed to Whisper (`fr`, `en`, `es`, ...). |
| `micLabel` | `""` | Selects the first input device whose label contains this string. Empty = system default. |
| `vad` | `true` | Set to `false` to disable automatic stop on silence. |
| `vadSilenceMs` | `1500` | Silence duration before auto-stop, in milliseconds. |
| `vadMaxMs` | `120000` | Maximum recording duration, in milliseconds. |
| `vadThreshold` | `0.012` | Voice activity threshold. Increase in a noisy room. |
| `vadMinSpeechMs` | `250` | Cumulative speech required before silence auto-stop can trigger, in milliseconds. |
| `proxyPort` | `8897` | Local proxy port. |
| `sttPort` | `8891` | whisper-server port. |
| `threads` | `8` | CPU threads passed to whisper-server. |
| `root` | `%USERPROFILE%\.local\share\dictaphone-opencode` | Runtime directory containing `bin/` and `models/`. |
| `whisperServer` | `<root>/bin/whisper-server.exe` | Custom whisper-server path. |
| `whisperModel` | `<root>/models/ggml-large-v3-turbo-q5_0.bin` | Custom model path. |

## How it works

1. The GUI records mono 16 kHz audio with the Web Audio API.
2. A simple energy-based VAD stops the recording after silence.
3. The WAV is sent to a small local HTTP proxy started by `server.js`.
4. The proxy forwards it to `whisper-server.exe`, running on CUDA or CPU.
5. The transcript is checked for common Whisper hallucinations, then inserted
   into the composer.

The plugin warms up the Whisper engine after loading the model so the first
real dictation is fast. CUDA compiles its kernels on the first inference; the
warm-up absorbs that cost.

## Troubleshooting

**The microphone is not found.** `micLabel` is a case-insensitive substring of
the device name. Set it to `""` to use the Windows default input device. Allow
microphone access in Windows Settings → Privacy & security → Microphone.

**`Ctrl+Shift+Espace` does nothing.** Another app or plugin may own the
shortcut. Disable it or change the `bind` in `gui-experimental.cjs`.

**HTTP 503 / "whisper n'est pas prêt".** whisper-server did not start. Check
that `bin/whisper-server.exe` and `models/ggml-large-v3-turbo-q5_0.bin` exist,
then read `%USERPROFILE%\.local\state\dictaphone-opencode\debug.log`.

**The first dictation is slow.** The CUDA backend compiles kernels on first
use. The plugin sends a warm-up request at startup; subsequent dictations are
much faster.

**CUDA does not work.** Re-run the installer with `-Backend cpu`, or update
your NVIDIA driver. The CPU build works without a GPU but is slower.

**Port already in use.** Change `proxyPort` or `sttPort` in the options.

## Privacy

- Audio is encoded to WAV in memory and sent only to the local proxy at
  `127.0.0.1:8897`, which forwards it to whisper-server on `127.0.0.1:8891`.
- No audio, transcript or telemetry is sent to a remote server.
- The install script downloads whisper.cpp from GitHub and the model from
  Hugging Face. Runtime transcription is offline.

## Uninstall

1. Remove the plugin entry from `opencode.json`.
2. Delete `%USERPROFILE%\.local\share\dictaphone-opencode`.
3. Delete the cloned repository.
4. Optionally remove `%USERPROFILE%\.local\state\dictaphone-opencode`.

## License

MIT. See [LICENSE](LICENSE).

whisper.cpp is distributed under the MIT license. The Whisper model files are
published by the whisper.cpp project. OpenCode is a separate project and is not
affiliated with this plugin.

## Credits

- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) by Georgi Gerganov and contributors.
- [OpenCode](https://opencode.ai) for the Desktop plugin API.
