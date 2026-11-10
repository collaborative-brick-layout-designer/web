// docker-compose.yml and .env.example agree on ports. HTTP_PORT in .env is
// the port on the self-hoster's computer; compose publishes it onto the
// container's 3000, and the container's own HTTP_PORT stays 3000 (compose's
// `environment` wins over `env_file`), so the server listens where the
// published port and the image's HEALTHCHECK look.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), 'utf8');

describe('docker-compose.yml and .env.example', () => {
  const compose = read('docker-compose.yml');
  const envExample = read('.env.example');

  it('publish the computer’s HTTP_PORT onto the container’s 3000', () => {
    expect(compose).toMatch(/^\s+- "\$\{HTTP_PORT:-3000\}:3000"$/m);
  });

  it('keep the container listening on 3000 whatever HTTP_PORT the .env has', () => {
    const environment = /environment:\n((?:\s+- .*\n)+)/.exec(compose)?.[1] ?? '';
    expect(environment).toMatch(/^\s+- HTTP_PORT=3000$/m);
    expect(compose).toMatch(/env_file: \.env/);
  });

  it('give the example .env a PUBLIC_URL on the same port as its HTTP_PORT', () => {
    const port = /^HTTP_PORT=(\d+)$/m.exec(envExample)?.[1];
    const publicUrl = /^PUBLIC_URL=(\S+)$/m.exec(envExample)?.[1];
    expect(port).toBeTruthy();
    expect(publicUrl).toBeTruthy();
    expect(new URL(publicUrl!).port).toBe(port);
  });

  it('check health on the port the server itself reads (env.ts: HTTP_PORT, PORT, 3000)', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toMatch(/HEALTHCHECK[\s\S]*process\.env\.HTTP_PORT\|\|process\.env\.PORT\|\|3000/);
  });
});
