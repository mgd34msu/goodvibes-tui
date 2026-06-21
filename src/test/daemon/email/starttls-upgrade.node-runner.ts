// ---------------------------------------------------------------------------
// STARTTLS happy-path runner (executed under Node, not Bun).
//
// Bun 1.3.x cannot upgrade an already-connected net.Socket to TLS in-process
// (tls.connect({ socket }) / server-side `new TLSSocket(sock, { isServer })`
// never complete their handshake under Bun). Node supports it fully. The
// sibling smtp-connector.test.ts therefore spawns THIS file with `node` to
// exercise the connector's real STARTTLS upgrade branch against a live mock
// SMTP server that performs a genuine TLS handshake.
//
// Protocol exercised end-to-end over a real upgraded channel:
//   greeting -> EHLO (STARTTLS advertised) -> STARTTLS -> TLS handshake ->
//   re-EHLO over TLS -> AUTH PLAIN -> MAIL/RCPT/DATA -> receipt.
//
// Exit code 0 = success. Any assertion failure throws and exits non-zero with a
// diagnostic on stderr, which the parent test surfaces.
//
// The mock presents a self-signed cert; the parent passes
// NODE_TLS_REJECT_UNAUTHORIZED=0 so the connector (which does not pin a CA for
// this in-process fixture) completes the handshake.
// ---------------------------------------------------------------------------

import { createServer, type Socket, type AddressInfo } from 'node:net';
import { TLSSocket } from 'node:tls';
import { SmtpConnector } from '../../../daemon/email/smtp-connector.ts';

