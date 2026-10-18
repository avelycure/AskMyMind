import type { ActiveNoteContext, ChatProgress, LlmClient, LlmConfig, RagAnswer } from '../types';

export const FORMAT_SKILL_PATH = '.agents/skills/fmt/SKILL.md';
// Conservative input bound leaves room for the skill and the complete corrected output.
export const MAX_FORMAT_CHARACTERS = 12_000;

export function isFormatCommand(question: string): boolean {
  const text = question.trim();
  return /^\/fmt(?:\s|$)/iu.test(text) ||
    /^(?:пожалуйста[,!]?\s+)?(?:отформатируй|форматируй|примени|применить|используй|использовать)(?:\s|$)/iu.test(text) &&
    /(?:^|[^a-zа-яё0-9_])\/?fmt(?:$|[^a-zа-яё0-9_])/iu.test(text);

}

export async function formatNote(
  question: string,
  activeNote: ActiveNoteContext | undefined,
  skill: string,
  llm: LlmClient,
  config: LlmConfig,
  onProgress?: (progress: ChatProgress) => void,
): Promise<RagAnswer> {
  config.signal?.throwIfAborted();
  if (!activeNote) throw new Error('Для /fmt выберите диалог с закреплённой страницей.');
  if (!activeNote.content.trim()) throw new Error('Выбранная страница пустая.');
  if (activeNote.content.length > MAX_FORMAT_CHARACTERS) {
    throw new Error('Страница длиннее 12 000 символов. Форматирование отменено, чтобы не обрезать текст. Разделите её на части.');
  }
  const instructions = skill.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, '').trim();
  if (!instructions) throw new Error('Скилл fmt не содержит инструкций.');
  onProgress?.({ kind: 'stage', text: activeNote.isSelection ? 'Форматирую выделенный текст и исправляю ошибки…' : 'Форматирую страницу и исправляю ошибки…' });
  const text = await llm.generate([
    { role: 'system', content: 'Ты редактор текста. Правила скилла fmt уже переданы ниже: применяй их самостоятельно к полю content в предоставленном JSON. Не вызывай инструменты: верни только полный исправленный текст; плагин сам запишет его в заметку после проверки. Не сообщай об отсутствии инструментов или доступа к скиллу.\n\n' + instructions + (activeNote.isSelection ? '\nПользователь выделил фрагмент. Применяй к этому тексту: форматируй только выделение, сохрани все его заголовки и верни только исправленный фрагмент.' : '') },
    { role: 'user', content: (activeNote.isSelection ? 'Применяй к этому тексту: отформатируй выделенный фрагмент.' : 'Отформатируй выбранную страницу.') + ' Дополнительные указания пользователя:\n' +
      (question.trim().replace(/^\/fmt\b/iu, '').trim() || 'Нет.') +
      '\n\nВыбранная страница в формате JSON:\n' + JSON.stringify({
        path: activeNote.path, title: activeNote.title, content: activeNote.content, mtime: activeNote.mtime,
        isSelection: activeNote.isSelection, lineStart: activeNote.lineStart,
      }) },
  ], { ...config, requireComplete: true, options: { temperature: 0.1, repeat_penalty: 1, num_predict: 8192, num_ctx: 32768, ...config.options } },
  onProgress ? (delta) => onProgress({ kind: 'text', text: delta }) : undefined);
  config.signal?.throwIfAborted();
  return { text, sources: [], citations: [], groundingStatus: 'not-applicable',
    usedRag: false, usedRetrievalEnhancements: false, modelCalled: true };
}
