# Voice and Live TTS

GoodVibes has two separate voice paths:

- daemon/API voice routes for provider discovery, TTS, STT, realtime sessions, and streamed TTS
- TUI live spoken output through `/tts`, which runs a normal chat turn and plays the assistant response locally as it streams

The `/tts` command does not replace text output. The normal assistant response still appears in the TUI. `/tts` only marks that turn for additional live audio playback.

## TUI Commands

```text
/tts <prompt>
/tts stop
/config-tts
/config-tts providers
/config-tts voices [provider]
/config-tts llm
/config-tts llm clear
/config-tts provider <provider-id|clear>
/config-tts voice <voice-id|clear>
/config-tts llm-provider <provider-id|clear>
/config-tts llm-model <model-id|clear>
```

`/tts <prompt>` submits the prompt through the normal conversation path. It uses the active chat provider/model by default, unless a separate TTS response model override is configured. Assistant deltas are chunked at sentence or phrase boundaries and sent to streaming TTS in order. Audio failures are reported as non-blocking TUI status messages and do not cancel the text turn.

`/tts stop` cancels pending TTS requests, kills active playback, and clears the queued audio chunks.

`/config-tts` opens the TTS configuration modal in the TUI. From there users can choose the streaming TTS provider, choose a voice from that provider, open the shared provider-to-model picker for the TTS response model override, or clear voice/model overrides.

The modal and direct commands write the SDK TTS config keys:

- `tts.provider`
- `tts.voice`
- `tts.llmProvider`
- `tts.llmModel`

By default, `/tts` uses the active chat provider/model for text generation. If `tts.llmProvider` and `tts.llmModel` are set through `/config-tts llm`, `/config-tts llm-provider`, or `/config-tts llm-model`, `/tts` uses that configured spoken-turn model for `/tts` turns without changing the main chat model. The interactive path starts with provider selection and then shows models for that provider, using the same picker flow as the main model/provider commands.

## Playback Requirements

Live TTS playback streams audio bytes to a local player over stdin. Install one of:

- `mpv` (preferred)
- `ffplay`

If neither player is on `PATH`, `/tts` still submits and renders the normal text response, but live audio is skipped with a non-blocking status message.

## Providers and Voices

Live TTS uses voice providers that advertise the `tts-stream` capability. The TUI does not hardcode provider behavior. It asks the SDK voice service for streaming synthesis and uses the configured provider/voice defaults.

Useful discovery commands:

```text
/config-tts providers
/config-tts voices elevenlabs
```

In the TUI these open selection modals that set the chosen provider or voice. In non-interactive command contexts they print the available IDs and the direct setter command.

For ElevenLabs, configure provider credentials in the environment before starting GoodVibes:

```bash
export ELEVENLABS_API_KEY=...
# or
export XI_API_KEY=...
```

Then set the TTS defaults if desired:

```text
/config-tts provider elevenlabs
/config-tts voice <voice-id>
/config-tts llm
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

If `providerId` or `voiceId` is omitted, the daemon uses `tts.provider` and `tts.voice`. Empty config values are ignored so provider fallback still works.
