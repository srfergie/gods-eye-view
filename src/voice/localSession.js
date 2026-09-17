import {
  PUSH_TO_TALK_HOLD_DELAY_MS,
  isPushToTalkKey,
  shouldHandlePushToTalkKeyDown,
} from './realtimeInputPolicy.js';

const API = '/api/local-voice';
const MAX_TOOL_ROUNDS = 6;
const MAX_HISTORY_MESSAGES = 24;
const MAX_TOOL_RESULT_CHARS = 8000;
const MIN_RECORDING_MS = 350;

/**
 * Voice session adapter for a fully local pipeline: push-to-talk recording,
 * Whisper transcription, an Ollama model choosing actions, browser speech out.
 * Audio and transcripts never leave this machine.
 */
export function createLocalSession({
  emit,
  runAction,
  ui,
  radioLayer = null,
  fetchImpl = (...args) => fetch(...args),
}) {
  let active = false;
  let stream = null;
  let recorder = null;
  let chunks = [];
  let recordingStartedAt = 0;
  let holdTimer = null;
  let spaceHeld = false;
  let claimed = false;
  let turn = 0;
  let turnAbort = null;
  let history = [];
  let pendingMapEvent = null;
  let keyDownHandler = null;
  let keyUpHandler = null;

  const setSpeaker = (speaker) => {
    if (ui?.root) ui.root.dataset.speaker = speaker;
  };
  const ready = (detail = 'Hold Space to talk') =>
    emit({ type: 'state', state: 'listening', detail });

  async function api(path, options = {}) {
    const response = await fetchImpl(`${API}${path}`, {
      cache: 'no-store',
      ...options,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok)
      throw new Error(data?.error || `Local voice HTTP ${response.status}`);
    return data;
  }

  function speak(text) {
    const synth = window.speechSynthesis;
    if (!text || !synth) return Promise.resolve();
    return new Promise((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      const voices = synth.getVoices();
      utterance.voice =
        voices.find((voice) => voice.lang === 'en-GB') ||
        voices.find((voice) => voice.lang?.startsWith('en')) ||
        null;
      utterance.rate = 1.05;
      utterance.onend = utterance.onerror = () => resolve();
      setSpeaker('assistant');
      synth.speak(utterance);
    });
  }

  function interrupt() {
    turn++;
    turnAbort?.abort();
    turnAbort = null;
    window.speechSynthesis?.cancel();
    radioLayer?.setVoiceDucked?.(false);
  }

  // Drop the oldest whole exchanges so history never starts mid tool-call.
  function trimHistory() {
    while (history.length > MAX_HISTORY_MESSAGES) {
      const next = history.findIndex(
        (message, index) => index > 0 && message.role === 'user',
      );
      if (next < 0) break;
      history = history.slice(next);
    }
  }

  async function runTurn(text) {
    interrupt();
    const current = turn;
    const isCurrent = () => active && current === turn;
    turnAbort = new AbortController();
    const { signal } = turnAbort;
    emit({ type: 'transcript', role: 'user', text });
    emit({ type: 'state', state: 'executing', detail: text });
    const note = pendingMapEvent
      ? `\n[map event: ${JSON.stringify(pendingMapEvent)}]`
      : '';
    pendingMapEvent = null;
    history.push({ role: 'user', content: text + note });
    trimHistory();
    let radioResult = null;
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const reply = await api('/turn', {
          method: 'POST',
          signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: history }),
        });
        if (!isCurrent()) return;
        const calls = reply.toolCalls || [];
        history.push({
          role: 'assistant',
          content: reply.content || '',
          tool_calls: calls.map((call) => ({ function: call })),
        });
        if (!calls.length) {
          emit({ type: 'transcript', role: 'assistant', text: reply.content });
          if (radioResult) radioLayer?.setVoiceDucked?.(true);
          await speak(reply.content);
          break;
        }
        for (const call of calls) {
          let result;
          try {
            result = await runAction(call.name, call.arguments, {
              signal,
              isCurrent,
            });
          } catch (error) {
            if (!isCurrent()) return;
            result = { ok: false, error: error?.message || 'Action failed' };
          }
          if (result?.ok && result.radioPlaybackRequested) radioResult = result;
          history.push({
            role: 'tool',
            tool_name: call.name,
            content: JSON.stringify(result ?? null).slice(
              0,
              MAX_TOOL_RESULT_CHARS,
            ),
          });
        }
      }
      if (!isCurrent()) return;
      // Radio starts only after the spoken confirmation, as in the hosted path.
      if (radioResult) {
        await radioLayer?.playForVoice?.({ attemptId: `local-voice-${turn}` });
        radioLayer?.setVoiceDucked?.(false);
      }
      emit({ type: 'completion' });
    } catch (error) {
      if (!isCurrent() || error?.name === 'AbortError') return;
      history.push({ role: 'assistant', content: '' });
      setSpeaker('idle');
      ready(error.message);
      return;
    }
    if (isCurrent()) {
      setSpeaker('idle');
      ready();
    }
  }

  function beginRecording() {
    if (!stream || recorder) return;
    chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (event) => {
      if (event.data?.size) chunks.push(event.data);
    };
    recordingStartedAt = Date.now();
    recorder.start();
  }

  function endRecording() {
    const finished = recorder;
    recorder = null;
    if (!finished) return Promise.resolve(null);
    return new Promise((resolve) => {
      finished.onstop = () =>
        resolve(new Blob(chunks, { type: finished.mimeType }));
      finished.stop();
    });
  }

  async function finishPushToTalk() {
    const send = claimed;
    const heldMs = Date.now() - recordingStartedAt;
    claimed = false;
    const audio = await endRecording();
    for (const track of stream?.getAudioTracks() || []) track.enabled = false;
    if (!send || !active) return;
    setSpeaker('idle');
    if (!audio?.size || heldMs < MIN_RECORDING_MS) return ready();
    emit({ type: 'state', state: 'executing', detail: 'Transcribing' });
    try {
      const { text } = await api('/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: audio,
      });
      if (!active) return;
      if (!text?.trim()) return ready('Heard nothing, hold Space to talk');
      await runTurn(text.trim());
    } catch (error) {
      if (active) ready(error.message);
    }
  }

  function bindKeys() {
    keyDownHandler = (event) => {
      if (!isPushToTalkKey(event)) return;
      if (spaceHeld) {
        if (claimed) event.preventDefault();
        return;
      }
      if (!active || !shouldHandlePushToTalkKeyDown(event)) return;
      spaceHeld = true;
      // Record from the first instant so the opening word is kept, but only
      // claim the turn once the hold outlasts a native Space tap.
      for (const track of stream?.getAudioTracks() || []) track.enabled = true;
      beginRecording();
      holdTimer = setTimeout(() => {
        holdTimer = null;
        if (!spaceHeld || !active) return;
        claimed = true;
        interrupt();
        emit({ type: 'interruption' });
        setSpeaker('user');
        emit({
          type: 'state',
          state: 'listening',
          detail: 'Release Space to send',
        });
      }, PUSH_TO_TALK_HOLD_DELAY_MS);
    };
    keyUpHandler = (event) => {
      if (!isPushToTalkKey(event) || !spaceHeld) return;
      spaceHeld = false;
      clearTimeout(holdTimer);
      holdTimer = null;
      if (claimed) event.preventDefault();
      void finishPushToTalk();
    };
    window.addEventListener('keydown', keyDownHandler, true);
    window.addEventListener('keyup', keyUpHandler, true);
  }

  function unbindKeys() {
    if (keyDownHandler)
      window.removeEventListener('keydown', keyDownHandler, true);
    if (keyUpHandler) window.removeEventListener('keyup', keyUpHandler, true);
    keyDownHandler = keyUpHandler = null;
  }

  return {
    capabilities: { costControls: false, pushToTalk: true },

    async start() {
      const status = await api('/status');
      if (!status.llm)
        throw new Error('Ollama is not running. Start Ollama, then try again.');
      if (!status.stt)
        throw new Error(
          'Speech-to-text is not running. Start local-voice/start.ps1, then try again.',
        );
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      for (const track of stream.getAudioTracks()) track.enabled = false;
      active = true;
      emit({
        type: 'state',
        state: 'connecting',
        detail: `Loading ${status.model}`,
      });
      try {
        await api('/warm', { method: 'POST' });
      } catch (error) {
        this.stop();
        throw error;
      }
      if (active) ready();
    },

    stop({ removeUi = false } = {}) {
      active = false;
      interrupt();
      clearTimeout(holdTimer);
      holdTimer = null;
      spaceHeld = claimed = false;
      if (recorder?.state === 'recording') recorder.stop();
      recorder = null;
      for (const track of stream?.getTracks() || []) track.stop();
      stream = null;
      history = [];
      pendingMapEvent = null;
      setSpeaker('idle');
      if (removeUi) unbindKeys();
    },

    sendText(text) {
      const command = String(text || '').trim();
      if (!active || !command) return false;
      void runTurn(command);
      return true;
    },

    sendMapEvent(event) {
      if (active) pendingMapEvent = event;
    },

    ignoreButtonClick: () => spaceHeld,

    bindControls() {
      if (ui?.helpDetail)
        ui.helpDetail.textContent =
          'Local voice · click to switch on, then hold Space to speak';
      bindKeys();
    },
  };
}
