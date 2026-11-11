import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import type { Plugin } from "@opencode/plugin"
import { Voice, type TranscribeInput, type TranscribeOutput } from "./rpc.js"

const TRANSCRIBE_TIMEOUT_MS = 120_000
const READY_TIMEOUT_MS = 180_000
const configuredIdle = Number(process.env.DICTAPHONE_IDLE_MS)
const IDLE_TIMEOUT_MS =
  Number.isFinite(configuredIdle) && configuredIdle >= 0 ? configuredIdle : 600_000

const moduleDirectory = fileURLToPath(new URL(".", import.meta.url))
const dataDirectories = Array.from(
  new Set(
    [
      join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "dictaphone-opencode"),
      join(homedir(), ".local", "share", "dictaphone-opencode"),
    ].filter(Boolean),
  ),
)

function dataFile(name: string): string | undefined {
  return firstExisting(dataDirectories.map((directory) => join(directory, name)))
}

function modelDirectory(): string {
  return (
    dataDirectories.map((directory) => join(directory, "models")).find((directory) => existsSync(directory)) ||
    join(dataDirectories[0], "models")
  )
}

function message(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") return "Délai de transcription dépassé."
    return error.message
  }
  return String(error)
}

function firstExisting(candidates: (string | undefined)[]): string | undefined {
  return candidates.find((candidate): candidate is string => !!candidate && existsSync(candidate))
}

function pythonExecutable(): string {
  const venv = process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]
  const found = firstExisting([
    process.env.DICTAPHONE_PYTHON,
    ...dataDirectories.flatMap((directory) => [
      join(directory, "venv", ...venv),
      join(directory, ".venv", ...venv),
    ]),
  ])
  if (found) return found
  throw new Error(
    "Le moteur local n'est pas installé (environnement Python absent). Lancez ./install.sh dans le dossier du plugin, ou choisissez OpenAI dans les réglages.",
  )
}

function workerScript(): string {
  const found = firstExisting([
    process.env.DICTAPHONE_ENGINE,
    join(moduleDirectory, "..", "local-server", "server.py"),
    ...dataDirectories.map((directory) => join(directory, "server.py")),
  ])
  if (found) return found
  throw new Error("Le moteur local est introuvable. Réinstallez le plugin avec ./install.sh.")
}

function installedModel(): string | undefined {
  const path = dataFile("model")
  if (!path) return undefined
  try {
    return readFileSync(path, "utf8").trim() || undefined
  } catch {
    return undefined
  }
}

function resolveModel(requested: string | undefined): string {
  const value = (requested || "").trim()
  if (value && value !== "auto") return value
  return installedModel() || "auto"
}

interface PendingRequest {
  resolve: (text: string) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * A local transcription engine started on demand and kept warm for a while.
 *
 * It talks newline-delimited JSON over stdin/stdout: no port, no HTTP server,
 * no systemd unit. The process exits after ten minutes without use and when
 * OpenCode shuts the plugin down.
 */
class LocalEngine {
  private child: ChildProcessWithoutNullStreams | undefined
  private ready: Promise<void> | undefined
  private starting: Promise<void> | undefined
  private readyResolve: (() => void) | undefined
  private readyReject: ((error: Error) => void) | undefined
  private idle: ReturnType<typeof setTimeout> | undefined
  private stderr = ""
  private sequence = 0
  private model: string | undefined
  private disposed = false
  private pending = new Map<string, PendingRequest>()

  async prepare(requested: string | undefined): Promise<void> {
    await this.ensure(resolveModel(requested))
    this.armIdle()
  }

