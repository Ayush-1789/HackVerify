export type STTProvider = {
  transcribe(audio: Blob): Promise<string>;
};

function getProviderName(): string {
  return (process.env.STT_PROVIDER || 'local-whisper').toLowerCase();
}

async function readTranscription(response: Response, providerLabel: string): Promise<string> {
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`[${providerLabel}] STT request failed (${response.status}): ${body}`);
  }

  const payload = (await response.json()) as {
    text?: string;
    transcription?: string;
    result?: string;
    segments?: Array<{ no_speech_prob?: number; avg_logprob?: number }>;
  };

  const text = (payload.text || payload.transcription || payload.result || '').trim();
  const segments = Array.isArray(payload.segments) ? payload.segments : [];

  if (segments.length && isLikelySilence(segments, text)) {
    console.log(`[${providerLabel}] Detected silence/noise — returning empty string.`);
    return '';
  }

  return text;
}

function average(values: number[]): number {
  if (!values.length) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function isAcknowledgement(text: string): boolean {
  const normalized = text.trim().toLowerCase();

  if (!normalized) {
    return true;
  }

  // Only treat very short standalone filler as acknowledgement
  if (normalized.length <= 6) {
    return /^(ok|okay|yes|no|yep|nope|sure|fine)$/i.test(normalized);
  }

  return false;
}

function isLikelySilence(
  segments: Array<{ no_speech_prob?: number; avg_logprob?: number }>,
  text: string
): boolean {
  const noSpeechValues = segments.map((segment) => segment.no_speech_prob).filter((value): value is number => typeof value === 'number');
  const avgNoSpeech = average(noSpeechValues);
  const shortText = text.trim().length < 4;
  const ack = isAcknowledgement(text);

  // Only discard if we're very confident there was no speech
  if (avgNoSpeech >= 0.92) {
    return true;
  }

  // Moderate confidence + truly empty/trivial text
  if (avgNoSpeech >= 0.75 && (shortText || (ack && text.trim().length <= 4))) {
    return true;
  }

  return false;
}

/**
 * Groq Whisper: supports file, model, response_format, language, temperature.
 * Does NOT support timestamp_granularities or verbose_json with timestamps.
 */
function createGroqWhisperProvider(apiKey: string, model: string): STTProvider {
  return {
    async transcribe(audio: Blob) {
      const formData = new FormData();
      formData.append('file', audio, 'answer.webm');
      formData.append('model', model);
      formData.append('response_format', 'verbose_json');
      formData.append('language', 'en');
      formData.append('temperature', '0');

      const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`
        },
        body: formData
      });

      return readTranscription(response, 'groq-whisper');
    }
  };
}

/**
 * OpenAI Whisper: supports the full param set including timestamp_granularities.
 */
function createOpenAIWhisperProvider(apiKey: string, model: string): STTProvider {
  return {
    async transcribe(audio: Blob) {
      const formData = new FormData();
      formData.append('file', audio, 'answer.webm');
      formData.append('model', model);
      formData.append('response_format', 'verbose_json');
      formData.append('language', 'en');
      formData.append('temperature', '0');
      formData.append('timestamp_granularities[]', 'word');
      formData.append('timestamp_granularities[]', 'segment');

      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`
        },
        body: formData
      });

      return readTranscription(response, 'openai-whisper');
    }
  };
}

function createLocalSttProvider(endpoint: string): STTProvider {
  return {
    async transcribe(audio: Blob) {
      const formData = new FormData();
      formData.append('file', audio, 'answer.webm');

      const response = await fetch(endpoint, {
        method: 'POST',
        body: formData
      });

      return readTranscription(response, 'local-whisper');
    }
  };
}

export function createSTTProvider(): STTProvider {
  const provider = getProviderName();
  const activeProvider = provider === 'local-whisper' && process.env.GROQ_API_KEY ? 'groq-whisper' : provider;

  if (activeProvider === 'groq-whisper') {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new Error('GROQ_API_KEY is required when STT_PROVIDER=groq-whisper.');
    }

    return createGroqWhisperProvider(apiKey, process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3');
  }

  if (activeProvider === 'openai-whisper') {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is required when STT_PROVIDER=openai-whisper.');
    }

    return createOpenAIWhisperProvider(apiKey, process.env.OPENAI_WHISPER_MODEL || 'whisper-1');
  }

  return createLocalSttProvider(process.env.LOCAL_WHISPER_URL || 'http://localhost:11434/api/transcribe');
}