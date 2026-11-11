import { Show, createEffect, createSignal } from "solid-js"
import {
  Command,
  ComposerPill,
  Plugin,
  SettingsPage,
  Store,
  type ComposerPillView,
} from "@opencode/plugin/gui"
import { Voice, type TranscribeOutput } from "./rpc"
import { startRecording, toBase64, toWav, type Recording } from "./audio.js"
import { en, fr } from "./i18n.js"
import {
  DictaphoneSettingsSchema,
  defaultSettings,
  serviceDefaults,
  type DictaphoneService,
  type DictaphoneSettings,
} from "./settings.js"

type Phase = "idle" | "recording" | "transcribing"

interface ComposerSlot {
  host: HTMLElement
  submit: HTMLElement
  form: HTMLFormElement
  editor: HTMLElement
}

interface ComposerTarget {
  form: HTMLFormElement
  editor: HTMLElement
  sessionKey: string | undefined
  range: Range | undefined
}

const definition = Plugin.define({
  stores: {
    settings: Store.global(DictaphoneSettingsSchema, defaultSettings),
  },
  i18n: { en, fr },
})

const MIC_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1"/><path d="M12 18v3"/><path d="M8 21h8"/></svg>`

const setup: Plugin.Setup<typeof definition> = (ctx) => {
  const [phase, setPhase] = createSignal<Phase>("idle")
  const [seconds, setSeconds] = createSignal(0)

  let recording: Recording | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let poll: ReturnType<typeof setInterval> | undefined
  let dictationTarget: ComposerTarget | undefined
  let startedAt = 0

  const settings = (): DictaphoneSettings => ctx.stores.settings.value as DictaphoneSettings
  const update = (patch: Partial<DictaphoneSettings>) => {
    ctx.stores.settings.update((draft) => {
      Object.assign(draft, patch)
    })
  }

  const openSettings = () => ctx.layout.settings("dictaphone")

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
    const target = captureTarget()
    if (!target) {
      ctx.toast.show({ variant: "error", title: ctx.t("errors.noSession") })
      return
    }

    dictationTarget = target
    try {
      const current = settings()
      if (current.service === "local") {
        // Warm the local engine while the user speaks: the model loads in
        // parallel with the recording, so stopping feels immediate.
        void ctx.client
          .rpc(Voice)
          .prepare({
            service: "local",
            localModel: current.localModel,
            idleSeconds: current.localIdleSeconds,
          })
          .catch(() => undefined)
      }

      const next = await startRecording()
      if (ctx.signal.aborted) {
        next.cancel()
        dictationTarget = undefined
        return
      }
      recording = next
      startedAt = Date.now()
      setSeconds(0)
      setPhase("recording")

      const limit = Math.max(5, Number(settings().maxSeconds) || 60)
      timer = setInterval(() => {
        const elapsed = (Date.now() - startedAt) / 1000
        setSeconds(Math.floor(elapsed))
        if (elapsed >= limit) void stop()
      }, 200)
    } catch (error) {
      dictationTarget = undefined
      const denied = error instanceof Error && (error.name === "NotAllowedError" || error.name === "SecurityError")
      fail(denied ? ctx.t("errors.mic", { error: "autorisation refusée" }) : ctx.t("errors.mic", { error: String(error) }), error)
    }
  }

  const stop = async () => {
    const active = recording
    if (!active || phase() !== "recording") return

    recording = undefined
    clearTimer()
    setPhase("transcribing")

    const target = dictationTarget
    dictationTarget = undefined
    try {
      const blob = await active.stop()
      if (blob.size === 0) throw new Error("L'enregistrement est vide.")

      const wav = await toWav(blob)
      if (wav.duration < 0.25) {
        ctx.toast.show({ variant: "error", title: ctx.t("errors.empty") })
        return
      }

      const current = settings()
      if (current.service !== "local" && !current.endpoint.trim()) {
        throw new Error(ctx.t("errors.noSettings"))
      }

      const result = (await ctx.client.rpc(Voice).transcribe({
        audio: toBase64(wav.bytes),
        filename: "dictation.wav",
        mimeType: "audio/wav",
        service: current.service,
        endpoint: current.endpoint.trim(),
        model: current.model.trim(),
        localModel: current.localModel,
        idleSeconds: current.localIdleSeconds,
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

      const routedKey = ctx.sessions.current()?.key
      if (!target || target.sessionKey !== routedKey) {
        ctx.toast.show({ variant: "error", title: ctx.t("errors.sessionChanged") })
        return
      }

      const composer = ctx.screen.current()?.composer
      if (composer) {
        const existing = composer.text()
        const prefix = existing.length > 0 && !/\s$/.test(existing) ? " " : ""
        const suffix = /\s$/.test(text) ? "" : " "
        composer.insert(prefix + text + suffix)
        composer.focus()
      } else if (!insertDraftText(target, text)) {
        ctx.toast.show({ variant: "error", title: ctx.t("errors.sessionChanged") })
        return
      }

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

  const button = document.createElement("button")
  button.type = "button"
  button.dataset.dictaphoneOpencode = "dictate"
  button.innerHTML = MIC_SVG
  button.style.cssText =
    "display:inline-flex;align-items:center;justify-content:center;padding:0;margin:0 4px 0 2px;border:0;border-radius:8px;background:transparent;color:inherit;cursor:pointer;flex-shrink:0;line-height:0;box-sizing:border-box;transition:background-color 120ms ease,color 120ms ease,opacity 120ms ease,box-shadow 120ms ease"

  let hovered = false
  let frame = 0
  let bootFrame = 0
  let host: HTMLElement | undefined
  let submit: HTMLElement | undefined
  let anchor: HTMLElement | undefined
  let observer: MutationObserver | undefined

  const apply = () => {
    const state = phase()
    const active = state === "recording"
    const busy = state === "transcribing"
    const keys = ctx.keybinds.keybind(`${ctx.id}.dictate`).join("+")
    const label = active ? ctx.t("button.stop") : busy ? ctx.t("pill.transcribing") : ctx.t("button.dictate")
    button.disabled = busy
    button.setAttribute("aria-label", label)
    button.setAttribute("aria-pressed", String(active))
    button.title = keys ? `${label} (${keys})` : label
    button.style.color = active ? "#ef4444" : "inherit"
    button.style.background = active
      ? "color-mix(in srgb, #ef4444 12%, transparent)"
      : hovered
        ? "color-mix(in srgb, currentColor 10%, transparent)"
        : "transparent"
    button.style.opacity = busy ? "0.55" : "1"
    button.style.cursor = busy ? "default" : "pointer"
    button.style.boxShadow = active ? "0 0 0 3px color-mix(in srgb, #ef4444 14%, transparent)" : "none"
  }

  const findComposer = (): ComposerSlot | undefined => {
    let best: (ComposerSlot & { bottom: number }) | undefined
    for (const candidate of document.querySelectorAll<HTMLElement>('[data-slot="composer-actions"]')) {
      const submitButton = candidate.querySelector<HTMLElement>('[data-action="composer-submit"]')
      if (!submitButton || candidate.getClientRects().length === 0) continue
      if (getComputedStyle(candidate).visibility === "hidden") continue
      const rect = candidate.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) continue
      const form = candidate.closest("form")
      if (!form) continue
      const editor = form.querySelector<HTMLElement>('[contenteditable="true"]')
      if (!editor || editor.getClientRects().length === 0) continue
      if (!best || rect.bottom > best.bottom) {
        best = { host: candidate, submit: submitButton, form, editor, bottom: rect.bottom }
      }
    }
    return best
  }

  const captureTarget = (): ComposerTarget | undefined => {
    const slot = findComposer()
    if (!slot) return undefined

    const selection = window.getSelection()
    let range: Range | undefined
    if (selection && selection.rangeCount > 0) {
      const candidate = selection.getRangeAt(0)
      if (slot.editor.contains(candidate.startContainer) && slot.editor.contains(candidate.endContainer)) {
        const saved = candidate.cloneRange()
        saved.collapse(false)
        range = saved
      }
    }

    return { form: slot.form, editor: slot.editor, sessionKey: ctx.sessions.current()?.key, range }
  }

  const insertDraftText = (target: ComposerTarget, text: string): boolean => {
    const editor = target.form.isConnected
      ? target.form.querySelector<HTMLElement>('[contenteditable="true"]')
      : undefined
    if (!editor) return false

    const range = target.range && editor.contains(target.range.startContainer) ? target.range : undefined
    let before = editor.innerText
    if (range) {
      const preceding = document.createRange()
      preceding.selectNodeContents(editor)
      preceding.setEnd(range.startContainer, range.startOffset)
      before = preceding.toString()
    }

    editor.focus()
    const selection = window.getSelection()
    if (selection) {
      selection.removeAllRanges()
      if (range) {
        selection.addRange(range)
      } else {
        const end = document.createRange()
        end.selectNodeContents(editor)
        end.collapse(false)
        selection.addRange(end)
      }
    }

    const prefix = before.length > 0 && !/\s$/.test(before) ? " " : ""
    const suffix = /\s$/.test(text) ? "" : " "
    const payload = prefix + text + suffix
    if (!document.execCommand("insertText", false, payload)) {
      const node = document.createTextNode(payload)
      if (range) {
        range.deleteContents()
        range.insertNode(node)
        range.setStartAfter(node)
        range.collapse(true)
        selection?.removeAllRanges()
        selection?.addRange(range)
      } else {
        editor.appendChild(node)
      }
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: payload }))
    }
    editor.focus()
    return true
  }

  const ensure = () => {
    frame = 0
    const slot = findComposer()
    if (!slot) {
      button.remove()
      host = undefined
      submit = undefined
      anchor = undefined
      return
    }
    if (
      host === slot.host &&
      submit === slot.submit &&
      anchor?.isConnected &&
      button.parentElement === host &&
      button.nextElementSibling === anchor
    ) {
      return
    }

    host = slot.host
    submit = slot.submit
    let top: HTMLElement = submit
    while (top.parentElement && top.parentElement !== host) top = top.parentElement
    if (top.parentElement !== host) {
      button.remove()
      host = undefined
      submit = undefined
      anchor = undefined
      return
    }
    anchor = top
    const size = Math.round(submit.getBoundingClientRect().height) || 28
    button.style.width = `${size}px`
    button.style.height = `${size}px`
    button.style.borderRadius = getComputedStyle(submit).borderRadius || "8px"
    if (button.parentElement !== host || button.nextElementSibling !== anchor) {
      host.insertBefore(button, anchor)
    }
    apply()
  }

  const schedule = () => {
    if (frame) return
    frame = requestAnimationFrame(ensure)
  }

  const boot = () => {
    bootFrame = 0
    if (!document.body) {
      bootFrame = requestAnimationFrame(boot)
      return
    }
    observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
    ensure()
  }
  bootFrame = requestAnimationFrame(boot)
  poll = setInterval(schedule, 500)

  button.addEventListener("click", () => void toggle())
  button.addEventListener("mouseenter", () => {
    hovered = true
    apply()
  })
  button.addEventListener("mouseleave", () => {
    hovered = false
    apply()
  })

  createEffect(() => {
    phase()
    apply()
  })

  createEffect(() => {
    ctx.sessions.current()
    ctx.screen.current()
    ensure()
  })

  const Settings = () => {
    const value = () => settings()
    return (
      <ctx.ui.SettingsLayout title={ctx.t("settings.title")} description={ctx.t("settings.description")}>
        <ctx.ui.SettingsSection title={ctx.t("settings.section.engine")}>
          <ctx.ui.SettingsRow
            id="dictaphone-service"
            title={ctx.t("settings.service")}
            description={ctx.t("settings.service.description")}
          >
            <ctx.ui.Select
              label={ctx.t("settings.service")}
              value={value().service}
              onChange={(service) => {
                const defaults = serviceDefaults[service as DictaphoneService]
                update({ service: service as DictaphoneService, endpoint: defaults.endpoint, model: defaults.model })
              }}
              options={[
                { value: "local", label: ctx.t("settings.service.local") },
                { value: "openai", label: ctx.t("settings.service.openai") },
                { value: "custom", label: ctx.t("settings.service.custom") },
              ]}
            />
          </ctx.ui.SettingsRow>

          <Show when={value().service === "local"}>
            <ctx.ui.SettingsRow
              id="dictaphone-local-model"
              title={ctx.t("settings.localModel")}
              description={ctx.t("settings.localModel.description")}
            >
              <ctx.ui.Select
                label={ctx.t("settings.localModel")}
                value={value().localModel || "auto"}
                onChange={(localModel) => update({ localModel })}
                options={[
                  { value: "auto", label: ctx.t("settings.localModel.auto") },
                  { value: "large-v3-turbo", label: "large-v3-turbo" },
                  { value: "large-v3", label: "large-v3" },
                  { value: "small", label: "small" },
                ]}
              />
            </ctx.ui.SettingsRow>

            <ctx.ui.SettingsRow
              id="dictaphone-local-idle"
              title={ctx.t("settings.localIdle")}
              description={ctx.t("settings.localIdle.description")}
            >
              <ctx.ui.Select
                label={ctx.t("settings.localIdle")}
                value={String(value().localIdleSeconds ?? 60)}
                onChange={(seconds) => update({ localIdleSeconds: Number(seconds) })}
                options={[
                  { value: "0", label: ctx.t("settings.localIdle.immediate") },
                  { value: "30", label: ctx.t("settings.seconds", { count: 30 }) },
                  { value: "60", label: ctx.t("settings.minutes", { count: 1 }) },
                  { value: "300", label: ctx.t("settings.minutes", { count: 5 }) },
                  { value: "600", label: ctx.t("settings.minutes", { count: 10 }) },
                ]}
              />
            </ctx.ui.SettingsRow>
          </Show>

          <Show when={value().service !== "local"}>
            <ctx.ui.SettingsRow
              id="dictaphone-endpoint"
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
              id="dictaphone-model"
              title={ctx.t("settings.model")}
              description={ctx.t("settings.model.description")}
            >
              <ctx.ui.TextInput
                label={ctx.t("settings.model")}
                value={value().model}
                onInput={(model) => update({ model })}
              />
            </ctx.ui.SettingsRow>
          </Show>

          <Show when={value().service !== "local"}>
            <ctx.ui.SettingsRow
              id="dictaphone-api-key"
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
            id="dictaphone-language"
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
            id="dictaphone-prompt"
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
            id="dictaphone-max-seconds"
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
    id: "dictaphone",
    icon: "waveform",
    get title() {
      return ctx.t("settings.title")
    },
    get entries() {
      const local = settings().service === "local"
      return [
        { id: "dictaphone-service", title: ctx.t("settings.service"), description: ctx.t("settings.service.description") },
        ...(local
          ? [
              {
                id: "dictaphone-local-model",
                title: ctx.t("settings.localModel"),
                description: ctx.t("settings.localModel.description"),
              },
              {
                id: "dictaphone-local-idle",
                title: ctx.t("settings.localIdle"),
                description: ctx.t("settings.localIdle.description"),
              },
            ]
          : [
              { id: "dictaphone-endpoint", title: ctx.t("settings.endpoint"), description: ctx.t("settings.endpoint.description") },
              { id: "dictaphone-model", title: ctx.t("settings.model"), description: ctx.t("settings.model.description") },
              { id: "dictaphone-api-key", title: ctx.t("settings.apiKey"), description: ctx.t("settings.apiKey.description") },
            ]),
        { id: "dictaphone-language", title: ctx.t("settings.language"), description: ctx.t("settings.language.description") },
        { id: "dictaphone-prompt", title: ctx.t("settings.prompt"), description: ctx.t("settings.prompt.description") },
        {
          id: "dictaphone-max-seconds",
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
    keywords: "voice speech microphone dictation dictee dicter micro dictaphone",
    get group() {
      return ctx.t("command.group")
    },
    section: "prompt",
    bind: "mod+shift+m",
    slash: { name: "voice" },
    enabled: phase() !== "transcribing",
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

  return () => {
    clearTimer()
    if (poll !== undefined) clearInterval(poll)
    poll = undefined
    recording?.cancel()
    recording = undefined
    dictationTarget = undefined
    observer?.disconnect()
    if (frame) cancelAnimationFrame(frame)
    if (bootFrame) cancelAnimationFrame(bootFrame)
    button.remove()
  }
}

export default Plugin.define({ ...definition, setup })
