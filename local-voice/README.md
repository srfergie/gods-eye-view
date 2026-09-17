# Local voice control (optional)

Runs God's Eye View voice control fully on your own machine instead of the
OpenAI Realtime API. Nothing is billed and no audio leaves the computer. It
trades the hosted model's natural conversation for push-to-talk commands.

Pipeline: microphone -> **Whisper** speech-to-text (this folder) -> an
**Ollama** model that picks an app action -> the browser reads the reply aloud.

## Requirements

- An NVIDIA GPU. Tested on an RTX 4090 (24 GB).
- Python 3.12 (`py -3.12`).
- [Ollama](https://ollama.com) with a tool-capable model pulled, e.g.
  `ollama pull qwen3:14b`.

## Run

1. Start the speech-to-text server (first run installs everything and
   downloads the Whisper model):

   ```powershell
   ./local-voice/start.ps1
   ```

2. Enable the local backend in the repo-root `.env`, then start the app:

   ```
   VOICE_BACKEND=local
   # optional overrides:
   # LOCAL_VOICE_MODEL=qwen3:14b
   # LOCAL_VOICE_STT_MODEL=large-v3-turbo
   ```

3. In the app, turn the mic on, then **hold Space** to speak and release to
   send. The first turn loads the model and is slow; later turns are fast.

Leave `VOICE_BACKEND` unset (or not `local`) to use the OpenAI Realtime voice.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `VOICE_BACKEND` | (unset) | `local` switches voice to this pipeline |
| `LOCAL_VOICE_MODEL` | `qwen3:14b` | Ollama model that chooses actions |
| `LOCAL_VOICE_STT_MODEL` | `large-v3-turbo` | Whisper model |
| `LOCAL_VOICE_STT_PORT` | `5181` | Speech-to-text server port |
| `LOCAL_VOICE_CONTEXT_TOKENS` | `16384` | Ollama context window |
