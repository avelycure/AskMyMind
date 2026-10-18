import type { ActiveNoteContext } from '../types';

const DESCRIPTION_START = '<!-- AskMyMind:note:start -->';
const DESCRIPTION_END = '<!-- AskMyMind:note:end -->';

export function hasDescription(content: string): boolean {
  const generated = findGeneratedDescription(content);
  if (generated) return content.slice(generated.bodyStart, generated.bodyEnd).trim().length > 0;
  const section = findDescriptionSection(content);
  return section !== null && content.slice(section.bodyStart, section.bodyEnd).trim().length > 0;
}

/** Insert or fill the description without changing any other note content. */
export function describedDocument(context: ActiveNoteContext, current: string, rawDescription: string): string {
  if (current !== context.content) throw new Error('Заметка изменилась во время создания описания. Повторите /note, чтобы не потерять правки.');
  const description = rawDescription.trim();
  if (!description || description.length > 8_000 || /^#{1,2}[ \t]+/mu.test(description) || /^```/mu.test(description)) {
    throw new Error('Модель вернула некорректное описание. Заметка не изменена.');
  }
  const generated = findGeneratedDescription(current);
  if (generated) {
    return current.slice(0, generated.start) + description + current.slice(generated.end);
  }
  const section = findDescriptionSection(current);
  if (section) {
    const tail = current.slice(section.bodyEnd);
    return current.slice(0, section.headingStart) + description + (tail ? '\n\n' : '\n') + tail;
  }
  let insertAt = 0;
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(current);
  if (frontmatter) insertAt = frontmatter[0].length;
  const heading = /^(?:\r?\n)*(?:#[ \t]+[^\r\n]+\r?\n)/u.exec(current.slice(insertAt));
  if (heading) insertAt += heading[0].length;
  const before = current.slice(0, insertAt);
  const after = current.slice(insertAt);
  const separator = before && !before.endsWith('\n') ? '\n\n' : before ? '\n' : '';
  return `${before}${separator}${description}\n${after && !after.startsWith('\n') ? '\n' : ''}${after}`;
}

function findGeneratedDescription(content: string): { start: number; bodyStart: number; bodyEnd: number; end: number } | null {
  const start = content.indexOf(DESCRIPTION_START);
  if (start < 0) return null;
  const bodyStart = start + DESCRIPTION_START.length + 1;
  if (content[bodyStart - 1] !== '\n') return null;
  const bodyEnd = content.indexOf(`\n${DESCRIPTION_END}`, bodyStart);
  return bodyEnd < 0 ? null : { start, bodyStart, bodyEnd, end: bodyEnd + 1 + DESCRIPTION_END.length };
}

function findDescriptionSection(content: string): { headingStart: number; bodyStart: number; bodyEnd: number } | null {
  const heading = /^##[ \t]+Описание[ \t]*\r?$/gmiu.exec(content);
  if (!heading) return null;
  let bodyStart = heading.index + heading[0].length;
  if (content.slice(bodyStart, bodyStart + 2) === '\r\n') bodyStart += 2;
  else if (content[bodyStart] === '\n') bodyStart += 1;
  const following = /^#{1,2}[ \t]+[^\r\n]+/gmu.exec(content.slice(bodyStart));
  const bodyEnd = following ? bodyStart + following.index : content.length;
  return { headingStart: heading.index, bodyStart, bodyEnd };
}

export function safeNoteTitle(raw: string): string {
  const title = raw.replace(/[\\/:*?"<>|#^]/gu, ' ').replaceAll('[', ' ').replaceAll(']', ' ')
    .replace(/\s+/gu, ' ').trim().replace(/[. ]+$/gu, '');
  if (!title || title.length > 80 || title.startsWith('.')) throw new Error('Модель предложила неподходящее название новой заметки.');
  return title;
}

export function definitionDocument(title: string, rawDefinition: string): string {
  const definition = rawDefinition.trim();
  if (!definition || definition.length > 1200 || /[\r\n]/u.test(definition) || /^\s*(?:#|[-*]|\d+\.|```)/u.test(definition)) {
    throw new Error('Модель вернула некорректное определение. Заметка не создана.');
  }
  return `# ${title}\n\n## Определение\n${definition}\n`;
}

/** Link exactly the captured selection after verifying no intervening edit occurred. */
export function linkedSelectionDocument(context: ActiveNoteContext, current: string, targetPath: string): string {
  const { sourceContent, selectionStart, selectionEnd } = context;
  if (!context.isSelection || sourceContent === undefined || selectionStart === undefined || selectionEnd === undefined ||
    selectionStart < 0 || selectionEnd <= selectionStart || selectionEnd > sourceContent.length ||
    sourceContent.slice(selectionStart, selectionEnd) !== context.content) {
    throw new Error('Не удалось определить исходное выделение. Ссылка не вставлена.');
  }
  if (current !== sourceContent) throw new Error('Исходная заметка изменилась. Повторите /note, чтобы не потерять правки.');
  const linkTarget = targetPath.replace(/\.md$/iu, '');
  if (['[', ']', '|'].some((character) => linkTarget.includes(character))) {
    throw new Error('Путь новой заметки содержит символы, несовместимые со ссылкой Obsidian.');
  }
  const selected = context.content;
  const replacement = selected.length <= 120 && !/[\r\n]/u.test(selected) &&
    !['[', ']', '|'].some((character) => selected.includes(character))
    ? `[[${linkTarget}|${selected}]]`
    : `${selected} [[${linkTarget}]]`;
  return current.slice(0, selectionStart) + replacement + current.slice(selectionEnd);
}
