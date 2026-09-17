import { readRequestBody, readRequestBodyCapped } from './common/request.js';
import { realtimeInstructions } from './openai/instructions.js';
import { GEV_REALTIME_TOOLS } from './openai/tools.js';

const STT_URL_DEFAULT = 'http://127.0.0.1:5181';
const OLLAMA_URL_DEFAULT = 'http://127.0.0.1:11434';
const MODEL_DEFAULT = 'qwen3:14b';
const CONTEXT_TOKENS_DEFAULT = 16384;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_TURN_BYTES = 512 * 1024;
const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 24_000;

// The shared instructions assume a live spoken conversation with screenshots.
// The local pipeline is transcribed push-to-talk with a text-only model.
const LOCAL_ADDENDUM = [
  'LOCAL MODE: the user speaks through push-to-talk and you receive a speech transcript, so expect small transcription slips in place names and correct them sensibly.',
  'You cannot see screenshots. Rely only on structured tool results for what is in view.',
  'Replies are read aloud by a simple speech engine: answer in one or two short plain sentences with no markdown, lists, or emoji.',
  'When a command is clear, call the tool straight away without asking for confirmation.',
].join(' ');

const TOOL_NAMES = new Set(GEV_REALTIME_TOOLS.map((tool) => tool.name));
const OLLAMA_TOOLS = GEV_REALTIME_TOOLS.map(
  ({ name, description, parameters }) => ({
    type: 'function',
    function: { name, description, parameters },
  }),
);

// Read lazily: .env is applied to process.env after this module is imported.
const config = () => ({
  enabled: String(process.env.VOICE_BACKEND || '').toLowerCase() === 'local',
  sttUrl: process.env.LOCAL_VOICE_STT_URL || STT_URL_DEFAULT,
  ollamaUrl: process.env.LOCAL_VOICE_OLLAMA_URL || OLLAMA_URL_DEFAULT,
  model: process.env.LOCAL_VOICE_MODEL || MODEL_DEFAULT,
  contextTokens:
    Number(process.env.LOCAL_VOICE_CONTEXT_TOKENS) || CONTEXT_TOKENS_DEFAULT,
});

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

async function probe(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
    return response.ok;
  } catch {
    return false;
  }
}

/** Keep only the roles and fields the local model needs; cap sizes. */
function cleanMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .slice(-MAX_MESSAGES)
    .map((message) => {
      const content = String(message?.content ?? '').slice(
        0,
        MAX_MESSAGE_CHARS,
      );
      if (message?.role === 'user') return { role: 'user', content };
      if (message?.role === 'tool' && TOOL_NAMES.has(message.tool_name))
        return { role: 'tool', tool_name: message.tool_name, content };
      if (message?.role === 'assistant') {
        const toolCalls = (message.tool_calls || [])
          .filter((call) => TOOL_NAMES.has(call?.function?.name))
          .map((call) => ({
            function: {
              name: call.function.name,
              arguments: call.function.arguments || {},
            },
          }));
        return {
          role: 'assistant',
          content,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        };
      }
      return null;
    })
    .filter(Boolean);
}

/** Drop empty optional arguments that small models tend to pad calls with. */
function cleanArguments(name, args) {
  const schema = GEV_REALTIME_TOOLS.find((tool) => tool.name === name);
  const properties = schema?.parameters?.properties || {};
  const required = new Set(schema?.parameters?.required || []);
  const cleaned = {};
  for (const [key, value] of Object.entries(args || {})) {
    if (!(key in properties)) continue;
    if (!required.has(key)) {
      if (value === null || value === '') continue;
      const minimum = properties[key]?.minimum;
      if (typeof value === 'number' && minimum !== undefined && value < minimum)
        continue;
    }
    cleaned[key] = value;
  }
  return cleaned;
}

