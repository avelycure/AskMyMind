import type { ActiveNoteContext } from '../types';

/** Build the complete replacement only when the source still matches the model input. */
export function formattedDocument(context: ActiveNoteContext, current: string, formatted: string): string {
  if (!formatted.trim()) throw new Error('Модель вернула пустой результат. Заметка не изменена.');
  validateProtectedContent(context.content, formatted);
  if (context.isSelection) {
    const { sourceContent, selectionStart, selectionEnd } = context;
    if (sourceContent === undefined || selectionStart === undefined || selectionEnd === undefined ||
      selectionStart < 0 || selectionEnd < selectionStart || selectionEnd > sourceContent.length ||
      sourceContent.slice(selectionStart, selectionEnd) !== context.content) {
      throw new Error('Не удалось определить исходное выделение. Заметка не изменена.');
    }
    if (current !== sourceContent) throw new Error('Заметка изменилась во время форматирования. Повторите /fmt, чтобы не потерять правки.');
    return current.slice(0, selectionStart) + formatted + current.slice(selectionEnd);
  }
  if (current !== context.content) throw new Error('Заметка изменилась во время форматирования. Повторите /fmt, чтобы не потерять правки.');
  return formatted;
}

function validateProtectedContent(original: string, formatted: string): void {
  if (formatted.trim().length < original.trim().length * 0.5) {
    throw new Error('Ответ модели слишком короткий: возможна потеря текста. Заметка не изменена.');
  }
  const frontmatter = original.match(/^---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)/u)?.[0];
  if (frontmatter && !formatted.startsWith(frontmatter)) {
    throw new Error('Модель изменила YAML frontmatter. Заметка не изменена.');
  }
  for (const pattern of [/!?\[\[[^\]]+\]\]/gu, /https?:\/\/[^\s<>)\]]+/gu, /^```[^\n]*\n[\s\S]*?^```/gmu]) {
    const before = original.match(pattern) ?? [];
    const after = formatted.match(pattern) ?? [];
    if (before.length !== after.length || before.some((item, index) => item !== after[index])) {
      throw new Error('Модель изменила ссылку, вложение или блок кода. Заметка не изменена.');
    }
  }
}
