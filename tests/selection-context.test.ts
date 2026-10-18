import { describe, expect, it, vi } from 'vitest';
import { selectionContext } from '../src/ui/selection-context';

describe('selected note context', () => {
  it('preserves the exact selection and its original line number', () => {
    const editor = { getSelection: () => '  Текст\nВторая строка  ', getCursor: vi.fn((side?: 'from' | 'to' | 'head' | 'anchor') => side === 'to' ? { line: 7, ch: 16 } : { line: 6, ch: 2 }),
      getValue: () => 'До\n  Текст\nВторая строка  \nПосле', posToOffset: vi.fn((position: { line: number }) => position.line === 6 ? 3 : 26) };
    expect(selectionContext(editor, { path: 'Note.md', title: 'Note', mtime: 1 })).toEqual({
      path: 'Note.md', title: 'Note', mtime: 1, content: '  Текст\nВторая строка  ', isSelection: true, lineStart: 7,
      selectionStart: 3, selectionEnd: 26, sourceContent: 'До\n  Текст\nВторая строка  \nПосле',
    });
    expect(editor.getCursor).toHaveBeenCalledWith('from');
  });
  it('ignores an empty or whitespace-only selection', () => {
    const editor = { getSelection: () => ' \n ', getCursor: vi.fn(() => ({ line: 0, ch: 0 })), getValue: vi.fn(() => ''), posToOffset: vi.fn(() => 0) };
    expect(selectionContext(editor, { path: 'Note.md', title: 'Note', mtime: 1 })).toBeUndefined();
    expect(editor.getCursor).not.toHaveBeenCalled();
  });
});
