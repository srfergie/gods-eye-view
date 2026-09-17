import { createVoiceCommands as bindVoiceCommands } from './sessionCommands.js';
import { createRealtimeSession } from './realtimeSession.js';
import { createLocalSession } from './localSession.js';

// VOICE_BACKEND=local swaps the hosted Realtime session for the on-device one.
const useLocalVoice =
  String(import.meta.env?.VOICE_BACKEND || '').toLowerCase() === 'local';

/** Default composition; callers may supply another session adapter factory. */
export function createVoiceCommands(options) {
  return bindVoiceCommands({
    createSession: useLocalVoice ? createLocalSession : createRealtimeSession,
    ...options,
  });
}
