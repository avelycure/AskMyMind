import { describe, expect, it, vi } from 'vitest';
import { insertAnswer, lastAssistantAnswer } from '../src/ui/insert-answer';

describe('insert the latest completed answer', () => {
  it('uses the latest assistant response even if followed by a user message', () => {
    expect(lastAssistantAnswer([
      { role: 'assistant', content: 'Old' },
      { role: 'user', content: 'Format this' },
      { role: 'assistant', content: '## Result\nFull text.' },
      { role: 'user', content: 'Another question' },
    ])).toBe('## Result\nFull text.');
    expect(lastAssistantAnswer([{ role: 'user', content: 'Question' }])).toBeUndefined();
  });
  it('does not offer to insert a /fmt completion message into a note', () => {
    expect(lastAssistantAnswer([
      { role: 'assistant', content: 'Earlier answer' },
      { role: 'user', content: '/fmt' },
      { role: 'assistant', content: 'Заметка обновлена.', fileEdited: true },
    ])).toBeUndefined();
  });
  it('inserts the complete Markdown through the editor and focuses the note', () => {
    const editor = { replaceSelection: vi.fn(), focus: vi.fn() };
    const text = '## Результат\nТекст\n- [ ] Задача\n[[Ссылка]]';
    insertAnswer(editor, text);
    expect(editor.replaceSelection).toHaveBeenCalledExactlyOnceWith(text);
    expect(editor.focus).toHaveBeenCalledOnce();
  });
  it('reports a missing editor instead of writing to another file', () => {
    expect(() => insertAnswer(undefined, 'Text')).toThrow(/редактирования/);
  });
});
