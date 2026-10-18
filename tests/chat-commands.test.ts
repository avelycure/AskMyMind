import { describe, expect, it } from 'vitest';
import { matchingChatCommands } from '../src/ui/chat-commands';

describe('chat slash command suggestions', () => {
  it('shows supported commands after a slash and filters as the user types', () => {
    expect(matchingChatCommands('/', 1).map((command) => command.name)).toEqual(['/fmt', '/note']);
    expect(matchingChatCommands('/f', 2).map((command) => command.name)).toEqual(['/fmt']);
    expect(matchingChatCommands('/fmt', 4).map((command) => command.name)).toEqual(['/fmt']);
    expect(matchingChatCommands('/FORMAT', 7)).toEqual([]);
    expect(matchingChatCommands('/n', 2).map((command) => command.name)).toEqual(['/note']);
  });
  it('does not suggest commands inside a question or after their arguments', () => {
    expect(matchingChatCommands('Что такое /fmt?', 15)).toEqual([]);
    expect(matchingChatCommands('/fmt сохрани заголовки', 5)).toEqual([]);
    expect(matchingChatCommands('/fmt', 2)).toEqual([]);
    expect(matchingChatCommands('/unknown', 8)).toEqual([]);
  });
});
