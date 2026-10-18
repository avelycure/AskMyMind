import type { Editor } from 'obsidian';
import type { ActiveNoteContext } from '../types';

export function selectionContext(
  editor: Pick<Editor, 'getSelection' | 'getCursor' | 'getValue' | 'posToOffset'>,
  note: Pick<ActiveNoteContext, 'path' | 'title' | 'mtime'>,
): ActiveNoteContext | undefined {
  const content = editor.getSelection();
  if (!content.trim()) return undefined;
  const from = editor.getCursor('from');
  const to = editor.getCursor('to');
  return { ...note, content, isSelection: true, lineStart: from.line + 1,
    selectionStart: editor.posToOffset(from), selectionEnd: editor.posToOffset(to), sourceContent: editor.getValue() };
}
