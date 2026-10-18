import { describe, expect, it } from 'vitest';
import { OllamaEmbeddingClient } from '../src/embeddings/ollama-embedding-client';
import { ConfigurableLlmClient } from '../src/llm/llm-client';
import type { HttpRequest, HttpResponse, HttpTransport } from '../src/infrastructure/http';

class FakeTransport implements HttpTransport {
  requests: HttpRequest[] = [];

  constructor(private readonly response: unknown) {}

  async request<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    this.requests.push(request);
    return { status: 200, data: this.response as T, text: JSON.stringify(this.response) };
  }
}

describe('model clients', () => {
  it('uses fixed Qwen model for Ollama embeddings', async () => {
    const transport = new FakeTransport({ embeddings: [[1, 2], [3, 4]] });
    const client = new OllamaEmbeddingClient(transport);
    await expect(client.embed(['one', 'two'])).resolves.toEqual([[1, 2], [3, 4]]);
    expect(transport.requests[0]?.body).toMatchObject({
      model: 'qwen3-embedding:0.6b',
      truncate: false,
    });
  });

  it('generates locally without an API key or reasoning output', async () => {
    const transport = new FakeTransport({ message: { content: '  Ответ  ', thinking: 'private reasoning' } });
    const client = new ConfigurableLlmClient(transport);
    await expect(client.generate([{ role: 'user', content: 'Вопрос' }], {
      provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.8:27b',
    })).resolves.toBe('Ответ');
    expect(transport.requests[1]?.url).toBe('http://127.0.0.1:11434/api/chat');
    expect(transport.requests[1]?.headers).toBeUndefined();
    expect(transport.requests[1]?.body).toMatchObject({ think: false, stream: false });
  });

  it('rejects remote Ollama URLs before sending notes', async () => {
    const transport = new FakeTransport({});
    await expect(new ConfigurableLlmClient(transport).generate([], {
      provider: 'ollama', baseUrl: 'https://example.com', model: 'qwen3.8:27b',
    })).rejects.toThrow(/локальной Ollama/);
    expect(transport.requests).toHaveLength(0);
  });

  it('checks actual generation after finding the local model', async () => {
    const transport = new FakeTransport({ models: [{ name: 'qwen3.8:27b' }], message: { content: 'ОК' } });
    await new ConfigurableLlmClient(transport).testConnection({
      provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.8:27b',
    });
    expect(transport.requests.map((request) => request.url)).toEqual([
      'http://127.0.0.1:11434/api/tags', 'http://127.0.0.1:11434/api/show', 'http://127.0.0.1:11434/api/chat',
    ]);
  });

  it('blocks cloud aliases identified by Ollama before sending messages', async () => {
    const transport = new FakeTransport({ remote_model: 'remote-qwen', remote_host: 'https://ollama.com' });
    await expect(new ConfigurableLlmClient(transport).generate([{ role: 'user', content: 'Private note' }], {
      provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'my-alias',
    })).rejects.toThrow(/Облачные модели/);
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.body).toEqual({ model: 'my-alias' });
  });

  it('streams split NDJSON content and ignores private thinking fields', async () => {
    const transport = new FakeTransport({});
    const streaming: HttpTransport = {
      request: transport.request.bind(transport),
      async requestStream(_request, onChunk) {
        onChunk('{"message":{"content":"При');
        onChunk('вет","thinking":"hidden"},"done":false}\n{"message":{"content":"!"},"done":true}');
      },
    };
    const deltas: string[] = [];
    await expect(new ConfigurableLlmClient(streaming).generate([], {
      provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.8:27b',
    }, (text) => deltas.push(text))).resolves.toBe('Привет!');
    expect(deltas).toEqual(['Привет', '!']);
  });

  it('rejects interrupted streams instead of treating partial text as a completed answer', async () => {
    const transport = new FakeTransport({});
    const streaming: HttpTransport = {
      request: transport.request.bind(transport),
      async requestStream(_request, onChunk) { onChunk('{"message":{"content":"partial"}}\n'); },
    };
    await expect(new ConfigurableLlmClient(streaming).generate([], {
      provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.8:27b',
    }, () => {})).rejects.toThrow(/прерван/);
  });

  it('rejects token-limited formatting output in streaming and regular responses', async () => {
    const config = { provider: 'ollama' as const, baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.8:27b', requireComplete: true };
    const transport = new FakeTransport({ message: { content: 'partial' }, done_reason: 'length' });
    await expect(new ConfigurableLlmClient(transport).generate([], config)).rejects.toThrow(/лимита/);
    const streaming: HttpTransport = {
      request: transport.request.bind(transport),
      async requestStream(_request, onChunk) {
        onChunk('{"message":{"content":"partial"},"done":true,"done_reason":"length"}\n');
      },
    };
    await expect(new ConfigurableLlmClient(streaming).generate([], config, () => {})).rejects.toThrow(/лимита/);
  });

  it('builds OpenAI-compatible requests without leaking configuration elsewhere', async () => {
    const transport = new FakeTransport({
      output: [{ content: [{ type: 'output_text', text: 'Answer [S1]' }] }],
    });
    const client = new ConfigurableLlmClient(transport);
    await expect(
      client.generate([{ role: 'user', content: 'Question' }], {
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1/',
        model: 'test-model',
        apiKey: 'secret',
      }),
    ).resolves.toBe('Answer [S1]');
    expect(transport.requests[0]).toMatchObject({
      url: 'https://api.openai.com/v1/responses',
      headers: { Authorization: 'Bearer secret' },
      body: {
        model: 'test-model',
        max_output_tokens: 1200,
        reasoning: { effort: 'none' },
        text: { verbosity: 'low' },
      },
    });
  });

  it('honors a longer complete cloud response and rejects truncation', async () => {
    const transport = new FakeTransport({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: 'часть' });
    const client = new ConfigurableLlmClient(transport);
    await expect(client.generate([], { provider: 'openai', baseUrl: 'https://api.openai.com/v1',
      model: 'test-model', apiKey: 'secret', requireComplete: true, responseVerbosity: 'medium',
      options: { num_predict: 4096 } })).rejects.toThrow(/не завершён/);
    expect(transport.requests[0]?.body).toMatchObject({ max_output_tokens: 4096, text: { verbosity: 'medium' } });
    const completion = new FakeTransport({ choices: [{ message: { content: 'часть' }, finish_reason: 'length' }] });
    await expect(new ConfigurableLlmClient(completion).generate([], { provider: 'custom', baseUrl: 'https://example.com',
      model: 'test-model', requireComplete: true, options: { num_predict: 4096 } })).rejects.toThrow(/лимита/);
    expect(completion.requests[0]?.body).toMatchObject({ max_tokens: 4096 });
  });

  it('rejects arbitrary endpoints before sending the OpenAI key', async () => {
    const transport = new FakeTransport({});
    const client = new ConfigurableLlmClient(transport);
    await expect(
      client.generate([], {
        provider: 'openai',
        baseUrl: 'https://example.com/v1',
        model: 'gpt-5.4-mini-2026-03-17',
        apiKey: 'secret',
      }),
    ).rejects.toThrow(/OpenAI/);
    expect(transport.requests).toEqual([]);
  });

  it('requires a key for remote providers', async () => {
    const client = new ConfigurableLlmClient(new FakeTransport({}));
    await expect(
      client.generate([], {
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-flash',
      }),
    ).rejects.toThrow(/API key/i);
  });

  it('uses the official DeepSeek Chat Completions API with thinking disabled', async () => {
    const transport = new FakeTransport({ choices: [{ message: { content: 'Ответ [S1]' } }] });
    const client = new ConfigurableLlmClient(transport);
    await expect(
      client.generate([{ role: 'user', content: 'Вопрос' }], {
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-flash',
        apiKey: 'secret',
      }),
    ).resolves.toBe('Ответ [S1]');
    expect(transport.requests[0]).toMatchObject({
      url: 'https://api.deepseek.com/chat/completions',
      method: 'POST',
      headers: { Authorization: 'Bearer secret' },
      body: {
        model: 'deepseek-flash',
        stream: false,
        max_tokens: 1200,
        temperature: 0.2,
        thinking: { type: 'disabled' },
      },
    });
  });

  it('rejects arbitrary endpoints before sending the DeepSeek key', async () => {
    const transport = new FakeTransport({});
    const client = new ConfigurableLlmClient(transport);
    await expect(
      client.generate([], {
        provider: 'deepseek',
        baseUrl: 'https://example.com',
        model: 'deepseek-flash',
        apiKey: 'secret',
      }),
    ).rejects.toThrow(/DeepSeek/);
    expect(transport.requests).toEqual([]);
  });

  it('sends GLM requests only to the standard Z.AI API', async () => {
    const transport = new FakeTransport({ choices: [{ message: { content: 'Ответ [S1]' } }] });
    const client = new ConfigurableLlmClient(transport);
    await expect(
      client.generate([{ role: 'user', content: 'Вопрос' }], {
        provider: 'glm',
        baseUrl: 'https://api.z.ai/api/paas/v4',
        model: 'glm-5.3',
        apiKey: 'secret',
      }),
    ).resolves.toBe('Ответ [S1]');
    expect(transport.requests[0]).toMatchObject({
      url: 'https://api.z.ai/api/paas/v4/chat/completions',
      headers: { Authorization: 'Bearer secret' },
      body: {
        model: 'glm-5.3',
        stream: false,
        max_tokens: 1200,
        temperature: 0.2,
      },
    });
  });

  it('rejects coding-plan and arbitrary endpoints before sending the GLM token', async () => {
    const transport = new FakeTransport({});
    const client = new ConfigurableLlmClient(transport);
    for (const baseUrl of [
      'https://api.z.ai/api/coding/paas/v4',
      'https://example.com/v4',
      'https://api.z.ai/api/paas/v4?redirect=example.com',
    ]) {
      await expect(
        client.generate([], {
          provider: 'glm',
          baseUrl,
          model: 'glm-5.3',
          apiKey: 'secret',
        }),
      ).rejects.toThrow();
    }
    expect(transport.requests).toEqual([]);
  });

  it('allows a keyless custom loopback provider', async () => {
    const transport = new FakeTransport({ choices: [{ message: { content: 'OK' } }] });
    const client = new ConfigurableLlmClient(transport);
    await expect(
      client.generate([{ role: 'user', content: 'Question' }], {
        provider: 'custom',
        baseUrl: 'http://localhost:8000/v1',
        model: 'local-model',
      }),
    ).resolves.toBe('OK');
  });

  it('rejects plaintext remote endpoints', async () => {
    const client = new ConfigurableLlmClient(new FakeTransport({}));
    await expect(
      client.generate([], {
        provider: 'custom',
        baseUrl: 'http://example.com/v1',
        model: 'model',
      }),
    ).rejects.toThrow(/HTTPS/i);
  });

  it('tests DeepSeek through the same Chat Completions API used by the chat', async () => {
    const transport = new FakeTransport({ choices: [{ message: { content: 'OK' } }] });
    const client = new ConfigurableLlmClient(transport);
    await client.testConnection({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      apiKey: 'secret',
    });
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]).toMatchObject({
      url: 'https://api.deepseek.com/chat/completions',
      method: 'POST',
      headers: { Authorization: 'Bearer secret' },
      body: { model: 'deepseek-flash' },
    });
  });
});
