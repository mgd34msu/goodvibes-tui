import type { CommandRegistry } from '../command-registry.ts';

export function registerTtsRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'tts',
    description: 'Submit a normal prompt and play the assistant response through live TTS',
    usage: '<prompt>|stop',
    handler(args, ctx) {
      const first = (args[0] ?? '').toLowerCase();
      if (first === 'stop' || first === 'cancel') {
        ctx.stopSpokenOutput?.();
        ctx.print('Live TTS playback stopped.');
        return;
      }

      const prompt = args.join(' ').trim();
      if (!prompt) {
        ctx.print('Usage: /tts <prompt> or /tts stop');
        return;
      }
      if (!ctx.submitSpokenInput) {
        ctx.print('Live TTS is not available in this runtime.');
        return;
      }
      ctx.submitSpokenInput(prompt);
    },
  });

}
