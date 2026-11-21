import { describe, expect, it } from 'vitest';
import { BrowserImport, FallBack } from '../browserImport';

describe('BrowserImport when the worker fails before the first question', () => {
  it('answers the first question with the failure, so the server can take over', async () => {
    const fake = { onmessage: null, onerror: null, onmessageerror: null, postMessage: () => undefined, terminate: () => undefined } as unknown as Worker;
    const b = new BrowserImport(() => undefined, () => fake);
    // The worker's code fails to load while the catalog is still coming.
    (fake.onerror as unknown as (e: { message: string }) => void)({ message: 'load failed' });
    await expect(b.analyse(new File(['0 x'], 'a.ldr'), {} as never, [])).rejects.toBeInstanceOf(FallBack);
  });
});