// Self-signed cert (CN=127.0.0.1, SAN IP:127.0.0.1). Test fixture only.
const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDHDCCAgSgAwIBAgIUM5LVIihriMUi7wOSBYF7kx59qcwwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMCAXDTI2MDYyMTA2MTAzOFoYDzIxMjYw
NTI4MDYxMDM4WjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCqCsrpQYLxTW8PQHbx/aj0mZ/U3NfR7RMtP3LExz18
BO1btUmWBw3JrJpnB2HFEgGPZryOiVi2dJqGdxQwPSgQOHh6835+CTbAMNo7jiT0
ZNPKPscobBbGEP9rHtagidtc+wMabJOEoG8oAoJM140rAnAWM724ExTP1N99QCHD
4PyDCLE/N/MDNmo1Lo5VeGADvroBuNuK5aN3L853E/tS6JTE/TDO3iQoGPcCU+gp
y59GI+ukkEzLsrCQQ3I8wChXod2XNujTul3Eg3Ujkit7S++boatu9VORS8PVqb95
xatyU+Anb02fWPBzrPKHgS1YOc0YVhr/dBvLNjYG5UdRAgMBAAGjZDBiMB0GA1Ud
DgQWBBS+1LXwOTsH56upz+bnokO3xvQaWDAfBgNVHSMEGDAWgBS+1LXwOTsH56up
z+bnokO3xvQaWDAPBgNVHRMBAf8EBTADAQH/MA8GA1UdEQQIMAaHBH8AAAEwDQYJ
KoZIhvcNAQELBQADggEBAAgL61xJlilz3INuw2Ccla4IqJz5RDwBXCXwtc1VmDRI
TzT8CbGZhTDP0gGwe6V35CIoG6Ofwxak58+RiiSr1xT+Cziop305nA35TdUUs227
5W0rc96cbD0UrbAF5oND9Chy1Hzh5UxR5gtt2zuFFtgUBWHbDoreuEDTVrxO15qK
4PRjchrz5JKcdDAWrZfBRIb3JZwuD9bDKlyZd/YDSEp4b4QGs14K+gmvGrwg2FLa
Vt0F6YZy8Zz1fatf7N4EQN96tNvLQECbtLBP6bStkoJf+MK7uk4Ij8Y/p5LE8shb
YBXxXHAm5DaQil3MC9Oti/j/aS9J7Le675lt/1vSe0I=
-----END CERTIFICATE-----
`;
const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCqCsrpQYLxTW8P
QHbx/aj0mZ/U3NfR7RMtP3LExz18BO1btUmWBw3JrJpnB2HFEgGPZryOiVi2dJqG
dxQwPSgQOHh6835+CTbAMNo7jiT0ZNPKPscobBbGEP9rHtagidtc+wMabJOEoG8o
AoJM140rAnAWM724ExTP1N99QCHD4PyDCLE/N/MDNmo1Lo5VeGADvroBuNuK5aN3
L853E/tS6JTE/TDO3iQoGPcCU+gpy59GI+ukkEzLsrCQQ3I8wChXod2XNujTul3E
g3Ujkit7S++boatu9VORS8PVqb95xatyU+Anb02fWPBzrPKHgS1YOc0YVhr/dBvL
NjYG5UdRAgMBAAECggEADi2yc+7sHNQGtsw6psyuf//Hy6NjBQx6OP+Fgbo1yp+s
DYWxJjb+G7L+WGktijXJRsRrpEx4RtVz9ZKcDrYovyqAREtFoLuCstWX+teMRgsa
vE5OA7U4lGkiLRPQFGiOT6NYA8XqKojIn/rOk9r02NFeGIHVt9Gyfm5q+LoGXrti
75/wBDDM3yPKwSy+Vf6Q5Hikvdv4bHBd+4wh326ezKGHJVPrywpz9duscyCWDt+g
wqtxEemyqZopDAfWdPwzj06+s+PQKgEtASdMght3f5plnzeEjqdZItAQV+Px532w
TUAouIKFBBwn5iKmb4iZ7Ad9/G4+plo8eombd0ZXiQKBgQDW02f8gp2J5ge/Lk+k
hl+KwrnVtg6k0i9GiWcFl2QCFGU3dZO1j9ws9gvLmDNtnuu6s3OX8pqhL/ss4Hez
XzUPt4XzpatizP1TBjiBMWg+FuyvW/BhVc7BJ2sHfOxr+K8Pk/vxuV8Rz6/TNel4
2LbGIwC0uCdNwl9ATJlVWC1jmQKBgQDKogrRq5m7+J3Yo7s7r5veZKl12SxVwAM/
gdmPPk51A2aO7vyOmfp51ik9Y74IgfQJW3DtGgjlvKWPKruo/wsG2L6Euws+LAM2
Tp6LG3darSvF/bDL4pEg/vJWQgpelKX5vBav1zGg2QQbmAX1knhUZ47b9W6A8a/b
ms9+1LtUeQKBgAPgtwzQ0sUteNBTpq5impDnqPEZozQIc0ADtO9d5zk+YwFYRv1N
Bn1tR5M6QRtmdfzdxmVkxLPKKO+Lcb20J0IMXweh4vEaoCwCfbyfRrFwOn+D2lf3
c477BiyRbbcZOxe95Rtc7EFnDVZzr641wz7aXOXmORdnPc7sUww+VjtpAoGAAPL/
X/oQz0ub2a7yqpXpAgKwtIee6Ivst/hwv3YIQg4RBexirHxWKwnwyYPVGQ8ayIxw
G/w6PHFEyUXm+SSwtYiAY/jIVbM5FKELpxUq2vbitJu6n0nhaiknk3XdvJGvsVrL
NGmqptk9Zq+wn3TfMW4GwksFCH+ZVksEW9C9S+kCgYBweclk8HeKCKlRr2t35ulA
4e3ax2vcvwW1CvLgilFuOFsFyQqr7rR0PKmG0HYHSPd9DvpjClxRPjjO/4GTqg0H
8vJ5waFAVn3LD7qKB4a4KNIqLPvPjx37vBU2eYko0H674eU3pDOBVKsZY33JoHAh
N2RAV4M15BM7kM+pS7htWA==
-----END PRIVATE KEY-----
`;

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

interface MockState {
  commands: string[];
  dataPayload: string;
  upgraded: boolean;
}

