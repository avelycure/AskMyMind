import { describe, expect, it } from 'vitest';
import { formattedDocument } from '../src/rag/format-edit';

describe('applying /fmt to a note', () => {
  it('replaces a complete note only when its content still matches the input', () => {
    const context = { path: 'Note.md', title: 'Note', content: 'Ошбика.', mtime: 1 };
    expect(formattedDocument(context, 'Ошбика.', 'Ошибка.')).toBe('Ошибка.');
    expect(() => formattedDocument(context, 'Новая правка.', 'Ошибка.')).toThrow(/изменилась/);
    expect(() => formattedDocument(context, 'Ошбика.', '  ')).toThrow(/пустой/);
  });
  it('changes only the original selected range and rejects later edits', () => {
    const context = { path: 'Note.md', title: 'Note', content: 'Ошбика.', mtime: 1,
      isSelection: true, sourceContent: 'До\nОшбика.\nПосле', selectionStart: 3, selectionEnd: 10 };
    expect(formattedDocument(context, context.sourceContent, 'Ошибка.')).toBe('До\nОшибка.\nПосле');
    expect(() => formattedDocument(context, 'До\nОшбика.\nНовая правка', 'Ошибка.')).toThrow(/изменилась/);
    expect(() => formattedDocument({ ...context, selectionEnd: 11 }, context.sourceContent, 'Ошибка.')).toThrow(/выделение/);
  });
  it('rejects truncated output or changes to Obsidian links and code', () => {
    const context = { path: 'Note.md', title: 'Note', content: 'См. [[Страница]] и https://example.com/a\n```js\nconst n = 1;\n```', mtime: 1 };
    expect(() => formattedDocument(context, context.content, 'См. [[Страница]]')).toThrow(/короткий/);
    expect(() => formattedDocument(context, context.content, 'См. [[Другая]] и https://example.com/a\n```js\nconst n = 1;\n```')).toThrow(/ссылку/);
    expect(() => formattedDocument(context, context.content, 'См. [[Страница]] и https://example.com/a\n```js\nconst n = 2;\n```')).toThrow(/блок кода/);
  });
});
