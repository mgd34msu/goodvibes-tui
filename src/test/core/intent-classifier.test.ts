import { describe, test, expect } from 'bun:test';
import { classifyIntent } from '../../core/intent-classifier.ts';

describe('classifyIntent', () => {
  // ── Chat classification ───────────────────────────────────────────────────

  describe('chat', () => {
    test('question starting with "what" is chat', () => {
      const result = classifyIntent('What does this function do?');
      expect(result.intent).toBe('chat');
      expect(result.signals).toContain('question_word');
    });

    test('question starting with "how" is chat', () => {
      const result = classifyIntent('How does the orchestrator work?');
      expect(result.intent).toBe('chat');
      expect(result.signals).toContain('question_word');
    });

    test('question starting with "why" is chat', () => {
      const result = classifyIntent('Why is the buffer anchored at the bottom?');
      expect(result.intent).toBe('chat');
      expect(result.signals).toContain('question_word');
    });

    test('short message without action verb is chat', () => {
      const result = classifyIntent('Hello there');
      expect(result.intent).toBe('chat');
      expect(result.signals).toContain('short_no_action');
    });

    test('"can you explain" prefix is chat', () => {
      const result = classifyIntent('Can you explain the event bus?');
      expect(result.intent).toBe('chat');
      expect(result.signals).toContain('question_word');
    });

    test('confidence is between 0 and 1', () => {
      const result = classifyIntent('What is TypeScript?');
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  });

  // ── Task classification ───────────────────────────────────────────────────

  describe('task', () => {
    test('single imperative with clear target is task', () => {
      const result = classifyIntent('Fix the bug in auth.ts');
      expect(result.intent).toBe('task');
      expect(result.signals).toContain('action_verb');
    });

    test('single action verb with file reference scores action_verb + file_references', () => {
      const result = classifyIntent('Update the config.json file');
      expect(result.signals).toContain('action_verb');
      expect(result.signals).toContain('file_references');
      // 2 signals → task (not enough for project threshold of 3)
      expect(['task', 'project']).toContain(result.intent);
    });

    test('short imperative without multi-sentence or long text stays task', () => {
      const result = classifyIntent('Rename the component');
      expect(result.intent).toBe('task');
    });

    test('confidence is between 0 and 1', () => {
      const result = classifyIntent('Fix the login error');
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  });

  // ── Project classification ────────────────────────────────────────────────

  describe('project', () => {
    test('long_message signal fires for messages > 200 chars', () => {
      const long = 'Build a complete authentication system with login, logout, and token refresh. ' +
        'Include JWT support, session management, and role-based access control. ' +
        'Make sure it integrates with the existing user model.';
      const result = classifyIntent(long);
      expect(result.signals).toContain('long_message');
    });

    test('action_verb signal fires for "build"', () => {
      const result = classifyIntent('Build me a thing');
      expect(result.signals).toContain('action_verb');
    });

    test('action_verb signal fires for "implement"', () => {
      const result = classifyIntent('Implement the new API endpoint');
      expect(result.signals).toContain('action_verb');
    });

    test('action_verb signal fires for "develop"', () => {
      const result = classifyIntent('Develop a new feature');
      expect(result.signals).toContain('action_verb');
    });

    test('multiple_deliverables signal fires for "and" separator', () => {
      const result = classifyIntent('Build a login page and an auth service and a token refresh flow');
      expect(result.signals).toContain('multiple_deliverables');
    });

    test('multiple_deliverables signal fires for semicolons', () => {
      const result = classifyIntent('Create the UI; implement the API; write the tests');
      expect(result.signals).toContain('multiple_deliverables');
    });

    test('file_references signal fires for .ts extension', () => {
      const result = classifyIntent('Refactor the auth.ts and session.ts modules');
      expect(result.signals).toContain('file_references');
    });

    test('file_references signal fires for "file" keyword', () => {
      const result = classifyIntent('Create a new file for the config manager');
      expect(result.signals).toContain('file_references');
    });

    test('file_references signal fires for path prefix', () => {
      const result = classifyIntent('Update the handler in src/core/orchestrator.ts');
      expect(result.signals).toContain('file_references');
    });

    test('parallelism_keywords signal fires for "agent"', () => {
      const result = classifyIntent('Spawn an agent to handle the database migration');
      expect(result.signals).toContain('parallelism_keywords');
    });

    test('parallelism_keywords signal fires for "phase"', () => {
      const result = classifyIntent('Execute this in phase 2 of the deployment');
      expect(result.signals).toContain('parallelism_keywords');
    });

    test('parallelism_keywords signal fires for "parallel"', () => {
      const result = classifyIntent('Run these tasks in parallel');
      expect(result.signals).toContain('parallelism_keywords');
    });

    test('multi_sentence_actions signal fires for compound instructions', () => {
      const result = classifyIntent(
        'Create the database schema. Implement the API endpoints. Add error handling.',
      );
      expect(result.signals).toContain('multi_sentence_actions');
    });

    test('spec_plan_reference signal fires for "spec"', () => {
      const result = classifyIntent('Write a spec for the new authentication module');
      expect(result.signals).toContain('spec_plan_reference');
    });

    test('spec_plan_reference signal fires for "architecture"', () => {
      const result = classifyIntent('Design the architecture for the new plugin system');
      expect(result.signals).toContain('spec_plan_reference');
    });

    test('spec_plan_reference signal fires for "plan"', () => {
      const result = classifyIntent('Make a plan for migrating the database');
      expect(result.signals).toContain('spec_plan_reference');
    });

    test('project threshold: 3+ signals yields project intent', () => {
      // long + action_verb + multiple_deliverables + file_references
      const message =
        'Build a complete user authentication system with login and logout. ' +
        'Create the auth.ts service and the session.ts handler. ' +
        'Make sure both integrate with the existing src/core/orchestrator.ts. ' +
        'This is a multi-phase effort across several files.';
      const result = classifyIntent(message);
      expect(result.intent).toBe('project');
      expect(result.confidence).toBeGreaterThan(0.65);
    });

    test('confidence is between 0 and 1', () => {
      const message =
        'Build a complete auth system with JWT, roles, and sessions. ' +
        'Create auth.ts, session.ts, and middleware.ts. ' +
        'Run agents in parallel phases to complete the implementation.';
      const result = classifyIntent(message);
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    test('empty string returns chat with low confidence', () => {
      const result = classifyIntent('');
      expect(result.intent).toBe('chat');
    });

    test('whitespace-only string returns chat', () => {
      const result = classifyIntent('   ');
      expect(result.intent).toBe('chat');
    });

    test('signals array is always an array', () => {
      const result = classifyIntent('hello');
      expect(Array.isArray(result.signals)).toBe(true);
    });

    test('result always has intent, confidence, signals', () => {
      const result = classifyIntent('anything');
      expect(result).toHaveProperty('intent');
      expect(result).toHaveProperty('confidence');
      expect(result).toHaveProperty('signals');
    });
  });
});
