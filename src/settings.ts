import { Schema } from "effect"

export type WhisperService = "local" | "openai" | "custom"

export interface WhisperSettings {
  service: WhisperService
  endpoint: string
  model: string
  language: string
  apiKey: string
  prompt: string
  maxSeconds: number
}

export const WhisperSettingsSchema = Schema.Struct({
  service: Schema.Literals(["local", "openai", "custom"]),
  endpoint: Schema.String,
  model: Schema.String,
  language: Schema.String,
  apiKey: Schema.String,
  prompt: Schema.String,
  maxSeconds: Schema.Number,
})

export const defaultSettings: WhisperSettings = {
  service: "local",
  endpoint: "http://127.0.0.1:8178/transcribe",
  model: "whisper-1",
  language: "fr",
  apiKey: "",
  prompt: "",
  maxSeconds: 60,
}

export const serviceDefaults: Record<WhisperService, { endpoint: string; model: string }> = {
  local: {
    endpoint: "http://127.0.0.1:8178/transcribe",
    model: "whisper-1",
  },
  openai: {
    endpoint: "https://api.openai.com/v1/audio/transcriptions",
    model: "whisper-1",
  },
  custom: {
    endpoint: "http://127.0.0.1:8080/inference",
    model: "whisper-1",
  },
}
