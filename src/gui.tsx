import { For, Show, createSignal } from "solid-js"
import {
  Command,
  ComposerPill,
  Plugin,
  SettingsPage,
  Slot,
  Store,
  type ComposerPillView,
  type SlotMap,
} from "@opencode/plugin/gui"
import { Voice, type TranscribeOutput } from "./rpc"
import { startRecording, toBase64, toWav, type Recording } from "./audio.js"
import { en, fr } from "./i18n.js"
import {
  WhisperSettingsSchema,
  defaultSettings,
  serviceDefaults,
  type WhisperService,
  type WhisperSettings,
} from "./settings.js"

type Phase = "idle" | "recording" | "transcribing"

const definition = Plugin.define({
  stores: {
    settings: Store.global(WhisperSettingsSchema, defaultSettings),
  },
  i18n: { en, fr },
})

function MicrophoneIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
      <path d="M12 18v3" />
      <path d="M8 21h8" />
    </svg>
  )
}

const setup: Plugin.Setup<typeof definition> = (ctx) => {
  const [phase, setPhase] = createSignal<Phase>("idle")
  const [level, setLevel] = createSignal(0)
  const [seconds, setSeconds] = createSignal(0)
  const [hover, setHover] = createSignal(false)

  let recording: Recording | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let startedAt = 0

  const settings = (): WhisperSettings => ctx.stores.settings.value as WhisperSettings
  const update = (patch: Partial<WhisperSettings>) => {
    ctx.stores.settings.update((draft) => {
      Object.assign(draft, patch)
    })
  }

  const openSettings = () => ctx.layout.settings("whisper")

  const fail = (title: string, error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error)
    ctx.toast.show({
      variant: "error",
      title,
      description: detail,
      duration: 8000,
      actions: [{ label: ctx.t("toast.openSettings"), run: openSettings }],
    })
  }

  const clearTimer = () => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }

  const start = async () => {
    if (phase() !== "idle") return
    if (!ctx.screen.current()?.composer) {
      ctx.toast.show({ variant: "error", title: ctx.t("errors.noSession") })
      return
    }

    try {
      const next = await startRecording()
      if (ctx.signal.aborted) {
        next.cancel()
        return
      }
      recording = next
      startedAt = Date.now()
      setSeconds(0)
      setLevel(0)
      setPhase("recording")

      const limit = Math.max(5, Number(settings().maxSeconds) || 60)
      timer = setInterval(() => {
        const elapsed = (Date.now() - startedAt) / 1000
        setSeconds(Math.floor(elapsed))
        setLevel(next.level())
        if (elapsed >= limit) void stop()
      }, 200)
    } catch (error) {
      const denied = error instanceof Error && (error.name === "NotAllowedError" || error.name === "SecurityError")
      fail(denied ? ctx.t("errors.mic", { error: "autorisation refusée" }) : ctx.t("errors.mic", { error: String(error) }), error)
    }
  }

  const stop = async () => {
    const active = recording
    if (!active || phase() !== "recording") return

    recording = undefined
    clearTimer()
    setLevel(0)
    setPhase("transcribing")

    const session = ctx.sessions.current()
    try {
      const blob = await active.stop()
      if (blob.size === 0) throw new Error("L'enregistrement est vide.")

      const wav = await toWav(blob)
      if (wav.duration < 0.25) {
        ctx.toast.show({ variant: "error", title: ctx.t("errors.empty") })
        return
      }

      const current = settings()
      if (!current.endpoint.trim()) throw new Error(ctx.t("errors.noSettings"))

      const result = (await ctx.client.rpc(Voice).transcribe({
        audio: toBase64(wav.bytes),
        filename: "dictation.wav",
        mimeType: "audio/wav",
        service: current.service,
        endpoint: current.endpoint.trim(),
        model: current.model.trim(),
        language: current.language.trim() || "fr",
        prompt: current.prompt,
        apiKey: current.apiKey,
      })) as TranscribeOutput

      if (!result.ok) throw new Error(result.error || ctx.t("errors.transcribe", { error: "inconnue" }))

      const text = result.text.trim()
      if (!text) {
        ctx.toast.show({ variant: "error", title: ctx.t("errors.empty") })
        return
      }

      const routed = ctx.sessions.current()
      if (!session || !routed || session.key !== routed.key) {
        ctx.toast.show({ variant: "error", title: ctx.t("errors.sessionChanged") })
        return
      }

      const composer = ctx.screen.current()?.composer
      if (!composer) throw new Error(ctx.t("errors.noSession"))

      const existing = composer.text()
      const prefix = existing.length > 0 && !/\s$/.test(existing) ? " " : ""
      const suffix = /\s$/.test(text) ? "" : " "
      composer.insert(prefix + text + suffix)
      composer.focus()

      ctx.toast.show({
        variant: "success",
        title: ctx.t("toast.inserted", { count: text.length }),
        duration: 2500,
      })
    } catch (error) {
      fail(ctx.t("errors.transcribe", { error: error instanceof Error ? error.message : String(error) }), error)
    } finally {
      setPhase("idle")
      setSeconds(0)
    }
  }

  const toggle = () => {
    if (phase() === "recording") void stop()
    else if (phase() === "idle") void start()
  }

  const MicButton = (props: { input: SlotMap["session.header"] }) => {
    const active = () => phase() === "recording"
    const busy = () => phase() === "transcribing"
    const compact = () => props.input.compact
    const label = () => (active() ? ctx.t("button.stop") : ctx.t("button.dictate"))
    const tooltip = () =>
      busy()
        ? ctx.t("pill.transcribing.title")
        : active()
          ? ctx.t("pill.recording.title")
          : ctx.t("command.dictate.description")

    return (
      <ctx.ui.Tooltip value={tooltip()} keys={ctx.keybinds.keybind(`${ctx.id}.dictate`)} placement="bottom">
        <button
          type="button"
          aria-label={label()}
          aria-pressed={active()}
          disabled={busy()}
          onClick={() => void toggle()}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          style={{
            display: "inline-flex",
            "align-items": "center",
            "justify-content": "center",
            gap: "6px",
            height: "26px",
            width: compact() ? "26px" : undefined,
            padding: compact() ? "0" : "0 9px",
            border: "1px solid var(--border-color, color-mix(in srgb, currentColor 18%, transparent))",
            "border-radius": "6px",
            background: active()
              ? "color-mix(in srgb, #ef4444 14%, transparent)"
              : hover()
                ? "color-mix(in srgb, currentColor 8%, transparent)"
                : "transparent",
            color: active() ? "#ef4444" : "inherit",
            "border-color": active() ? "color-mix(in srgb, #ef4444 45%, transparent)" : undefined,
            cursor: busy() ? "default" : "pointer",
            font: "inherit",
            "font-size": "12px",
            "line-height": "1",
            opacity: busy() ? "0.75" : "1",
            "flex-shrink": "0",
            transition: "background-color 120ms ease, color 120ms ease, border-color 120ms ease",
          }}
        >
          <Show when={!busy()} fallback={<ctx.ui.Loader size="small" />}>
            <MicrophoneIcon />
          </Show>
          <Show when={!compact()}>
            <span>{label()}</span>
          </Show>
          <Show when={active() && !compact()}>
            <span style={{ display: "inline-flex", "align-items": "center", gap: "1px", height: "12px" }}>
              <For each={[0.45, 0.75, 1, 0.6]}>
                {(factor) => (
                  <span
                    style={{
                      width: "2px",
                      height: `${Math.max(2, level() * 12 * factor)}px`,
                      background: "currentColor",
                      "border-radius": "1px",
                      transition: "height 80ms linear",
                    }}
                  />
                )}
              </For>
            </span>
          </Show>
        </button>
      </ctx.ui.Tooltip>
    )
  }

  const Settings = () => {
    const value = () => settings()
    return (
      <ctx.ui.SettingsLayout title={ctx.t("settings.title")} description={ctx.t("settings.description")}>
        <ctx.ui.SettingsSection title={ctx.t("settings.section.engine")}>
          <ctx.ui.SettingsRow
            id="whisper-service"
            title={ctx.t("settings.service")}
            description={ctx.t("settings.service.description")}
          >
            <ctx.ui.Select
              label={ctx.t("settings.service")}
              value={value().service}
              onChange={(service) => {
                const defaults = serviceDefaults[service as WhisperService]
                update({ service: service as WhisperService, endpoint: defaults.endpoint, model: defaults.model })
              }}
              options={[
                { value: "local", label: ctx.t("settings.service.local") },
                { value: "openai", label: ctx.t("settings.service.openai") },
                { value: "custom", label: ctx.t("settings.service.custom") },
              ]}
            />
          </ctx.ui.SettingsRow>

          <ctx.ui.SettingsRow
            id="whisper-endpoint"
            title={ctx.t("settings.endpoint")}
            description={ctx.t("settings.endpoint.description")}
          >
            <ctx.ui.TextInput
              label={ctx.t("settings.endpoint")}
              type="url"
              value={value().endpoint}
              onInput={(endpoint) => update({ endpoint })}
            />
          </ctx.ui.SettingsRow>

          <ctx.ui.SettingsRow
            id="whisper-model"
            title={ctx.t("settings.model")}
            description={ctx.t("settings.model.description")}
          >
            <ctx.ui.TextInput
              label={ctx.t("settings.model")}
              value={value().model}
              onInput={(model) => update({ model })}
            />
          </ctx.ui.SettingsRow>

          <Show when={value().service !== "local"}>
            <ctx.ui.SettingsRow
              id="whisper-api-key"
              title={ctx.t("settings.apiKey")}
              description={ctx.t("settings.apiKey.description")}
            >
              <ctx.ui.TextInput
                label={ctx.t("settings.apiKey")}
                type="password"
                value={value().apiKey}
                onInput={(apiKey) => update({ apiKey })}
              />
            </ctx.ui.SettingsRow>
          </Show>
        </ctx.ui.SettingsSection>

        <ctx.ui.SettingsSection title={ctx.t("settings.section.dictation")}>
          <ctx.ui.SettingsRow
            id="whisper-language"
            title={ctx.t("settings.language")}
            description={ctx.t("settings.language.description")}
          >
            <ctx.ui.TextInput
              label={ctx.t("settings.language")}
              value={value().language}
              placeholder="fr"
              onInput={(language) => update({ language })}
            />
          </ctx.ui.SettingsRow>

          <ctx.ui.SettingsRow
            id="whisper-prompt"
            title={ctx.t("settings.prompt")}
            description={ctx.t("settings.prompt.description")}
          >
            <ctx.ui.TextInput
              label={ctx.t("settings.prompt")}
              value={value().prompt}
              placeholder="OpenCode, TypeScript, Rust…"
              onInput={(prompt) => update({ prompt })}
            />
          </ctx.ui.SettingsRow>

          <ctx.ui.SettingsRow
            id="whisper-max-seconds"
            title={ctx.t("settings.maxSeconds")}
            description={ctx.t("settings.maxSeconds.description")}
          >
            <ctx.ui.Select
              label={ctx.t("settings.maxSeconds")}
              value={String(value().maxSeconds)}
              onChange={(seconds) => update({ maxSeconds: Number(seconds) })}
              options={[30, 60, 120, 300].map((count) => ({
                value: String(count),
                label: ctx.t("settings.seconds", { count }),
              }))}
            />
          </ctx.ui.SettingsRow>
        </ctx.ui.SettingsSection>

        <Show when={value().service === "local"}>
          <ctx.ui.SettingsSection footer={ctx.t("settings.note.local")}>
            <></>
          </ctx.ui.SettingsSection>
        </Show>
      </ctx.ui.SettingsLayout>
    )
  }

  ctx.add(SettingsPage, (): SettingsPage => ({
    id: "whisper",
    icon: "waveform",
    get title() {
      return ctx.t("settings.title")
    },
    get entries() {
      return [
        { id: "whisper-service", title: ctx.t("settings.service"), description: ctx.t("settings.service.description") },
        { id: "whisper-endpoint", title: ctx.t("settings.endpoint"), description: ctx.t("settings.endpoint.description") },
        { id: "whisper-model", title: ctx.t("settings.model"), description: ctx.t("settings.model.description") },
        { id: "whisper-api-key", title: ctx.t("settings.apiKey"), description: ctx.t("settings.apiKey.description") },
        { id: "whisper-language", title: ctx.t("settings.language"), description: ctx.t("settings.language.description") },
        { id: "whisper-prompt", title: ctx.t("settings.prompt"), description: ctx.t("settings.prompt.description") },
        {
          id: "whisper-max-seconds",
          title: ctx.t("settings.maxSeconds"),
          description: ctx.t("settings.maxSeconds.description"),
        },
      ]
    },
    render: () => <Settings />,
  }))

  ctx.add(Command, (): Command => ({
    id: "dictate",
    get title() {
      return ctx.t("command.dictate")
    },
    get description() {
      return ctx.t("command.dictate.description")
    },
    keywords: "voice speech microphone whisper dictation dictee dicter micro",
    get group() {
      return ctx.t("command.group")
    },
    section: "prompt",
    bind: "mod+shift+m",
    slash: { name: "voice" },
    enabled: phase() !== "transcribing" && !!ctx.sessions.current(),
    run: () => {
      void toggle()
    },
  }))

  ctx.add(ComposerPill, () => ({
    id: "dictation",
    order: 20,
    show: (): ComposerPillView | undefined => {
      const state = phase()
      if (state === "idle") return undefined
      if (state === "recording") {
        return {
          icon: "waveform",
          label: ctx.t("pill.recording", { seconds: seconds() }),
          tone: "danger",
          title: ctx.t("pill.recording.title"),
          run: () => void stop(),
        }
      }
      return {
        icon: "waveform",
        label: ctx.t("pill.transcribing"),
        title: ctx.t("pill.transcribing.title"),
      }
    },
  }))

  ctx.add(Slot, {
    at: "session.header",
    order: 30,
    render: (input) => <MicButton input={input} />,
  })

  return () => {
    clearTimer()
    recording?.cancel()
    recording = undefined
  }
}

export default Plugin.define({ ...definition, setup })
