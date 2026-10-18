import type { HttpTransport } from '../infrastructure/http';
import { joinUrl } from '../infrastructure/http';
import type { LlmClient, LlmConfig, LlmMessage, ModelMetrics } from '../types';

export const GLM_API_BASE_URL = 'https://api.z.ai/api/paas/v4';
export const OPENAI_API_BASE_URL = 'https://api.openai.com/v1';
export const DEEPSEEK_API_BASE_URL = 'https://api.deepseek.com';

interface OllamaChatResponse {
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
  done_reason?: string;
  message?: { content?: string };
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
}

interface OpenAiResponsesResponse {
  status?: string;
  incomplete_details?: { reason?: string };
  output_text?: string;
  output?: Array<{
    content?: Array<{ type?: string; text?: string }>;
  }>;
}

interface ModelsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

export class ConfigurableLlmClient implements LlmClient {
  constructor(private readonly transport: HttpTransport) {}

  async generate(messages: LlmMessage[], config: LlmConfig, onText?: (text: string) => void): Promise<string> {
    validateConfig(config);
    if (config.provider === 'ollama') {
      const modelInfo = await this.transport.request<{ remote_model?: string; remote_host?: string }>({
        signal: config.signal,
        url: joinUrl(config.baseUrl, '/api/show'),
        method: 'POST',
        body: { model: config.model },
      });
      if (modelInfo.data.remote_model || modelInfo.data.remote_host) {
        throw new Error('Облачные модели Ollama запрещены. Выберите установленную локальную модель.');
      }
      const started = performance.now();
      let firstTokenMs: number | undefined;
      const report = async (data: OllamaChatResponse): Promise<void> => {
        if (!config.onMetrics) return;
        const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
        const ms = (value: unknown): number | undefined => { const n = number(value); return n === undefined ? undefined : n / 1e6; };
        const metrics: ModelMetrics = { model: config.model, inputTokens: number(data.prompt_eval_count),
          outputTokens: number(data.eval_count), totalMs: ms(data.total_duration), loadMs: ms(data.load_duration),
          promptMs: ms(data.prompt_eval_duration), generationMs: ms(data.eval_duration), firstTokenMs };
        try {
          const snapshot = await this.transport.request<{ models?: Array<{ name?: string; model?: string; size?: number; size_vram?: number }> }>({
            url: joinUrl(config.baseUrl, '/api/ps'), signal: config.signal, timeoutMs: 3000,
          });
          const model = snapshot.data.models?.find((item) => (item.model ?? item.name) === config.model || (item.model ?? item.name) === `${config.model}:latest`);
          metrics.memoryBytes = number(model?.size);
          metrics.vramBytes = number(model?.size_vram);
        } catch { /* Optional telemetry must not discard a successful answer. */ }
        config.onMetrics(metrics);
      };
      if (onText && this.transport.requestStream) {
        let pending = '';
        let answer = '';
        let done = false;
        let finalData: OllamaChatResponse | undefined;
        const readLine = (line: string): void => {
          if (!line.trim()) return;
          const data = JSON.parse(line) as OllamaChatResponse & { error?: string; done?: boolean };
          if (data.error) throw new Error(data.error);
          if (config.requireComplete && data.done_reason === 'length') {
            throw new Error('Ответ достиг лимита длины. Заметка не изменена; увеличьте длину ответа или сократите входной текст.');
          }
          const delta = data.message?.content ?? '';
          answer += delta;
          if (delta) { firstTokenMs ??= performance.now() - started; onText(delta); }
          if (data.done) finalData = data;
          done ||= data.done === true;
        };
        await this.transport.requestStream({
          signal: config.signal,
        url: joinUrl(config.baseUrl, '/api/chat'), method: 'POST',
          body: { model: config.model, messages, stream: true, think: false,
            options: { num_predict: 4096, num_ctx: 32768, temperature: 0.2, ...config.options } },
        }, (chunk) => {
          pending += chunk;
          let newline = pending.indexOf('\n');
          while (newline >= 0) {
            readLine(pending.slice(0, newline));
            pending = pending.slice(newline + 1);
            newline = pending.indexOf('\n');
          }
        });
        readLine(pending);
        if (!done) throw new Error('Поток ответа модели прерван. Повторите запрос.');
        if (!answer.trim()) throw new Error('Локальная модель вернула пустой ответ.');
        if (finalData) await report(finalData);
        return answer.trim();
      }
      const response = await this.transport.request<OllamaChatResponse>({
        signal: config.signal,
        url: joinUrl(config.baseUrl, '/api/chat'),
        method: 'POST',
        body: { model: config.model, messages, stream: false, think: false, options: { num_predict: 4096, num_ctx: 32768, temperature: 0.2, ...config.options } },
      });
      const content = response.data.message?.content?.trim();
      if (config.requireComplete && response.data.done_reason === 'length') {
        throw new Error('Ответ достиг лимита длины. Заметка не изменена; увеличьте длину ответа или сократите входной текст.');
      }
      if (!content) throw new Error('The selected Ollama model returned an empty answer.');
      await report(response.data);
      return content;
    }

    if (config.provider === 'openai') {
      const response = await this.transport.request<OpenAiResponsesResponse>({
        url: joinUrl(config.baseUrl, '/responses'),
        method: 'POST',
        headers: authorizationHeaders(config.apiKey),
        body: {
          model: config.model,
          input: messages.map((message) => ({
            ...message,
            role: message.role === 'system' ? 'developer' : message.role,
          })),
          max_output_tokens: config.options?.num_predict ?? 1200,
          reasoning: { effort: 'none' },
          text: { verbosity: config.responseVerbosity ?? 'low' },
        },
      });
      if (config.requireComplete && response.data.status === 'incomplete') {
        throw new Error(`Ответ модели не завершён (${response.data.incomplete_details?.reason ?? 'неизвестная причина'}). Заметка не изменена.`);
      }
      const content = extractOpenAiResponseText(response.data);
      if (!content) throw new Error('The selected OpenAI model returned an empty answer.');
      return content;
    }

    const response = await this.transport.request<ChatCompletionResponse>({
      url: joinUrl(config.baseUrl, '/chat/completions'),
      method: 'POST',
      headers: authorizationHeaders(config.apiKey),
      body: {
        model: config.model,
        messages,
        stream: false,
        max_tokens: config.options?.num_predict ?? 1200,
        temperature: config.provider === 'glm' || config.provider === 'deepseek' ? 0.2 : undefined,
        thinking: config.provider === 'deepseek' ? { type: 'disabled' } : undefined,
      },
    });
    if (config.requireComplete && response.data.choices?.[0]?.finish_reason === 'length') {
      throw new Error('Ответ достиг лимита длины. Заметка не изменена; увеличьте длину ответа.');
    }
    const content = response.data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('The selected model returned an empty answer.');
    return content;
  }

