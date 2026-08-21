import type { CommandRegistry } from '../command-registry.ts';

export function registerTtsRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'tts',
    description: 'Submit a prompt for live TTS playback, or control always-speak mode',
    usage: '<prompt>|stop|on|off',
    handler(args, ctx) {
      const first = (args[0] ?? '').toLowerCase();

      // /tts stop, cancel active playback
      if (first === 'stop' || first === 'cancel') {
        ctx.stopSpokenOutput?.();
        ctx.print('Live TTS playback stopped.');
        return;
      }

      // /tts on, enable always-speak mode (every turn spoken automatically)
      if (first === 'on') {
        if (!ctx.platform.voiceService) {
          ctx.print('Live TTS is not available in this runtime.');
          return;
        }
        ctx.platform.configManager.setDynamic('ui.voiceEnabled', true);
        ctx.platform.configManager.save();
        ctx.print('Always-speak mode enabled. Every submitted turn will be played through live TTS.');
        ctx.renderRequest();
        return;
      }

      // /tts off, disable always-speak mode
      if (first === 'off') {
        ctx.platform.configManager.setDynamic('ui.voiceEnabled', false);
        ctx.platform.configManager.save();
        ctx.print('Always-speak mode disabled. Use /tts <prompt> to speak individual turns.');
        ctx.renderRequest();
        return;
      }

      // /tts <prompt>, mark this prompt for spoken output
      const prompt = args.join(' ').trim();
      if (!prompt) {
        const enabled = ctx.platform.configManager.get('ui.voiceEnabled');
        ctx.print(`Usage: /tts <prompt>, /tts stop, /tts on, /tts off
Always-speak mode is currently ${enabled ? 'on' : 'off'}.`);
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