  async transcribe(input: TranscribeInput): Promise<string> {
    if (!input.audio) throw new Error("Enregistrement audio vide.")
    await this.ensure(resolveModel(input.localModel))
    const child = this.child
    if (!child) throw new Error("Le moteur local s'est arrêté.")

    this.clearIdle()
    const id = String(++this.sequence)
    const result = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error("Délai de transcription dépassé."))
        this.armIdle()
      }, TRANSCRIBE_TIMEOUT_MS)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
    })

    try {
      child.stdin.write(
        `${JSON.stringify({
          id,
          audio: input.audio,
          filename: input.filename || "audio.wav",
          mimeType: input.mimeType || "audio/wav",
          language: input.language || "fr",
          prompt: input.prompt || "",
        })}\n`,
      )
    } catch (error) {
      const entry = this.pending.get(id)
      if (entry) {
        this.pending.delete(id)
        clearTimeout(entry.timer)
        entry.reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
    return result
  }

  stop(): void {
    this.disposed = true
    this.teardown(new Error("Le moteur local a été arrêté."))
  }

  private async ensure(model: string): Promise<void> {
    if (this.disposed) throw new Error("Le moteur local est arrêté.")
    if (this.starting) return this.starting
    if (this.child && this.ready && this.model === model) return this.ready
    if (this.child) this.teardown(new Error("Le moteur local redémarre avec un autre modèle."))
    this.starting = this.start(model).finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  private async start(model: string): Promise<void> {
    const python = pythonExecutable()
    const script = workerScript()
    this.model = model
    this.stderr = ""

    const child = spawn(
      python,
      [
        script,
        "--stdio",
        "--model",
        model,
        "--model-dir",
        modelDirectory(),
        "--device",
        "auto",
        "--beam-size",
        "5",
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
          HF_HUB_DISABLE_TELEMETRY: "1",
        },
      },
    )
    this.child = child

    const ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    this.ready = ready
    const timeout = setTimeout(() => {
      this.fail(
        new Error(
          `Le moteur local n'a pas démarré à temps.${this.stderrTail() ? ` ${this.stderrTail()}` : ""}`,
        ),
      )
    }, READY_TIMEOUT_MS)
    timeout.unref?.()
    void ready.finally(() => clearTimeout(timeout)).catch(() => undefined)

    createInterface({ input: child.stdout }).on("line", (line) => this.receive(child, line))
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      if (this.child !== child) return
      this.stderr = (this.stderr + chunk).slice(-4000)
      for (const line of chunk.split("\n")) {
        if (line.trim()) console.log(`[dictaphone] ${line.trim()}`)
      }
    })
    child.on("error", (error) => {
      if (this.child !== child) return
      this.fail(new Error(`Impossible de lancer le moteur local : ${error.message}`))
    })
    child.on("exit", (code, signal) => {
      if (this.child !== child) return
      const detail = this.stderrTail()
      this.fail(
        new Error(
          `Le moteur local s'est arrêté (${signal || code || "inconnu"}).${detail ? ` ${detail}` : ""}`,
        ),
      )
    })

    await ready
    this.armIdle()
  }

  private receive(child: ChildProcessWithoutNullStreams, line: string): void {
    if (this.child !== child) return
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }

    if (payload.type === "ready") {
      this.readyResolve?.()
      this.readyResolve = undefined
      this.readyReject = undefined
      return
    }

    const id = payload.id
    if (typeof id !== "string") return
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)

    if (payload.ok === true && typeof payload.text === "string") {
      pending.resolve(payload.text)
      this.armIdle()
      return
    }
    pending.reject(new Error(typeof payload.error === "string" ? payload.error : "Transcription échouée."))
    this.armIdle()
  }

  private stderrTail(): string {
    return this.stderr
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-3)
      .join(" ")
  }

  private fail(error: Error): void {
    const child = this.child
    this.child = undefined
    this.ready = undefined
    this.model = undefined
    this.readyReject?.(error)
    this.readyResolve = undefined
    this.readyReject = undefined
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
    if (child && !child.killed) {
      child.kill("SIGTERM")
      const force = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      }, 2000)
      force.unref?.()
    }
    this.clearIdle()
  }

  private teardown(error: Error): void {
    this.fail(error)
  }

  private armIdle(): void {
    this.clearIdle()
    if (IDLE_TIMEOUT_MS <= 0) return
    this.idle = setTimeout(() => {
      this.fail(new Error("Le moteur local a été arrêté après inactivité."))
    }, IDLE_TIMEOUT_MS)
    this.idle.unref?.()
  }

  private clearIdle(): void {
    if (this.idle !== undefined) clearTimeout(this.idle)
    this.idle = undefined
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

  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  if (signal.aborted) abort()
  else signal.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error("Transcription timeout")), TRANSCRIBE_TIMEOUT_MS)

  try {
    const response = await fetch(input.endpoint, {
      method: "POST",
      headers,
      body: form,
      signal: controller.signal,
    })
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 400)
      throw new Error(`L'API de transcription a répondu ${response.status}${detail ? ` : ${detail}` : ""}`)
    }
    return await readText(response)
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", abort)
  }
}

const plugin: Plugin.Plugin = {
  id: "dictaphone",
  async setup(ctx) {
    const engine = new LocalEngine()

    await ctx.rpc.register(Voice, {
      prepare: async (input): Promise<{ ok: boolean; error: string }> => {
        const data = input as { service?: string; localModel?: string }
        if (data.service !== "local") return { ok: true, error: "" }
        try {
          await engine.prepare(data.localModel)
          return { ok: true, error: "" }
        } catch (error) {
          return { ok: false, error: message(error) }
        }
      },
      transcribe: async (input, context): Promise<TranscribeOutput> => {
        const data = input as TranscribeInput
        try {
          if (data.service === "local") {
            return { ok: true, text: await engine.transcribe(data), error: "" }
          }
          if (!data.endpoint) throw new Error("Aucune URL de service n'est configurée.")
          return { ok: true, text: await transcribeOpenAI(data, context.signal), error: "" }
        } catch (error) {
          return { ok: false, text: "", error: message(error) }
        }
      },
    })

    return () => engine.stop()
  },
}

export default plugin
