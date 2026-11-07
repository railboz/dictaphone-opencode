// Dictaphone OpenCode: server part.
//
// - keeps a local whisper.cpp server warm for the GUI microphone pill
// - proxies the GUI's WAV upload to whisper-server with CORS
//
// The GUI part lives in gui-experimental.cjs and is the package's
// ./gui-experimental export.

import { Plugin } from "@opencode/plugin"
import { spawn } from "node:child_process"
import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const DEFAULT_ROOT = path.join(os.homedir(), ".local", "share", "dictaphone-opencode")
const LOG_DIR = path.join(os.homedir(), ".local", "state", "dictaphone-opencode")
const LOG_FILE = path.join(LOG_DIR, "debug.log")
const SERVICES_KEY = Symbol.for("dictaphone-opencode.services")

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
const TRANSCRIBE_TIMEOUT_MS = 300_000

function log(scope, message) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} [${scope}] ${message}\n`)
  } catch {
    // Diagnostics must never break the feature.
  }
}

function services() {
  return (globalThis[SERVICES_KEY] ??= {
    refs: 0,
    proxy: null,
    proxyPort: null,
    whisper: null,
    whisperPort: null,
    whisperReady: false,
    whisperStartedAt: null,
    whisperStarting: null,
  })
}

function portOf(value, fallback) {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback
}

async function isUp(url, timeout = 1200) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeout) })
    return response.ok || response.status < 500
  } catch {
    return false
  }
}

async function waitFor(url, timeoutMs = 60_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await isUp(url)) return true
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening)
      reject(error)
    }
    const onListening = () => {
      server.off("error", onError)
      resolve()
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(port, "127.0.0.1")
  })
}

function cors(res, extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...extra,
  }
}

function json(res, status, value) {
  res.writeHead(status, cors(res, { "Content-Type": "application/json; charset=utf-8" }))
  res.end(JSON.stringify(value))
}

async function handleProxy(req, res) {
  const state = services()

  if (req.method === "OPTIONS") {
    res.writeHead(204, cors(res))
    res.end()
    return
  }

  try {
    if (req.method === "GET" && req.url === "/health") {
      json(res, 200, {
        ok: true,
        whisper: state.whisperReady && state.whisperPort
          ? await isUp(`http://127.0.0.1:${state.whisperPort}/`)
          : false,
      })
      return
    }

    if (req.method === "POST" && req.url === "/transcribe") {
      // A managed whisper-server may still be loading its model; give it the
      // same budget as startup. Without a managed process, fail faster.
      const waitMs = state.whisper ? 60_000 : 15_000
      if (!state.whisperPort || !(await waitFor(`http://127.0.0.1:${state.whisperPort}/`, waitMs))) {
        json(res, 503, { error: "whisper n'est pas prêt" })
        return
      }

      const declared = Number(req.headers["content-length"] ?? 0)
      if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
        json(res, 413, { error: "audio trop volumineux" })
        return
      }

      const chunks = []
      let total = 0
      let oversized = false
      for await (const chunk of req) {
        total += chunk.length
        if (total > MAX_UPLOAD_BYTES) {
          oversized = true
          chunks.length = 0
          continue
        }
        chunks.push(chunk)
      }
      if (oversized) {
        json(res, 413, { error: "audio trop volumineux" })
        return
      }

      const body = Buffer.concat(chunks)
      const upstream = await fetch(`http://127.0.0.1:${state.whisperPort}/inference`, {
        method: "POST",
        headers: { "Content-Type": req.headers["content-type"] ?? "application/octet-stream" },
        body,
        signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
      })
      const text = await upstream.text()
      res.writeHead(
        upstream.status,
        cors(res, { "Content-Type": upstream.headers.get("content-type") ?? "application/json" }),
      )
      res.end(text)
      return
    }

    json(res, 404, { error: "not found" })
  } catch (error) {
    log("proxy", `error: ${error.message}`)
    const message =
      error.name === "TimeoutError" || error.name === "AbortError"
        ? "whisper a mis trop de temps à répondre"
        : error.message
    if (!res.headersSent) json(res, 502, { error: message })
    else {
      try {
        res.end()
      } catch {}
    }
  }
}

const proxyHandler = (req, res) => {
  void handleProxy(req, res)
}

function silentWav(seconds = 0.5) {
  const samples = Math.max(1, Math.floor(16000 * seconds))
  const dataLength = samples * 2
  const buffer = new ArrayBuffer(44 + dataLength)
  const view = new DataView(buffer)
  const write = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  write(0, "RIFF")
  view.setUint32(4, 36 + dataLength, true)
  write(8, "WAVE")
  write(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true)
  view.setUint32(28, 32000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, "data")
  view.setUint32(40, dataLength, true)
  return buffer
}

async function warmupWhisper(port, language) {
  if (typeof FormData === "undefined" || typeof Blob === "undefined") return
  const form = new FormData()
  form.append("file", new Blob([silentWav(0.5)], { type: "audio/wav" }), "warmup.wav")
  form.append("language", language)
  form.append("response_format", "json")
  form.append("temperature", "0")
  await fetch(`http://127.0.0.1:${port}/inference`, { method: "POST", body: form })
}

