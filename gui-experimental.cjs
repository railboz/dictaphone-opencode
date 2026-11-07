// Dictaphone OpenCode: GUI part.
//
// A mic pill above the composer. Click it, speak, and the recording stops
// automatically after a short silence. The WAV is sent to the local proxy
// started by server.js, transcribed by whisper.cpp, and the text is inserted
// into the current composer.
//
// This file is a hand-written CommonJS bundle: it needs no build step. The
// app provides @opencode/plugin/gui and solid-js at runtime.

const { Plugin, ComposerPill, Command } = require("@opencode/plugin/gui")

const SAMPLE_RATE = 16000

function portOf(value, fallback) {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback
}

// Whisper reports detected languages by full English name ("french"), while
// the `language` option uses ISO codes ("fr").
const LANGUAGE_NAMES = {
  ar: "arabic",
  cs: "czech",
  da: "danish",
  de: "german",
  el: "greek",
  en: "english",
  es: "spanish",
  fi: "finnish",
  fr: "french",
  he: "hebrew",
  hi: "hindi",
  hu: "hungarian",
  id: "indonesian",
  it: "italian",
  ja: "japanese",
  ko: "korean",
  ms: "malay",
  nl: "dutch",
  no: "norwegian",
  pl: "polish",
  pt: "portuguese",
  ro: "romanian",
  ru: "russian",
  sv: "swedish",
  th: "thai",
  tr: "turkish",
  uk: "ukrainian",
  vi: "vietnamese",
  zh: "chinese",
}

// Whisper sometimes invents these on silence or background noise.
const HALLUCINATIONS = [
  /^sous-titrage\b/i,
  /^sous-titres?\b/i,
  /radio-canada/i,
  /amara\.org/i,
  /merci d'avoir regardé/i,
  /abonnez-vous/i,
  /^vous pouvez vous abonner/i,
  /^(merci[\s.,!…]+){2,}merci[\s.,!…]*$/i,
  /^ah([\s,]+ah)+[\s.,!…]*$/i,
  /^sous-titres? (réalisés|par|de)\b/i,
  /^traduction par\b/i,
  /^ceci est un sous-titre/i,
  /^thanks? for watching\b/i,
  /^subtitles? (by|created by|provided by)\b/i,
  /^transcribed by\b/i,
  /^you can (subscribe|support)\b/i,
]

function concatChunks(chunks) {
  let total = 0
  for (const chunk of chunks) total += chunk.length
  const out = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function resampleLinear(input, from, to) {
  if (from === to) return input
  const ratio = from / to
  const length = Math.max(1, Math.floor(input.length / ratio))
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    const position = i * ratio
    const left = Math.floor(position)
    const right = Math.min(left + 1, input.length - 1)
    const mix = position - left
    out[i] = input[left] * (1 - mix) + input[right] * mix
  }
  return out
}

function writeString(view, offset, value) {
  for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
}

function encodeWav(input, sampleRate) {
  const samples = resampleLinear(input, sampleRate, SAMPLE_RATE)

  // Lift quiet microphones a little before whisper sees the clip. The cap
  // prevents amplifying room noise into speech.
  let peak = 0
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]))
  if (peak > 0.002 && peak < 0.3) {
    const gain = Math.min(8, 0.3 / peak)
    for (let i = 0; i < samples.length; i++) samples[i] *= gain
  }

  const dataLength = samples.length * 2
  const buffer = new ArrayBuffer(44 + dataLength)
  const view = new DataView(buffer)

  writeString(view, 0, "RIFF")
  view.setUint32(4, 36 + dataLength, true)
  writeString(view, 8, "WAVE")
  writeString(view, 12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(view, 36, "data")
  view.setUint32(40, dataLength, true)

  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
    offset += 2
  }

  return buffer
}

