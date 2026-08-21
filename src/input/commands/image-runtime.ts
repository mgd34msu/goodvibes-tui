import type { CommandRegistry } from '../command-registry.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

/**
 * registerImageRuntimeCommands - `/imagine <prompt>`.
 *
 * Named 'imagine', not 'image', `/image <path> [prompt]` already exists
 * (local-runtime.ts) and does something entirely different (attach a local
 * image file to the next message). Re-verified against the current registry
 * before wiring this in: the brief that scoped this command was written
 * before checking for the collision.
 *
 * First production caller of MediaProviderRegistry.generate(), the SDK
 * plumbing existed with zero non-test call sites before this command.
 * findProvider('generate') returns whichever generation-capable provider is
 * configured; when none are, the command prints the registry's own
 * per-provider status (id/state/detail) verbatim, those detail strings
 * already name the exact env var per builtin provider
 * (builtin-generation-providers.ts's buildStatus()), so this command never
 * has to (and never should) guess or hardcode an env-var name itself.
 */
export function registerImageRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'imagine',
    description: 'Generate an image from a prompt via a configured media provider',
    usage: '<prompt>',
    argsHint: '<prompt>',
    async handler(args, ctx) {
      const mediaProviders = ctx.platform.mediaProviders;
      const artifactStore = ctx.platform.artifactStore;
      if (!mediaProviders || !artifactStore) {
        ctx.print('Image generation is not available in this session.');
        return;
      }

      const prompt = args.join(' ').trim();
      if (!prompt) {
        ctx.print('Usage: /imagine <prompt>');
        return;
      }

      const provider = mediaProviders.findProvider('generate');
      if (!provider?.generate) {
        const statuses = await mediaProviders.status();
        const generationStatuses = statuses.filter((status) => status.capabilities.includes('generate'));
        const lines = ['No image-generation provider is configured.', ''];
        if (generationStatuses.length === 0) {
          lines.push('No media-generation providers are registered in this build.');
        } else {
          for (const status of generationStatuses) {
            lines.push(`  ${status.id} (${status.label}): ${status.state}${status.detail ? `; ${status.detail}` : ''}`);
          }
        }
        ctx.print(lines.join('\n'));
        return;
      }

      try {
        const result = await provider.generate({
          prompt,
          outputMimeType: 'image/png',
          metadata: { source: 'tui-image-command' },
        });

        if (result.artifacts.length === 0) {
          ctx.print(`${provider.label} returned no artifacts for this prompt.`);
          return;
        }

        const lines = [`Generated ${result.artifacts.length} artifact(s) via ${provider.label} (${result.providerId}).`];
        for (const artifact of result.artifacts) {
          if (!artifact.mimeType.startsWith('image/')) {
            lines.push(`  Note: ${provider.label} produced ${artifact.mimeType}, not an image; no image-capable provider is configured in this build.`);
          }
          if (artifact.dataBase64) {
            const descriptor = await artifactStore.create({
              dataBase64: artifact.dataBase64,
              mimeType: artifact.mimeType,
              filename: artifact.filename ?? 'generated-image',
              metadata: { ...artifact.metadata, generatedBy: result.providerId },
            });
            lines.push(`  artifact: ${descriptor.id} (${descriptor.mimeType}, ${descriptor.sizeBytes} bytes)`);
          } else if (artifact.uri) {
            // Design note: this is the first production caller of generate(), and
            // returned artifacts may be provider-hosted remote URLs rather than
            // inline bytes. There is no existing precedent for whether to eagerly
            // download remote-only output into ArtifactStore, and doing so
            // unconditionally would turn a text command into an unbounded
            // background fetch of arbitrary provider-hosted content. Conservative
            // default: store a small JSON pointer record (not the media bytes) so
            // the generation is still discoverable via the artifact store, and
            // render the URL directly so the result stays immediately usable.
            const descriptor = await artifactStore.create({
              text: JSON.stringify({ remoteUrl: artifact.uri, mimeType: artifact.mimeType, providerId: result.providerId }, null, 2),
              mimeType: 'application/json',
              filename: `${artifact.filename ?? 'generated-image'}.reference.json`,
              sourceUri: artifact.uri,
              metadata: { ...artifact.metadata, generatedBy: result.providerId, remote: true },
            });
            lines.push(`  artifact: ${descriptor.id} (remote reference; not downloaded)`);
            lines.push(`  url: ${artifact.uri}`);
          } else {
            lines.push('  artifact: (no retrievable content returned)');
          }
        }
        ctx.print(lines.join('\n'));
      } catch (error) {
        ctx.print(`Image generation failed: ${summarizeError(error)}`);
      }
    },
  });
}
