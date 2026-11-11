import type { Plugin } from "@opencode/plugin"
import { Voice, type TranscribeInput, type TranscribeOutput } from "./rpc.js"

const TRANSCRIBE_TIMEOUT_MS = 120_000

function message(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") return "Délai de transcription dépassé."
    return error.message
  }
  return String(error)
}

function withTimeout(signal: AbortSignal): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  if (signal.aborted) abort()
  else signal.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error("Transcription timeout")), TRANSCRIBE_TIMEOUT_MS)
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
    },
  }
}

async function readText(response: Response): Promise<string> {
  const type = response.headers.get("content-type") ?? ""
  if (type.includes("application/json")) {
    const data = (await response.json()) as Record<string, unknown>
    const text = data.text ?? data.transcription ?? data.result
    return typeof text === "string" ? text.trim() : ""
  }
  return (await response.text()).trim()
}

async function transcribeLocal(input: TranscribeInput, signal: AbortSignal): Promise<string> {
  const audio = Buffer.from(input.audio, "base64")
  if (audio.byteLength === 0) throw new Error("Enregistrement audio vide.")

  const timeout = withTimeout(signal)
  try {
    const response = await fetch(input.endpoint, {
      method: "POST",
      headers: {
        "content-type": "audio/wav",
        "x-language": input.language || "fr",
        "x-filename": input.filename || "audio.wav",
      },
      body: audio,
      signal: timeout.signal,
    })
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 400)
      throw new Error(`Le service de transcription a répondu ${response.status}${detail ? ` : ${detail}` : ""}`)
    }
    return await readText(response)
  } finally {
    timeout.clear()
  }
}

async function transcribeOpenAI(input: TranscribeInput, signal: AbortSignal): Promise<string> {
  const audio = Buffer.from(input.audio, "base64")
  if (audio.byteLength === 0) throw new Error("Enregistrement audio vide.")

  const form = new FormData()
  form.append(
    "file",
    new Blob([audio as unknown as BlobPart], { type: input.mimeType || "audio/wav" }),
    input.filename || "audio.wav",
  )
  form.append("model", input.model || "whisper-1")
  form.append("response_format", "json")
  if (input.language && input.language !== "auto") form.append("language", input.language)
  if (input.prompt.trim()) form.append("prompt", input.prompt.trim())

  const headers: Record<string, string> = {}
  const key = input.apiKey.trim() || process.env.OPENAI_API_KEY || ""
  if (key) headers.authorization = `Bearer ${key}`

  const timeout = withTimeout(signal)
  try {
    const response = await fetch(input.endpoint, {
      method: "POST",
      headers,
      body: form,
      signal: timeout.signal,
    })
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 400)
      throw new Error(`L'API de transcription a répondu ${response.status}${detail ? ` : ${detail}` : ""}`)
    }
    return await readText(response)
  } finally {
    timeout.clear()
  }
}

const plugin: Plugin.Plugin = {
  id: "dictaphone",
  async setup(ctx) {
    await ctx.rpc.register(Voice, {
      transcribe: async (input, context): Promise<TranscribeOutput> => {
        const data = input as TranscribeInput
        try {
          if (!data.endpoint) throw new Error("Aucune URL de service n'est configurée.")
          if (data.service === "local") {
            return { ok: true, text: await transcribeLocal(data, context.signal), error: "" }
          }
          return { ok: true, text: await transcribeOpenAI(data, context.signal), error: "" }
        } catch (error) {
          return { ok: false, text: "", error: message(error) }
        }
      },
    })
  },
}

export default plugin
