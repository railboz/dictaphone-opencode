import { Schema } from "effect"

export type DictaphoneService = "local" | "openai" | "custom"

export interface DictaphoneSettings {
  service: DictaphoneService
  endpoint: string
  model: string
  localModel: string
  localIdleSeconds: number
  language: string
  apiKey: string
  prompt: string
  maxSeconds: number
}

export const DictaphoneSettingsSchema = Schema.Struct({
  service: Schema.Literals(["local", "openai", "custom"]),
  endpoint: Schema.String,
  model: Schema.String,
  localModel: Schema.String,
  localIdleSeconds: Schema.Number,
  language: Schema.String,
  apiKey: Schema.String,
  prompt: Schema.String,
  maxSeconds: Schema.Number,
})

export const defaultSettings: DictaphoneSettings = {
  service: "local",
  endpoint: "",
  model: "whisper-1",
  localModel: "auto",
  localIdleSeconds: 60,
  language: "fr",
  apiKey: "",
  prompt: "OpenCode, TypeScript, Rust, Python",
  maxSeconds: 60,
}

export const serviceDefaults: Record<DictaphoneService, { endpoint: string; model: string }> = {
  local: {
    endpoint: "",
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
