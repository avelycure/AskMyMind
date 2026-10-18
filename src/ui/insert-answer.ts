import type { Editor } from 'obsidian';
import type { ChatEntry } from './chat-state';

export function lastAssistantAnswer(entries: readonly ChatEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.role === 'assistant' && entry.content.trim()) return entry.fileEdited ? undefined : entry.content;
  }
  return undefined;
}

export function insertAnswer(editor: Pick<Editor, 'replaceSelection' | 'focus'> | undefined, text: string): void {
  if (!editor) throw new Error('Откройте заметку в режиме редактирования, чтобы вставить ответ.');
  editor.replaceSelection(text);
  editor.focus();
}
