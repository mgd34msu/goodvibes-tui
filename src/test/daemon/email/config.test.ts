import { describe, expect, test } from 'bun:test';
import { resolveEmailSettings } from '../../../daemon/handlers/email/config.ts';
import { HandlerError } from '../../../daemon/handlers/errors.ts';
import { makeConfig, makeCredentials } from './fakes.ts';

const HOSTS = {
  'surfaces.email.host': 'mail.example.com',
  'surfaces.email.user': 'agent@example.com',
};

describe('resolveEmailSettings', () => {
  test('resolves imap+smtp from config with the password from the credential store', async () => {
    const config = makeConfig({
      ...HOSTS,
      'surfaces.email.imap.port': 1993,
      'surfaces.email.smtp.port': 1465,
    });
    const credentials = makeCredentials({ 'surfaces.email.password': 'word-style-fake-pass' });
    const settings = await resolveEmailSettings(config, credentials);
    expect(settings.imap.host).toBe('mail.example.com');
    expect(settings.imap.port).toBe(1993);
    expect(settings.imap.user).toBe('agent@example.com');
    expect(settings.imap.password).toBe('word-style-fake-pass');
    expect(settings.smtp.port).toBe(1465);
    expect(settings.smtp.from).toBe('agent@example.com');
    // Defaults applied.
    expect(settings.imap.mailbox).toBe('INBOX');
    expect(settings.imap.draftsMailbox).toBe('Drafts');
    expect(settings.imap.secure).toBe(true);
  });

  test('throws EMAIL_NOT_CONFIGURED when host/user are missing', async () => {
    const config = makeConfig({});
    const credentials = makeCredentials({});
    await expect(resolveEmailSettings(config, credentials)).rejects.toMatchObject({
      code: 'EMAIL_NOT_CONFIGURED',
      status: 400,
    });
  });

  test('throws EMAIL_CREDENTIALS_MISSING when the password secret is absent', async () => {
    const config = makeConfig({ ...HOSTS });
    const credentials = makeCredentials({});
    await expect(resolveEmailSettings(config, credentials)).rejects.toBeInstanceOf(HandlerError);
    await expect(resolveEmailSettings(config, credentials)).rejects.toMatchObject({
      code: 'EMAIL_CREDENTIALS_MISSING',
    });
  });

  test('separate smtp password secret overrides the shared one', async () => {
    const config = makeConfig({ ...HOSTS });
    const credentials = makeCredentials({
      'surfaces.email.password': 'imap-word-fake',
      'surfaces.email.smtp.password': 'smtp-word-fake',
    });
    const settings = await resolveEmailSettings(config, credentials);
    expect(settings.imap.password).toBe('imap-word-fake');
    expect(settings.smtp.password).toBe('smtp-word-fake');
  });
});
