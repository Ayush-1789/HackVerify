import type { ChatMessage } from '@/lib/types';

export type LLMCompletionInput = {
  systemPrompt: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
};

export interface LLMProvider {
  complete(input: LLMCompletionInput): Promise<string>;
}

function getProviderName(): string {
  return (process.env.LLM_PROVIDER || 'local').toLowerCase();
}

function joinMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({ role: message.role, content: message.content }));
}

async function readTextResponse(response: Response): Promise<string> {
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LLM request failed (${response.status}): ${body}`);
  }

  const payload = (await response.json()) as Record<string, unknown>;

  if (typeof payload.choices === 'object' && Array.isArray(payload.choices)) {
    const choice = payload.choices[0] as { message?: { content?: string }; text?: string } | undefined;
    return choice?.message?.content?.trim() || choice?.text?.trim() || '';
  }

  if (typeof payload.response === 'string') {
    return payload.response.trim();
  }

  if (typeof payload.text === 'string') {
    return payload.text.trim();
  }

  if (typeof payload.candidates === 'object' && Array.isArray(payload.candidates)) {
    const candidate = payload.candidates[0] as {
      content?: { parts?: Array<{ text?: string }> };
    } | undefined;
    return candidate?.content?.parts?.map((part) => part.text || '').join('').trim() || '';
  }

  return '';
}

function createOpenAIStyleProvider(baseUrl: string, apiKey: string, model: string): LLMProvider {
  return {
    async complete({ systemPrompt, messages, temperature = 0.7, maxTokens = 512 }: LLMCompletionInput) {
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          temperature,
          max_tokens: maxTokens,
          messages: [{ role: 'system', content: systemPrompt }, ...joinMessages(messages)]
        })
      });

      return readTextResponse(response);
    }
  };
}

function createGeminiProvider(apiKey: string, model: string): LLMProvider {
  return {
    async complete({ systemPrompt, messages, temperature = 0.7, maxTokens = 512 }: LLMCompletionInput) {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: {
              parts: [{ text: systemPrompt }]
            },
            generationConfig: {
              temperature,
              maxOutputTokens: maxTokens
            },
            contents: joinMessages(messages).map((message) => ({
              role: message.role === 'assistant' ? 'model' : 'user',
              parts: [{ text: message.content }]
            }))
          })
        }
      );

      return readTextResponse(response);
    }
  };
}

function createOllamaProvider(baseUrl: string, model: string): LLMProvider {
  return {
    async complete({ systemPrompt, messages, temperature = 0.7, maxTokens = 512 }: LLMCompletionInput) {
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          options: {
            temperature,
            num_predict: maxTokens
          },
          messages: [{ role: 'system', content: systemPrompt }, ...joinMessages(messages)]
        })
      });

      return readTextResponse(response);
    }
  };
}

export function createLLMProvider(): LLMProvider {
  const provider = getProviderName();
  const activeProvider = provider === 'local' && process.env.GROQ_API_KEY ? 'groq' : provider;

  if (activeProvider === 'gemini') {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is required when LLM_PROVIDER=gemini.');
    }

    return createGeminiProvider(apiKey, process.env.GEMINI_MODEL || 'gemini-1.5-flash');
  }

  if (activeProvider === 'groq') {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new Error('GROQ_API_KEY is required when LLM_PROVIDER=groq.');
    }

    return createOpenAIStyleProvider('https://api.groq.com/openai/v1', apiKey, process.env.GROQ_MODEL || 'llama-3.3-70b-versatile');
  }

  if (activeProvider === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is required when LLM_PROVIDER=openai.');
    }

    return createOpenAIStyleProvider('https://api.openai.com/v1', apiKey, process.env.OPENAI_MODEL || 'gpt-4o-mini');
  }

  return createOllamaProvider(process.env.OLLAMA_BASE_URL || 'http://localhost:11434', process.env.OLLAMA_MODEL || 'llama3.1');
}