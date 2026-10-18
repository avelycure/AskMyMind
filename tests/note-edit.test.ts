import { describe, expect, it } from 'vitest';
import { describedDocument, definitionDocument, hasDescription, linkedSelectionDocument, safeNoteTitle } from '../src/rag/note-edit';

describe('/note document changes', () => {
  it('adds a description after frontmatter and title without changing the rest', () => {
    const content = '---\ntags: [history]\n---\n# Вьетнам\n\nИстория страны.\n';
    const context = { path: 'Вьетнам.md', title: 'Вьетнам', content, mtime: 1 };
    const updated = describedDocument(context, content, 'Заметка об истории Вьетнама.');
    expect(updated).toContain('# Вьетнам\n\nЗаметка об истории Вьетнама.\n\nИстория страны.');
    expect(updated.startsWith('---\ntags: [history]\n---\n')).toBe(true);
    expect(hasDescription(updated)).toBe(false);
    expect(updated).not.toContain('## Описание');
    expect(updated).not.toContain('AskMyMind:note:');
  });
  it('fills an empty section, replaces an existing description and rejects a concurrent edit', () => {
    const content = '## Описание\n\n## Данные\nТекст';
    const context = { path: 'A.md', title: 'A', content, mtime: 1 };
    expect(describedDocument(context, content, 'Краткое описание.')).toBe('Краткое описание.\n\n## Данные\nТекст');
    expect(describedDocument({ ...context, content: '## Описание\nЕсть.\n\n## Данные\nТекст' },
      '## Описание\nЕсть.\n\n## Данные\nТекст', '### Контекст\nПодробное объяснение.'))
      .toBe('### Контекст\nПодробное объяснение.\n\n## Данные\nТекст');
    const marked = 'Текст до.\n\n<!-- AskMyMind:note:start -->\nПервое описание.\n<!-- AskMyMind:note:end -->\n\n## Данные\nТекст';
    expect(hasDescription(marked)).toBe(true);
    expect(describedDocument({ ...context, content: marked }, marked, 'Новое описание.'))
      .toBe('Текст до.\n\nНовое описание.\n\n## Данные\nТекст');
    expect(() => describedDocument(context, content, '## Чужой раздел\nТекст')).toThrow(/некорректное/);
    expect(() => describedDocument(context, 'Внешняя правка', 'Краткое описание.')).toThrow(/изменилась/);
  });
  it('creates a definition and links precisely the selected text', () => {
    expect(safeNoteTitle('  США / Вьетнам?  ')).toBe('США Вьетнам');
    expect(() => safeNoteTitle('../')).toThrow();
    expect(definitionDocument('Война во Вьетнаме', 'Вооружённый конфликт в Юго-Восточной Азии.'))
      .toBe('# Война во Вьетнаме\n\n## Определение\nВооружённый конфликт в Юго-Восточной Азии.\n');
    const sourceContent = 'Читайте про войну во Вьетнаме сегодня.';
    const context = { path: 'Тема.md', title: 'Тема', content: 'войну во Вьетнаме', mtime: 1,
      isSelection: true, sourceContent, selectionStart: 12, selectionEnd: 29 };
    expect(linkedSelectionDocument(context, sourceContent, 'История/Война во Вьетнаме.md'))
      .toBe('Читайте про [[История/Война во Вьетнаме|войну во Вьетнаме]] сегодня.');
    expect(linkedSelectionDocument(context, sourceContent, 'Война во Вьетнаме.md'))
      .toBe('Читайте про [[Война во Вьетнаме|войну во Вьетнаме]] сегодня.');
    expect(() => linkedSelectionDocument(context, 'Другой текст', 'История/Война во Вьетнаме.md')).toThrow(/изменилась/);
  });
});
