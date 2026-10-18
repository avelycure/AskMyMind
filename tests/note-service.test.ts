import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { generateNoteDraft, isNoteCommand } from '../src/rag/note-service';
import type { LlmClient, LlmConfig } from '../src/types';

const skill = readFileSync('vault-skills/note/SKILL.md', 'utf8');
const config: LlmConfig = { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.8:27b' };
const fullDescription = Array.from({ length: 35 }, () =>
  'Эта тема рассматривает происхождение, основные особенности, развитие и значение явления в более широком историческом контексте.').join(' ');

describe('note skill', () => {
  it('recognizes only the note command', () => {
    expect(isNoteCommand('/note')).toBe(true);
    expect(isNoteCommand('/note подробнее')).toBe(true);
    expect(isNoteCommand('/notes')).toBe(false);
    expect(isNoteCommand('Расскажи про note')).toBe(false);
  });
  it('writes a description from the page title and content', async () => {
    const generate = vi.fn(async () => fullDescription);
    const llm: LlmClient = { generate, testConnection: async () => {} };
    const result = await generateNoteDraft('/note', { path: 'Отношения.md', title: 'Отношения США и Вьетнама',
      content: 'Краткая хронология переговоров.', mtime: 1 }, skill, llm, config);
    expect(result).toEqual({ mode: 'description', text: fullDescription });
    const [messages, options] = generate.mock.calls[0]! as unknown as [Array<{ content: string }>, LlmConfig];
    expect(messages[1]?.content).toContain('Отношения США и Вьетнама');
    expect(messages[1]?.content).toContain('Краткая хронология переговоров.');
    expect(options.options?.num_predict).toBeGreaterThanOrEqual(4096);
    expect(options.responseVerbosity).toBeUndefined();
  });
  it('accepts a concise useful description without expanding it', async () => {
    const generate = vi.fn().mockResolvedValue('Краткое объяснение темы.');
    const llm: LlmClient = { generate, testConnection: async () => {} };
    const note = { path: 'Тема.md', title: 'Тема', content: '', mtime: 1 };
    await expect(generateNoteDraft('/note', note, skill, llm, config)).resolves.toEqual({ mode: 'description', text: 'Краткое объяснение темы.' });
    expect(generate).toHaveBeenCalledTimes(1);
    generate.mockReset().mockResolvedValue('   ');
    await expect(generateNoteDraft('/note', note, skill, llm, config)).rejects.toThrow(/пустое/);
  });
  it('extracts plain text when the model wraps a description in JSON', async () => {
    const generate = vi.fn(async () => '```json\n{"title":"Тема","description":"Обычный текст описания."}\n```');
    const llm: LlmClient = { generate, testConnection: async () => {} };
    const note = { path: 'Тема.md', title: 'Тема', content: '', mtime: 1 };
    await expect(generateNoteDraft('/note', note, skill, llm, config)).resolves.toEqual({ mode: 'description', text: 'Обычный текст описания.' });
    generate.mockResolvedValueOnce('{"title":"Тема"}');
    await expect(generateNoteDraft('/note', note, skill, llm, config)).rejects.toThrow(/JSON без текста/);
  });
  it('uses the title and a bounded excerpt for a long note', async () => {
    const generate = vi.fn(async () => fullDescription);
    const llm: LlmClient = { generate, testConnection: async () => {} };
    await generateNoteDraft('/note', { path: 'Большая.md', title: 'Большая тема',
      content: 'а'.repeat(20_000), mtime: 1 }, skill, llm, config);
    const [messages] = generate.mock.calls[0]! as unknown as [Array<{ content: string }>];
    const context = JSON.parse(messages[1]!.content.split('в формате JSON:\n')[1]!) as { content: string; contentTruncated: boolean };
    expect(context.content).toHaveLength(8_000);
    expect(context.contentTruncated).toBe(true);
  });
  it('returns a title and definition for selected text without retrieval', async () => {
    const generate = vi.fn(async () => '{"title":"Война во Вьетнаме","definition":"Вооружённый конфликт."}');
    const llm: LlmClient = { generate, testConnection: async () => {} };
    const result = await generateNoteDraft('/note', { path: 'Тема.md', title: 'Тема',
      content: 'война во Вьетнаме', isSelection: true, mtime: 1 }, skill, llm, config);
    expect(result).toEqual({ mode: 'definition', title: 'Война во Вьетнаме', text: 'Вооружённый конфликт.' });
    const [messages] = generate.mock.calls[0]! as unknown as [Array<{ content: string }>];
    expect(messages[0]?.content).toContain('JSON');
    expect(messages[1]?.content).toContain('война во Вьетнаме');
  });
});
