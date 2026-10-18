export interface ChatCommand {
  name: string;
  description: string;
}

export const CHAT_COMMANDS: readonly ChatCommand[] = [
  { name: '/fmt', description: 'Отформатировать и сохранить выбранную заметку или выделение' },
  { name: '/note', description: 'Описать заметку или создать определение выделенного текста' },
];

export function matchingChatCommands(text: string, cursor: number): readonly ChatCommand[] {
  if (cursor !== text.length || !/^\/[a-z]*$/iu.test(text)) return [];
  return CHAT_COMMANDS.filter((command) => command.name.startsWith(text.toLowerCase()));
}
