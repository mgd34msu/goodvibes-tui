# Voice and live TTS

GoodVibes has two separate voice paths:

- daemon/API voice routes for provider discovery, TTS, STT, realtime sessions, and streamed TTS
- TUI live spoken output through `/tts`, which runs a normal chat turn and plays the assistant response locally as it streams

The `/tts` command does not replace text output. The normal assistant response still appears in the TUI. `/tts` only marks that turn for additional live audio playback.

## TUI commands

```text
/tts <prompt>
/tts stop
/tts on
/tts off
/config tts
/config tts.provider
/config tts.voice
/config tts.llmProvider
/config tts.llmModel
/config tts.speed
```

`/tts <prompt>` submits the prompt through the normal conversation path. It uses the active chat provider/model by default, unless a separate TTS response model override is configured. Assistant deltas are chunked at sentence or phrase boundaries (a minimum of roughly 24 characters before a boundary is accepted, a hard cap around 320 characters, and a fallback flush after about a second of buffering) and sent to streaming TTS in order. Audio failures are reported as non-blocking TUI status messages and do not cancel the text turn.

Before a chunk reaches the synthesizer, markdown formatting is stripped so the voice does not read punctuation aloud. Headings, list bullets, blockquote markers, bold/italic/strikethrough markers, links (spoken as their link text), images, inline code backticks, code fences, horizontal rules, and table separator rows are all removed or unwrapped. The text response shown in the TUI is unaffected; only the audio synthesis input is cleaned up this way.

`/tts stop` cancels pending TTS requests, kills active playback, and clears the queued audio chunks.

`/tts on` enables always-speak mode. Every turn submitted to the conversation, including turns not prefixed with `/tts`, is automatically marked for live spoken output. The setting is persisted via `ui.voiceEnabled` in the TUI config. The player availability check still gates gracefully: if no player is found the turn text continues normally with a status message.

`/tts off` disables always-speak mode. After running `/tts off`, only prompts submitted with `/tts <prompt>` are spoken.

### Always-speak mode

Always-speak mode is controlled by the `ui.voiceEnabled` config key (boolean, default `false`). It is visible in both the `ui` and `tts` settings categories. The setting is labeled **Always Speak** in the UI.

```text
/config tts
```

The **Always Speak** row appears at the top of the TTS settings tab. Toggle it there or use `/tts on` / `/tts off` or `/voice enable` / `/voice disable`. All four are the same switch writing the same `ui.voiceEnabled` key.

`/config tts` opens the fullscreen configuration workspace at the TTS category. From there users can toggle always-speak mode, choose the streaming TTS provider, choose a voice from that provider, open the fullscreen provider/model workspace for the TTS response model override, clear text fields, or reset selected settings.

The modal and direct commands write the SDK TTS config keys:

- `ui.voiceEnabled`, the always-speak toggle (boolean)
- `tts.provider`
- `tts.voice`
- `tts.llmProvider`
- `tts.llmModel`
- `tts.speed`, the playback speed multiplier (see Speed section below)

By default, `/tts` uses the active chat provider/model for text generation. If `tts.llmProvider` and `tts.llmModel` are set through `/config`, `/tts` uses that configured spoken-turn model for `/tts` turns without changing the main chat model. Selecting either TTS LLM row opens the same fullscreen provider/model workspace used by the main model/provider commands, with the target route set to `TTS LLM`.

Spoken turns stay active until the logical turn reaches `TURN_COMPLETED`, `TURN_ERROR`, `TURN_CANCEL`, or `PREFLIGHT_FAIL`. SDK `STREAM_END` is provider-stream scoped and non-terminal, so tool-using or multi-step `/tts` turns must not stop audio collection just because one provider stream iteration ended.

## Speed

The SDK synthesis API (`VoiceSynthesisRequest`) accepts a `speed` field (positive number; 1.0 is normal speed). The TUI reads this from config and passes it through to the synthesis call.

`tts.speed` is visible in `/config tts` and can be adjusted with arrow keys (0.1 steps, within the supported range) or inline edit mode (Enter). The default is `1` (normal speed).

The SDK defines `tts.speed` in the config schema (default `1`, supported range 0.25–4.0), and both the settings modal and the synthesis call read it from there. The modal renders the schema descriptor like every other key, and a `readOptionalConfigNumber` helper in the SDK's spoken-turn controller module (`platform/voice/spoken-turn/controller`) reads the value on every synthesis call and passes it into `VoiceSynthesisRequest.speed`.

- The setting row is visible in `/config tts`; adjusting it takes effect on the next spoken turn.
- The TUI synthesis call passes `speed: undefined` when no value is stored, which means provider default.
- The isDefault diamond shows accurately via deepEqual against the default of `1`.

## Playback requirements

Live TTS playback streams audio bytes to a local player over stdin. Install one of:

- `mpv` (preferred)
- `ffplay`

If neither player is on `PATH`, `/tts` still submits and renders the normal text response, but live audio is skipped with a non-blocking status message.

## Providers and voices

Live TTS uses voice providers that advertise the `tts-stream` capability. The TUI does not hardcode provider behavior. It asks the SDK voice service for streaming synthesis and uses the configured provider/voice defaults.

Useful setup path:

```text
/config tts.provider
/config tts.voice
```

In the TUI these rows open selection pickers that set the chosen streaming provider or provider-specific voice.

For ElevenLabs, configure provider credentials in the environment before starting GoodVibes:

```bash
export ELEVENLABS_API_KEY=...
# or
export XI_API_KEY=...
```

Then set the TTS defaults if desired:

```text
/config tts.provider
/config tts.voice
/config tts.llmProvider
/config tts.llmModel
```

Leaving `tts.voice` empty lets the provider choose its default voice.

## Daemon API

The existing complete-response route remains unchanged:

```text
POST /api/voice/tts
```

The SDK also exposes streaming TTS:

```text
POST /api/voice/tts/stream
```

Request body:

```json
{
  "providerId": "elevenlabs",
  "text": "Text chunk to speak",
  "voiceId": "optional-provider-voice-id",
  "modelId": "optional-provider-model-id",
  "format": "mp3",
  "speed": 1,
  "metadata": {}
}
```

The response is raw binary audio, not JSON. Headers include `Content-Type`, `Cache-Control: no-store`, `X-GoodVibes-Voice-Provider`, and `X-GoodVibes-Audio-Format`.

The daemon exposes the rest of the voice surface alongside these two routes:

```text
GET  /api/voice              status: configured provider posture and capabilities
GET  /api/voice/providers    registered voice providers
GET  /api/voice/voices       registered voices for a given provider
POST /api/voice/stt          transcribe an audio artifact through a registered provider
POST /api/voice/realtime/session   open a realtime voice session through a registered provider
```

If `providerId` or `voiceId` is omitted, the daemon uses `tts.provider` and `tts.voice`. Empty config values are ignored so provider fallback still works.
