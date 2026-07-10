import type { CommandRegistry } from '../command-registry.ts';
import { requirePanelManager } from './runtime-services.ts';

/**
 * `/review` — open the comment-on-hunk review loop. Loads this session's file
 * changes (the files the SDK SessionChangeTracker recorded) as a git working-
 * tree diff, hunk-boundaried, and wires the panel's steering submit path to the
 * session so an attached comment is sent to the model as a steering message with
 * structured context (file path, line range, patch excerpt). Read-only over the
 * diff; the only write is the steering message the user chooses to send.
 */
export function registerReviewRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'review',
    aliases: [],
    description: 'Review this session\'s diff hunk-by-hunk and steer comments to the model',
    async handler(_args, ctx) {
      const pm = requirePanelManager(ctx);
      let panel = pm.getAllOpen().find((p) => p.id === 'review');
      if (!panel) {
        try {
          panel = pm.open('review');
        } catch {
          ctx.print('Could not open the review panel.');
          return;
        }
      }
      pm.activateById('review');
      if (!pm.isVisible()) pm.show();

      const reviewPanel = panel as import('../../panels/diff-review-panel.ts').DiffReviewPanel;
      if (ctx.submitInput) {
        reviewPanel.setSubmit((text) => ctx.submitInput!(text));
      }
      await reviewPanel.loadSessionReview();
      ctx.focusPanels?.();
      ctx.renderRequest();
    },
  });
}