  async testConnection(config: LlmConfig): Promise<void> {
    validateConfig(config);
    if (
      config.provider === 'custom' ||
      config.provider === 'glm' ||
      config.provider === 'openai' ||
      config.provider === 'deepseek'
    ) {
      await this.generate([{ role: 'user', content: 'Ответь одним словом: ОК' }], config);
      return;
    }
    const url = joinUrl(config.baseUrl, '/api/tags');
    const response = await this.transport.request<ModelsResponse>({
      url,
      headers: authorizationHeaders(config.apiKey),
    });
    const modelIds = (response.data.models ?? []).map((model) => model.model ?? model.name ?? '');
    if (modelIds.length === 0) {
      throw new Error('The provider returned no models. Check the endpoint and API key.');
    }
    if (!modelIds.some((id) => id === config.model || id.startsWith(`${config.model}:`))) {
      throw new Error(`Connection works, but model "${config.model}" was not found.`);
    }
    await this.generate([{ role: 'user', content: 'Ответь одним словом: ОК' }], config);
  }
}

function extractOpenAiResponseText(response: OpenAiResponsesResponse): string {
  if (response.output_text?.trim()) return response.output_text.trim();
  return (response.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === 'output_text' && item.text)
    .map((item) => item.text ?? '')
    .join('')
    .trim();
}

function authorizationHeaders(apiKey?: string): Record<string, string> | undefined {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
}

function validateConfig(config: LlmConfig): void {
  let url: URL;
  try {
    url = new URL(config.baseUrl);
  } catch {
    throw new Error('Enter a valid HTTP(S) model URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Enter a valid HTTP(S) model URL.');
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Адрес модели не должен содержать логин, пароль, параметры или fragment.');
  }
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  if (config.provider === 'ollama' && !loopback) {
    throw new Error('Для локальной Ollama разрешён только адрес localhost или 127.0.0.1.');
  }
  if (url.protocol !== 'https:' && !loopback) {
    throw new Error('Remote model endpoints must use HTTPS to protect API keys and note fragments.');
  }
  if (config.provider === 'glm' && normalizeUrl(config.baseUrl) !== GLM_API_BASE_URL) {
    throw new Error('Для GLM разрешён только официальный стандартный API Z.AI.');
  }
  if (config.provider === 'openai' && normalizeUrl(config.baseUrl) !== OPENAI_API_BASE_URL) {
    throw new Error('Для OpenAI разрешён только официальный API endpoint.');
  }
  if (config.provider === 'deepseek' && normalizeUrl(config.baseUrl) !== DEEPSEEK_API_BASE_URL) {
    throw new Error('Для DeepSeek разрешён только официальный API endpoint.');
  }
  if (config.provider === 'ollama' && /(?:[:-]cloud)(?:$|[:-])/i.test(config.model)) {
    throw new Error('Облачные модели Ollama запрещены. Выберите установленную локальную модель.');
  }
  if (!config.model.trim()) throw new Error('Choose or enter an LLM model.');
  if (!['ollama', 'custom'].includes(config.provider) && !config.apiKey) {
    throw new Error('Select an API key in the plugin settings.');
  }
}

function normalizeUrl(value: string): string {
  return value.replace(/\/+$/, '');
}
