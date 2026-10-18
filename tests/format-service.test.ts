import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { formatNote, isFormatCommand, MAX_FORMAT_CHARACTERS } from '../src/rag/format-service';
import type { LlmClient, LlmConfig } from '../src/types';

const skill = readFileSync('vault-skills/fmt/SKILL.md', 'utf8');
const config: LlmConfig = { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.8:27b' };
const note = { path: 'Рецепт.md', title: 'Рецепт', content: 'Я добовил 250 г муки.', mtime: 1 };
function model() {
  const generate = vi.fn(async () => 'Я добавил 250 г муки.');
  const llm: LlmClient = { generate, testConnection: async () => {} };
  return { generate, llm };
}

describe('vault formatting skill', () => {
  it('recognizes slash commands and explicit requests to apply fmt', () => {
    expect(isFormatCommand('/fmt')).toBe(true);
    expect(isFormatCommand(' /fmt сохрани заголовки')).toBe(true);
    expect(isFormatCommand('/format сохрани заголовки')).toBe(false);
    expect(isFormatCommand('/fmtx')).toBe(false);
    expect(isFormatCommand('Расскажи про fmt')).toBe(false);
    expect(isFormatCommand('Отформатируй заметку скиллом fmt')).toBe(true);
    expect(isFormatCommand('Пожалуйста, примени /fmt к выделению')).toBe(true);
    expect(isFormatCommand('Используй скилл fmt для форматирования')).toBe(true);
    expect(isFormatCommand('Отформатируй заметку')).toBe(false);
    expect(isFormatCommand('Почему fmt не работает?')).toBe(false);
    expect(isFormatCommand('Отформатируй с fmtx')).toBe(false);
  });
  it('sends the complete selected note and skill without history or retrieval and applies formatting options', async () => {
    const { llm, generate } = model();
    const result = await formatNote('/fmt сохрани заголовки', note, skill, llm, config);
    expect(generate).toHaveBeenCalledOnce();
    const [messages, options] = generate.mock.calls[0]! as unknown as [Array<{ role: string; content: string }>, LlmConfig];
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).not.toContain('description:');
    expect(messages[0]?.content).toContain('Правила скилла fmt уже переданы');
    expect(messages[1]?.content).toContain('сохрани заголовки');
    expect(JSON.parse(messages[1]!.content.split('Выбранная страница в формате JSON:\n')[1]!)).toEqual(note);
    expect(options.options).toEqual({ temperature: 0.1, repeat_penalty: 1, num_predict: 8192, num_ctx: 32768 });
    expect(result.usedRag).toBe(false);
    expect(result.sources).toEqual([]);
    expect(result.text).toBe('Я добавил 250 г муки.');
  });
  it('allows dialog options to override the formatting defaults', async () => {
    const { llm, generate } = model();
    const custom = { temperature: 0.4, repeat_penalty: 1.2, num_predict: 4096, num_ctx: 16384 };
    await formatNote('/fmt', note, skill, llm, { ...config, options: custom });
    const [, options] = generate.mock.calls[0]! as unknown as [unknown, LlmConfig];
    expect(options.options).toEqual(custom);
  });
  it('targets only the selected fragment and preserves its headings', async () => {
    const { llm, generate } = model();
    const selected = { ...note, isSelection: true, lineStart: 4 };
    await formatNote('/fmt', selected, skill, llm, config);
    const [messages] = generate.mock.calls[0]! as unknown as [Array<{ content: string }>];
    expect(messages[0]?.content).toContain('форматируй только выделение, сохрани все его заголовки');
    expect(messages[1]?.content).toContain('Применяй к этому тексту');
    expect(JSON.parse(messages[1]!.content.split('Выбранная страница в формате JSON:\n')[1]!)).toEqual(selected);
  });
  it('refuses missing, empty and oversized notes before calling the model', async () => {
    const { llm, generate } = model();
    await expect(formatNote('/fmt', undefined, skill, llm, config)).rejects.toThrow(/закреплённой/);
    await expect(formatNote('/fmt', { ...note, content: ' ' }, skill, llm, config)).rejects.toThrow(/пустая/);
    await expect(formatNote('/fmt', { ...note, content: 'x'.repeat(MAX_FORMAT_CHARACTERS + 1) }, skill, llm, config)).rejects.toThrow(/не обрезать/);
    expect(generate).not.toHaveBeenCalled();
  });
  it('respects cancellation before starting a model request', async () => {
    const { llm, generate } = model();
    const cancellation = new AbortController();
    cancellation.abort();
    await expect(formatNote('/fmt', note, skill, llm, { ...config, signal: cancellation.signal })).rejects.toThrow();
    expect(generate).not.toHaveBeenCalled();
  });
});