async function chat({ messages, numPredict }) {
  const { ollamaUrl, model, contextTokens } = config();
  const response = await fetch(`${ollamaUrl}/api/chat`, {
    method: 'POST',
    signal: AbortSignal.timeout(180_000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      keep_alive: '30m',
      options: {
        num_ctx: contextTokens,
        temperature: 0.2,
        ...(numPredict ? { num_predict: numPredict } : {}),
      },
      messages: [
        {
          role: 'system',
          content: `${realtimeInstructions()} ${LOCAL_ADDENDUM}`,
        },
        ...messages,
      ],
      tools: OLLAMA_TOOLS,
    }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.error)
    throw new Error(data?.error || `Ollama HTTP ${response.status}`);
  return data;
}

async function handleStatus(_req, res) {
  const { enabled, sttUrl, ollamaUrl, model } = config();
  if (!enabled) return sendJson(res, 200, { enabled: false });
  const [stt, llm] = await Promise.all([
    probe(`${sttUrl}/health`),
    probe(`${ollamaUrl}/api/version`),
  ]);
  sendJson(res, 200, { enabled: true, stt, llm, model });
}

/** Load the model and evaluate the long system prompt once, so turns are fast. */
async function handleWarm(_req, res) {
  try {
    const started = Date.now();
    await chat({
      messages: [{ role: 'user', content: 'Hello' }],
      numPredict: 1,
    });
    sendJson(res, 200, { ok: true, elapsedMs: Date.now() - started });
  } catch (error) {
    sendJson(res, 502, { error: `Local model unavailable: ${error.message}` });
  }
}

async function handleTranscribe(req, res) {
  try {
    const audio = await readRequestBodyCapped(req, MAX_AUDIO_BYTES);
    const upstream = await fetch(`${config().sttUrl}/transcribe`, {
      method: 'POST',
      signal: AbortSignal.timeout(60_000),
      headers: { 'Content-Type': 'application/octet-stream' },
      body: audio,
    });
    const data = await upstream.json().catch(() => null);
    if (!upstream.ok)
      return sendJson(res, 502, {
        error: data?.error || `Speech-to-text HTTP ${upstream.status}`,
      });
    sendJson(res, 200, { text: String(data?.text || '') });
  } catch (error) {
    const tooLarge = error?.code === 'BODY_TOO_LARGE';
    sendJson(res, tooLarge ? 413 : 502, {
      error: tooLarge
        ? 'Recording too long'
        : `Speech-to-text unavailable: ${error.message}. Is local-voice/server.py running?`,
    });
  }
}

async function handleTurn(req, res) {
  try {
    const body = JSON.parse(await readRequestBody(req, MAX_TURN_BYTES));
    const messages = cleanMessages(body?.messages);
    if (!messages.length) return sendJson(res, 400, { error: 'No messages' });
    const data = await chat({ messages });
    const toolCalls = (data.message?.tool_calls || [])
      .filter((call) => TOOL_NAMES.has(call?.function?.name))
      .map((call) => ({
        name: call.function.name,
        arguments: cleanArguments(call.function.name, call.function.arguments),
      }));
    sendJson(res, 200, {
      content: String(data.message?.content || '').trim(),
      toolCalls,
    });
  } catch (error) {
    sendJson(res, 502, { error: `Local model failed: ${error.message}` });
  }
}

const ROUTES = {
  'GET /status': handleStatus,
  'POST /warm': handleWarm,
  'POST /transcribe': handleTranscribe,
  'POST /turn': handleTurn,
};

/**
 * Vite plugin: local voice pipeline (Whisper speech-to-text + an Ollama model).
 *
 * Opt-in with VOICE_BACKEND=local. Audio and transcripts stay on this machine.
 */
function localVoiceProxy() {
  function install(middlewares) {
    middlewares.use('/api/local-voice', (req, res) => {
      const path = (req.url || '/').split('?')[0];
      const handler = ROUTES[`${req.method} ${path}`];
      if (!handler) return sendJson(res, 404, { error: 'Not found' });
      if (path !== '/status' && !config().enabled)
        return sendJson(res, 503, { error: 'VOICE_BACKEND is not "local"' });
      return handler(req, res);
    });
  }
  return {
    name: 'local-voice-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export { localVoiceProxy };