const definition = Plugin.define({
  setup(ctx) {
    const options = ctx.options ?? {}
    const proxyPort = portOf(options.proxyPort, 8897)
    const language = String(options.language ?? "fr").trim() || "fr"
    const languageKey = language.toLowerCase()
    const languageName = LANGUAGE_NAMES[languageKey]
    const acceptedLanguages = new Set([languageKey, languageName].filter(Boolean))
    const micLabel = String(options.micLabel ?? "")
    const vadEnabled = options.vad !== false
    const vadSilenceMs = Math.max(400, Number(options.vadSilenceMs ?? 1500))
    const vadMaxMs = Math.max(5_000, Number(options.vadMaxMs ?? 120_000))
    const vadMinSpeechMs = Math.max(100, Number(options.vadMinSpeechMs ?? 250))
    const vadThreshold = Math.max(0.002, Number(options.vadThreshold ?? 0.012))
    const [state, updateState] = ctx.storage.memory("dictaphone-opencode.state", {
      initial: { phase: "idle" },
    })

    // A hot reload during a recording leaves the stored phase behind even
    // though the recorder itself is gone. Start clean.
    if (state.phase !== "idle") {
      updateState((draft) => {
        draft.phase = "idle"
      })
    }

    let active = null
    let starting = false
    let disposed = false

    function setPhase(phase) {
      updateState((draft) => {
        draft.phase = phase
      })
    }

    function toast(title, message, variant = "info") {
      ctx.toast.show({ title, message, variant })
    }

    async function openMicrophone() {
      const audio = {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      }
      if (!micLabel) return navigator.mediaDevices.getUserMedia({ audio })

      const matches = (device) =>
        device.kind === "audioinput" &&
        String(device.label ?? "")
          .toLowerCase()
          .includes(micLabel.toLowerCase())

      let devices = await navigator.mediaDevices.enumerateDevices()
      let preferred = devices.find(matches)
      if (!preferred) {
        const probe = await navigator.mediaDevices.getUserMedia({ audio })
        probe.getTracks().forEach((track) => track.stop())
        devices = await navigator.mediaDevices.enumerateDevices()
        preferred = devices.find(matches)
      }
      if (preferred?.deviceId) audio.deviceId = { exact: preferred.deviceId }
      try {
        return await navigator.mediaDevices.getUserMedia({ audio })
      } catch (error) {
        // The selected device may have been unplugged since enumeration.
        if (!audio.deviceId) throw error
        toast(
          "Micro introuvable",
          "Le micro configuré est indisponible ; micro par défaut utilisé.",
          "warning",
        )
        delete audio.deviceId
        return navigator.mediaDevices.getUserMedia({ audio })
      }
    }

    async function start(screen) {
      if (starting || disposed || state.phase !== "idle") return
      if (!screen) {
        toast("Ouvre une session", "La dictée a besoin d'un composeur.", "warning")
        return
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        toast("Micro indisponible", "Ce système ne fournit pas getUserMedia.", "error")
        return
      }

      starting = true
      let stream = null
      let audioCtx = null
      try {
        stream = await openMicrophone()
        if (disposed) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }

        try {
          audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE })
        } catch {
          audioCtx = new AudioContext()
        }
        await audioCtx.resume()

        if (disposed) {
          stream.getTracks().forEach((track) => track.stop())
          await audioCtx.close().catch(() => {})
          return
        }

        const source = audioCtx.createMediaStreamSource(stream)
        const processor = audioCtx.createScriptProcessor(4096, 1, 1)
        const chunks = []
        const startedAt = performance.now()
        const vad = {
          noiseFloor: vadThreshold,
          speechMs: 0,
          silenceMs: 0,
          heardSpeech: false,
          lastAt: startedAt,
        }

        processor.onaudioprocess = (event) => {
          const data = event.inputBuffer.getChannelData(0)
          chunks.push(new Float32Array(data))

          const now = performance.now()
          const elapsed = Math.min(1000, now - vad.lastAt)
          vad.lastAt = now

          // The hard duration limit applies even when silence detection is off.
          if (now - startedAt >= vadMaxMs) {
            void stop()
            return
          }
          if (!vadEnabled) return

          // Give the microphone a moment to settle before measuring silence.
          if (now - startedAt < 400) return

          let sum = 0
          for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
          const rms = Math.sqrt(sum / data.length)

          // A quiet room lowers the floor; a noisy one keeps the configured
          // threshold so background noise is not mistaken for speech.
          if (rms < vad.noiseFloor) vad.noiseFloor = vad.noiseFloor * 0.9 + rms * 0.1
          const threshold = Math.max(0.008, Math.min(vadThreshold, vad.noiseFloor * 2))

          if (rms >= threshold) {
            vad.speechMs += elapsed
            vad.silenceMs = 0
            if (vad.speechMs >= vadMinSpeechMs) vad.heardSpeech = true
          } else {
            if (vad.heardSpeech) vad.silenceMs += elapsed
            vad.speechMs = Math.max(0, vad.speechMs - elapsed * 0.5)
          }

          if (vad.heardSpeech && vad.silenceMs >= vadSilenceMs) void stop()
        }

        // Keep the processor alive without monitoring the mic in the room.
        const mute = audioCtx.createGain()
        mute.gain.value = 0
        source.connect(processor)
        processor.connect(mute)
        mute.connect(audioCtx.destination)

        active = { stream, audioCtx, source, processor, mute, chunks, screen }
        setPhase("recording")
        toast(
          "Écoute…",
          vadEnabled
            ? "Parle : l'écoute s'arrête automatiquement après un silence."
            : "Parle, puis clique à nouveau sur le micro.",
          "info",
        )
      } catch (error) {
        try {
          active?.processor.disconnect()
        } catch {}
        try {
          active?.source.disconnect()
        } catch {}
        try {
          active?.mute.disconnect()
        } catch {}
        if (stream) {
          stream.getTracks().forEach((track) => {
            try {
              track.stop()
            } catch {}
          })
        }
        if (audioCtx) await audioCtx.close().catch(() => {})
        active = null
        toast("Micro indisponible", String(error?.message ?? error), "error")
        setPhase("idle")
      } finally {
        starting = false
      }
    }

    async function stop() {
      const recording = active
      if (!recording) return
      active = null
      recording.processor.onaudioprocess = null
      setPhase("transcribing")

      try {
        try {
          recording.processor.disconnect()
        } catch {}
        try {
          recording.source.disconnect()
        } catch {}
        try {
          recording.mute.disconnect()
        } catch {}
        recording.stream.getTracks().forEach((track) => {
          try {
            track.stop()
          } catch {}
        })

        const sampleRate = recording.audioCtx.sampleRate
        const samples = concatChunks(recording.chunks)
        await recording.audioCtx.close().catch(() => {})

        if (samples.length / sampleRate < 0.25) {
          toast("Prise trop courte", "Maintiens le micro un peu plus longtemps.", "warning")
          return
        }

        // Whisper invents subtitles on silent clips; skip them entirely.
        let peak = 0
        for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]))
        if (peak < 0.008) {
          toast("Aucune parole détectée", "Le micro n'a capté aucune voix.", "warning")
          return
        }

        const wav = encodeWav(samples, sampleRate)
        const form = new FormData()
        form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav")
        form.append("language", language)
        form.append("response_format", "verbose_json")
        form.append("temperature", "0")

        let response
        try {
          response = await fetch(`http://127.0.0.1:${proxyPort}/transcribe`, {
            method: "POST",
            body: form,
            signal: AbortSignal.timeout(400_000),
          })
        } catch (error) {
          if (error?.name === "TimeoutError" || error?.name === "AbortError") {
            throw new Error("whisper a mis trop de temps à répondre")
          }
          throw error
        }
        if (!response.ok) {
          let detail = ""
          try {
            detail = String((await response.json())?.error ?? "")
          } catch {}
          throw new Error(detail || `service local HTTP ${response.status}`)
        }
        const data = await response.json()
        if (disposed) return

        // A confident different-language detection usually means noise or
        // music, not dictation; do not insert a hallucinated sentence.
        const detected = String(data.detected_language ?? "").toLowerCase()
        const detectedProbability = Number(data.detected_language_probability ?? 0)
        if (
          languageKey !== "auto" &&
          languageName &&
          detected &&
          !acceptedLanguages.has(detected) &&
          detectedProbability >= 0.6
        ) {
          toast(
            "Aucune parole détectée",
            "La langue détectée ne correspond pas à la langue configurée.",
            "warning",
          )
          return
        }

        const text = String(data.text ?? "")
          .replace(/\[.*?\]/g, "")
          .replace(/\s+/g, " ")
          .trim()

        if (
          !text ||
          !text.replace(/[.\s…!?;:,·]+/g, "") ||
          HALLUCINATIONS.some((pattern) => pattern.test(text))
        ) {
          toast("Aucune parole détectée", "Essaie en parlant un peu plus fort.", "warning")
          return
        }

        const current = ctx.screen.current()
        const screen = current?.composer ? current : recording.screen
        if (!screen?.composer) {
          toast("Ouvre une session", "La dictée a besoin d'un composeur.", "warning")
          return
        }

        screen.composer.insert(text)
        screen.composer.focus()
        toast("Texte inséré", text.slice(0, 120), "success")
      } catch (error) {
        toast("Transcription échouée", String(error?.message ?? error), "error")
      } finally {
        if (!disposed) setPhase("idle")
      }
    }

    function toggle(screen) {
      if (state.phase === "recording") {
        void stop()
        return
      }
      if (state.phase === "idle") void start(screen)
    }

    ctx.add(ComposerPill, {
      id: "voice",
      order: 10,
      show(input) {
        const phase = state.phase
        if (phase === "recording") {
          return {
            label: "Écoute…",
            icon: "waveform",
            tone: "danger",
            title: "Arrêter et transcrire",
            run: () => void stop(),
          }
        }
        if (phase === "transcribing") {
          return {
            label: "Transcription…",
            icon: "waveform",
            title: "Transcription en cours",
          }
        }
        return {
          label: "Parler",
          icon: "outline-audio",
          title: "Dicter un prompt",
          run: () => toggle(input.screen),
        }
      },
    })

    ctx.add(Command, {
      id: "toggle",
      title: "Dicter un prompt",
      description: "Enregistre la voix et insère la transcription dans le composeur",
      slash: { name: "voice" },
      bind: "ctrl+shift+space",
      run: () => toggle(ctx.screen.current()),
    })

    return () => {
      disposed = true
      const recording = active
      active = null
      if (!recording) return
      recording.processor.onaudioprocess = null
      try {
        recording.processor.disconnect()
      } catch {}
      try {
        recording.source.disconnect()
      } catch {}
      try {
        recording.mute.disconnect()
      } catch {}
      recording.stream.getTracks().forEach((track) => {
        try {
          track.stop()
        } catch {}
      })
      void recording.audioCtx.close().catch(() => {})
    }
  },
})

module.exports = definition
module.exports.default = definition
