import type { Rpc } from "@opencode/plugin/rpc"

/**
 * Contract between the GUI and the server plugin.
 *
 * Audio is base64-encoded 16 kHz mono WAV so every backend receives the same
 * predictable format.
 *
 * The contract is a plain object (no runtime dependency) so the plugin can be
 * loaded from a clone without installing dependencies first. `satisfies` only
 * checks its shape at compile time.
 */
export const Voice = {
  id: "whisper",
  events: {},
  methods: {
    transcribe: {
      input: {
        type: "object",
        properties: {
          audio: { type: "string" },
          filename: { type: "string" },
          mimeType: { type: "string" },
          service: { type: "string", enum: ["local", "openai", "custom"] },
          endpoint: { type: "string" },
          model: { type: "string" },
          language: { type: "string" },
          prompt: { type: "string" },
          apiKey: { type: "string" },
        },
        required: [
          "audio",
          "filename",
          "mimeType",
          "service",
          "endpoint",
          "model",
          "language",
          "prompt",
          "apiKey",
        ],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          text: { type: "string" },
          error: { type: "string" },
        },
        required: ["ok", "text", "error"],
        additionalProperties: false,
      },
    },
  },
} as const satisfies Rpc.PortableDefinition

export interface TranscribeInput {
  audio: string
  filename: string
  mimeType: string
  service: "local" | "openai" | "custom"
  endpoint: string
  model: string
  language: string
  prompt: string
  apiKey: string
}

export interface TranscribeOutput {
  ok: boolean
  text: string
  error: string
}