async function startWhisper(state, options, root) {
  // Hot reload can overlap two setups. Serialize them so whisper-server is
  // never spawned twice on the same port.
  while (state.whisperStarting) {
    await state.whisperStarting.catch(() => {})
  }
  state.whisperStarting = startWhisperOnce(state, options, root).finally(() => {
    state.whisperStarting = null
  })
  await state.whisperStarting
}

async function startWhisperOnce(state, options, root) {
  const port = portOf(options.sttPort, 8891)
  const language = String(options.language ?? "fr").trim() || "fr"
  const bin = path.resolve(options.whisperServer ?? path.join(root, "bin", "whisper-server.exe"))
  const model = path.resolve(
    options.whisperModel ?? path.join(root, "models", "ggml-large-v3-turbo-q5_0.bin"),
  )
  const url = `http://127.0.0.1:${port}/`
  const previousPort = state.whisperPort

  if (state.whisper && previousPort === port && state.whisper.exitCode == null) {
    const up = await isUp(url)
    state.whisperReady = up
    if (up) {
      log("whisper", "reusing")
      return
    }
    const age = Date.now() - Number(state.whisperStartedAt || 0)
    if (age < 60_000) {
      log("whisper", "starting")
      return
    }
    log("whisper", `startup timeout after ${Math.round(age / 1000)}s; restarting`)
  }

  if (await isUp(url)) {
    if (state.whisper) {
      try {
        state.whisper.kill()
      } catch {}
      state.whisper = null
    }
    state.whisperPort = port
    state.whisperReady = true
    log("whisper", "external server")
    return
  }

  if (state.whisper) {
    try {
      state.whisper.kill()
    } catch {}
    state.whisper = null
  }
  state.whisperPort = port
  state.whisperReady = false

  if (!fs.existsSync(bin) || !fs.existsSync(model)) {
    log("whisper", `missing binary or model: ${bin} / ${model}`)
    return
  }

  const child = spawn(
    bin,
    ["-m", model, "--host", "127.0.0.1", "--port", String(port), "-t", String(options.threads ?? 8)],
    {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    },
  )
  state.whisper = child
  state.whisperStartedAt = Date.now()
  child.stderr?.on("data", (chunk) => log("whisper", chunk.toString().trim()))
  child.on("error", (error) => {
    log("whisper", `spawn error: ${error.message}`)
    if (state.whisper === child) {
      state.whisper = null
      state.whisperStartedAt = null
      if (state.whisperPort === port) state.whisperReady = false
    }
  })
  child.on("exit", (code) => {
    log("whisper", `exited code=${code}`)
    if (state.whisper === child) {
      state.whisper = null
      state.whisperStartedAt = null
      if (state.whisperPort === port) state.whisperReady = false
    }
  })

  // Do not block plugin startup on the model load; /transcribe waits for it.
  void waitFor(url, 60_000).then((ready) => {
    if (state.whisper !== child) return
    state.whisperReady = ready
    log("whisper", `ready=${ready}`)
    if (ready) {
      void warmupWhisper(port, language)
        .then(() => log("whisper", "warmup done"))
        .catch((error) => log("whisper", `warmup failed: ${error.message}`))
    }
  })
}

export default Plugin.define({
  id: "dictaphone-opencode",
  async setup(ctx) {
    const options = ctx.options ?? {}
    const root = path.resolve(options.root ?? DEFAULT_ROOT)
    const state = services()
    state.refs++
    let stopped = false

    log("plugin", `starting refs=${state.refs} root=${root}`)

    try {
      await startWhisper(state, options, root)

      const port = portOf(options.proxyPort, 8897)
      if (state.proxy && state.proxyPort === port && state.proxy.listening) {
        // Hot reload: keep the socket and swap in the current request handler.
        state.proxy.removeAllListeners("request")
        state.proxy.on("request", proxyHandler)
        log("proxy", `reusing on ${port} with refreshed handler`)
      } else {
        if (state.proxy) {
          try {
            state.proxy.close()
          } catch {}
          state.proxy = null
          state.proxyPort = null
        }
        const server = http.createServer(proxyHandler)
        try {
          await listen(server, port)
          state.proxy = server
          state.proxyPort = port
          log("proxy", `listening on ${port}`)
        } catch (error) {
          log("proxy", `listen failed: ${error.message}`)
        }
      }
    } catch (error) {
      state.refs--
      log("plugin", `setup failed: ${error.message}`)
      throw error
    }

    return () => {
      if (stopped) return
      stopped = true
      state.refs--
      log("plugin", `stopping refs=${state.refs}`)
      if (state.refs > 0) return
      try {
        state.proxy?.close()
      } catch {}
      try {
        state.whisper?.kill()
      } catch {}
      state.proxy = null
      state.proxyPort = null
      state.whisper = null
      state.whisperReady = false
      state.whisperStartedAt = null
      state.whisperStarting = null
      delete globalThis[SERVICES_KEY]
    }
  },
})