function startMock(state: MockState): Promise<{ port: number; close(): void }> {
  const server = createServer((rawSocket: Socket) => {
    let buffer = '';
    let inData = false;

    const writeEhlo = (sock: Socket | TLSSocket): void => {
      sock.write('250-mock.smtp\r\n');
      sock.write('250-PIPELINING\r\n');
      if (!state.upgraded) sock.write('250-STARTTLS\r\n');
      sock.write('250 AUTH PLAIN\r\n');
    };

    const processLine = (sock: Socket | TLSSocket, line: string): void => {
      if (inData) {
        if (line === '.') {
          inData = false;
          sock.write('250 OK queued as ABC123\r\n');
        } else {
          state.dataPayload += line + '\r\n';
        }
        return;
      }
      state.commands.push(line);
      const upper = line.toUpperCase();
      if (upper.startsWith('EHLO')) {
        writeEhlo(sock);
      } else if (upper === 'STARTTLS' && !state.upgraded) {
        sock.write('220 Ready to start TLS\r\n');
        upgradeToTls(sock as Socket);
      } else if (upper.startsWith('AUTH PLAIN')) {
        sock.write('235 2.7.0 Authentication successful\r\n');
      } else if (upper.startsWith('MAIL FROM')) {
        sock.write('250 OK\r\n');
      } else if (upper.startsWith('RCPT TO')) {
        sock.write('250 OK\r\n');
      } else if (upper === 'DATA') {
        inData = true;
        sock.write('354 End data with <CRLF>.<CRLF>\r\n');
      } else if (upper === 'QUIT') {
        sock.write('221 Bye\r\n');
        sock.end();
      } else {
        sock.write('500 unrecognized\r\n');
      }
    };

    const drain = (sock: Socket | TLSSocket): void => {
      for (;;) {
        const idx = buffer.indexOf('\r\n');
        if (idx < 0) return;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        processLine(sock, line);
      }
    };

    const bind = (sock: Socket | TLSSocket): void => {
      sock.setEncoding('utf-8');
      sock.on('data', (chunk: string | Buffer) => {
        buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
        drain(sock);
      });
    };

    const upgradeToTls = (plain: Socket): void => {
      buffer = '';
      plain.removeAllListeners('data');
      const secure = new TLSSocket(plain, { isServer: true, cert: TEST_TLS_CERT, key: TEST_TLS_KEY });
      secure.on('secure', () => { state.upgraded = true; });
      bind(secure);
    };

    rawSocket.write('220 mock.smtp ESMTP ready\r\n');
    bind(rawSocket);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ port, close: () => server.close() });
    });
  });
}

async function main(): Promise<void> {
  const state: MockState = { commands: [], dataPayload: '', upgraded: false };
  const mock = await startMock(state);
  try {
    // Secure default posture: plain connect that MUST upgrade via STARTTLS,
    // allowPlaintext disabled so a non-upgradable server would be rejected.
    const smtp = new SmtpConnector({
      host: '127.0.0.1',
      port: mock.port,
      user: 'user@x.com',
      password: 'secret-pass',
      secure: false,
      from: 'Sender <sender@x.com>',
      timeoutMs: 5000,
      allowPlaintext: false,
    });
    await smtp.connect();
    const result = await smtp.send({ to: 'bob@y.com', subject: 'Secure', body: 'over tls' });
    await smtp.close();

    assert(state.upgraded, 'server should have completed the TLS upgrade');
    assert(state.commands.includes('STARTTLS'), 'STARTTLS command should have been issued');
    const ehloCount = state.commands.filter((c) => c.toUpperCase().startsWith('EHLO')).length;
    assert(ehloCount === 2, `EHLO should be issued twice (pre + post upgrade), got ${ehloCount}`);
    assert(state.commands.join('\n').includes('AUTH PLAIN'), 'AUTH PLAIN should have run over TLS');
    assert(result.messageId.includes('@x.com'), 'receipt messageId should carry the from domain');
    assert(state.dataPayload.includes('Subject: Secure'), 'DATA payload should carry the subject');
    assert(state.dataPayload.includes('over tls'), 'DATA payload should carry the body');
    assert(!state.dataPayload.includes('secret-pass'), 'password must never appear in DATA payload');
  } finally {
    mock.close();
  }
}

main().then(
  () => { process.stdout.write('STARTTLS_UPGRADE_OK\n'); process.exit(0); },
  (err) => { process.stderr.write(String(err?.stack ?? err) + '\n'); process.exit(1); },
);
