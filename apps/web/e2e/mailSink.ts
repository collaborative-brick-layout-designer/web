// A tiny local SMTP server for the specs that check an email went out:
// it says yes to everything and keeps each message (who it went to, its
// subject and its text). Point the site at it with dbHelpers' useSmtp.

import { createServer, type Socket } from 'node:net';

export interface SentMail {
  to: string[];
  subject: string;
  body: string;
}

export interface MailSink {
  host: string;
  port: number;
  mails: SentMail[];
  /** The user name and password each signed-in connection gave (AUTH PLAIN), oldest first. */
  logins: { user: string; pass: string }[];
  /** The mails to `address`. */
  to: (address: string) => SentMail[];
  close: () => Promise<void>;
}

function headerOf(data: string, name: string): string {
  const head = data.split(/\r\n\r\n/)[0] ?? '';
  const unfolded = head.replace(/\r\n[ \t]+/g, ' ');
  return new RegExp(`^${name}: (.*)$`, 'mi').exec(unfolded)?.[1]?.trim() ?? '';
}

/** The text with quoted-printable soft breaks and =XX bytes undone (nodemailer's usual encoding). */
function unquote(text: string): string {
  const soft = text.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < soft.length; i++) {
    const hex = soft.slice(i + 1, i + 3);
    if (soft[i] === '=' && /^[0-9A-F]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else bytes.push(...Buffer.from(soft[i]!, 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

export async function startMailSink(): Promise<MailSink> {
  const mails: SentMail[] = [];
  const logins: { user: string; pass: string }[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => sockets.delete(sock));
    let buf = '';
    let inData = false;
    let to: string[] = [];
    const say = (line: string) => sock.write(`${line}\r\n`);
    say('220 mail-sink ESMTP');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          const data = buf.slice(0, end);
          buf = buf.slice(end + 5);
          inData = false;
          mails.push({ to, subject: headerOf(data, 'Subject'), body: unquote(data.split(/\r\n\r\n/).slice(1).join('\n\n')) });
          to = [];
          say('250 OK');
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO') sock.write('250-mail-sink\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n');
        else if (verb === 'AUTH') {
          // AUTH PLAIN <base64 of \0user\0password>: any login is fine, and kept.
          const [, user = '', pass = ''] = Buffer.from(line.split(' ')[2] ?? '', 'base64').toString('utf8').split('\0');
          logins.push({ user, pass });
          say('235 OK');
        }
        else if (verb === 'RCPT') {
          to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
          say('250 OK');
        } else if (verb === 'DATA') {
          inData = true;
          say('354 Go ahead');
        } else if (verb === 'RSET') {
          to = [];
          say('250 OK');
        } else if (verb === 'QUIT') {
          say('221 Bye');
          sock.end();
          return;
        } else say('250 OK');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    host: '127.0.0.1',
    port,
    mails,
    logins,
    to: (a) => mails.filter((m) => m.to.some((t) => t.toLowerCase() === a.toLowerCase())),
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
