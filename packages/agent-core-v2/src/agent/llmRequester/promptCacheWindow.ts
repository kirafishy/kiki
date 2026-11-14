import type { Message } from '#/kosong/contract/message';
import type { Tool } from '#/kosong/contract/tool';

export class PromptCacheWindow {
  private readonly turnTools = new Map<number, readonly Tool[]>();
  private toolset: { signature: string; tools: readonly Tool[] } | undefined;
  private extension: { baseline: string; current: string } | undefined;
  private readonly extensionUpdates: { index: number; message: Message }[] = [];

  constructor(readonly key: string) {}

  toolsForTurn(turnId: number, tools: readonly Tool[], promptOverrides: string): readonly Tool[] {
    const frozen = this.turnTools.get(turnId);
    if (frozen !== undefined) return frozen;
    for (const id of this.turnTools.keys()) {
      if (id < turnId) this.turnTools.delete(id);
    }
    const signature = JSON.stringify([
      promptOverrides,
      tools.map((tool) => [tool.name, tool.parameters, tool.deferred]),
    ]);
    if (this.toolset?.signature !== signature) {
      this.toolset = { signature, tools: structuredClone(tools) };
    }
    this.turnTools.set(turnId, this.toolset.tools);
    return this.toolset.tools;
  }

  projectExtensions(text: string, messages: readonly Message[]): { text: string; messages: Message[] } {
    if (this.extension === undefined) this.extension = { baseline: text, current: text };
    if (text !== this.extension.current) {
      this.extension.current = text;
      this.extensionUpdates.push({
        index: messages.at(-1)?.partial === true ? messages.length - 1 : messages.length,
        message: {
          role: 'user',
          content: [{
            type: 'text',
            text: `<system-reminder>\nExtension prompt sections updated; use this state instead of the previous extension prompt sections.\n\n${text || 'No extension prompt sections are active.'}\n</system-reminder>`,
          }],
          toolCalls: [],
        },
      });
    }
    const projected: Message[] = [];
    let start = 0;
    for (const update of this.extensionUpdates) {
      projected.push(...messages.slice(start, update.index), update.message);
      start = update.index;
    }
    projected.push(...messages.slice(start));
    return { text: this.extension.baseline, messages: projected };
  }
}
