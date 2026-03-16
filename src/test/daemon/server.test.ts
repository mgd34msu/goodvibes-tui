import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { DaemonServer } from '../../daemon/server.ts';
import { HttpListener } from '../../daemon/http-listener.ts';

// ---------------------------------------------------------------------------
// DaemonServer
// ---------------------------------------------------------------------------

describe('DaemonServer', () => {
  let daemon: DaemonServer;

  beforeEach(() => {
    // Use a high port to avoid conflicts with system services
    daemon = new DaemonServer({ port: 39421, host: '127.0.0.1' });
  });

  afterEach(async () => {
    await daemon.stop();
  });

  test('isRunning is false before start', () => {
    expect(daemon.isRunning).toBe(false);
  });

  test('refuses to start when disabled (default state)', async () => {
    await daemon.start();
    expect(daemon.isRunning).toBe(false);
  });

  test('enable returns false when danger.daemon is false', () => {
    const result = daemon.enable({ daemon: false });
    expect(result).toBe(false);
  });

  test('enable returns true when danger.daemon is true', () => {
    const result = daemon.enable({ daemon: true });
    expect(result).toBe(true);
  });

  test('starts when enabled', async () => {
    daemon.enable({ daemon: true });
    await daemon.start();
    expect(daemon.isRunning).toBe(true);
  });

  test('start is idempotent — does not throw when called twice', async () => {
    daemon.enable({ daemon: true });
    await daemon.start();
    await daemon.start(); // second call should be a no-op
    expect(daemon.isRunning).toBe(true);
  });

  test('stop works when running', async () => {
    daemon.enable({ daemon: true });
    await daemon.start();
    await daemon.stop();
    expect(daemon.isRunning).toBe(false);
  });

  test('stop is safe when not running', async () => {
    // Should not throw
    await expect(daemon.stop()).resolves.toBeUndefined();
    expect(daemon.isRunning).toBe(false);
  });

  test('GET /status returns running status', async () => {
    daemon.enable({ daemon: true });
    await daemon.start();
    const res = await fetch('http://127.0.0.1:39421/status');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe('running');
  });

  test('POST /task returns 202 acknowledgement', async () => {
    daemon.enable({ daemon: true });
    await daemon.start();
    const res = await fetch('http://127.0.0.1:39421/task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'do something' }),
    });
    expect(res.status).toBe(202);
    const body = await res.json() as Record<string, unknown>;
    expect(body.acknowledged).toBe(true);
  });

  test('unknown route returns 404', async () => {
    daemon.enable({ daemon: true });
    await daemon.start();
    const res = await fetch('http://127.0.0.1:39421/does-not-exist');
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// HttpListener
// ---------------------------------------------------------------------------

describe('HttpListener', () => {
  let listener: HttpListener;

  beforeEach(() => {
    listener = new HttpListener({ port: 39422, host: '127.0.0.1' });
  });

  afterEach(async () => {
    await listener.stop();
  });

  test('isRunning is false before start', () => {
    expect(listener.isRunning).toBe(false);
  });

  test('refuses to start when disabled (default state)', async () => {
    await listener.start();
    expect(listener.isRunning).toBe(false);
  });

  test('enable returns false when danger.httpListener is false', () => {
    const result = listener.enable({ httpListener: false });
    expect(result).toBe(false);
  });

  test('enable returns true when danger.httpListener is true', () => {
    const result = listener.enable({ httpListener: true });
    expect(result).toBe(true);
  });

  test('starts when enabled', async () => {
    listener.enable({ httpListener: true });
    await listener.start();
    expect(listener.isRunning).toBe(true);
  });

  test('stop works when running', async () => {
    listener.enable({ httpListener: true });
    await listener.start();
    await listener.stop();
    expect(listener.isRunning).toBe(false);
  });

  test('stop is safe when not running', async () => {
    await expect(listener.stop()).resolves.toBeUndefined();
    expect(listener.isRunning).toBe(false);
  });

  test('POST /webhook returns 202 acknowledgement', async () => {
    listener.enable({ httpListener: true });
    await listener.start();
    const res = await fetch('http://127.0.0.1:39422/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'push' }),
    });
    expect(res.status).toBe(202);
    const body = await res.json() as Record<string, unknown>;
    expect(body.acknowledged).toBe(true);
  });

  test('GET /health returns 200', async () => {
    listener.enable({ httpListener: true });
    await listener.start();
    const res = await fetch('http://127.0.0.1:39422/health');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe('ok');
  });

  test('unknown route returns 404', async () => {
    listener.enable({ httpListener: true });
    await listener.start();
    const res = await fetch('http://127.0.0.1:39422/unknown-path');
    expect(res.status).toBe(404);
  });
});
