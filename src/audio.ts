export interface Recording {
  readonly stream: MediaStream
  stop(): Promise<Blob>
  cancel(): void
}

const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]

function pickMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined
  return MIME_CANDIDATES.find((type) => {
    try {
      return MediaRecorder.isTypeSupported(type)
    } catch {
      return false
    }
  })
}

export async function startRecording(): Promise<Recording> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("getUserMedia n'est pas disponible dans cette fenêtre.")
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  })

  const mimeType = pickMime()
  const recorder = mimeType
    ? new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 128_000 })
    : new MediaRecorder(stream)
  const chunks: BlobPart[] = []
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data)
  }

  let stopped: Promise<Blob> | undefined
  let stopResolve: ((blob: Blob) => void) | undefined
  let stopReject: ((error: unknown) => void) | undefined

  const cleanup = () => {
    for (const track of stream.getTracks()) track.stop()
  }

  recorder.onerror = (event) => {
    stopReject?.(event)
    cleanup()
  }
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" })
    stopResolve?.(blob)
    cleanup()
  }

  recorder.start(250)

  return {
    stream,
    stop: () => {
      if (stopped) return stopped
      stopped = new Promise<Blob>((resolve, reject) => {
        stopResolve = resolve
        stopReject = reject
        if (recorder.state === "inactive") {
          resolve(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }))
          cleanup()
        } else {
          recorder.stop()
        }
      })
      return stopped
    },
    cancel: () => {
      try {
        if (recorder.state !== "inactive") recorder.stop()
      } catch {
        // Already stopped.
      }
      cleanup()
    },
  }
}

/** Resample an arbitrary recorded blob to 16 kHz mono and return a WAV file. */
export async function toWav(blob: Blob): Promise<{ bytes: Uint8Array; duration: number }> {
  if (blob.size === 0) throw new Error("Enregistrement vide.")

  const context = new AudioContext()
  let decoded: AudioBuffer
  try {
    decoded = await context.decodeAudioData(await blob.arrayBuffer())
  } finally {
    void context.close().catch(() => undefined)
  }

  if (!Number.isFinite(decoded.duration) || decoded.duration <= 0) {
    throw new Error("Impossible de décoder l'enregistrement.")
  }

  const sampleRate = 16_000
  const frames = Math.max(1, Math.ceil(decoded.duration * sampleRate))
  const offline = new OfflineAudioContext(1, frames, sampleRate)
  const source = offline.createBufferSource()
  source.buffer = decoded
  source.connect(offline.destination)
  source.start()
  const rendered = await offline.startRendering()
  const bytes = encodeWav(rendered.getChannelData(0), sampleRate)
  return { bytes, duration: decoded.duration }
}

export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)

  const write = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++) {
      view.setUint8(offset + index, text.charCodeAt(index))
    }
  }

  write(0, "RIFF")
  view.setUint32(4, 36 + samples.length * 2, true)
  write(8, "WAVE")
  write(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, "data")
  view.setUint32(40, samples.length * 2, true)

  let offset = 44
  for (const raw of samples) {
    const sample = Math.max(-1, Math.min(1, raw))
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
    offset += 2
  }

  return new Uint8Array(buffer)
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}
