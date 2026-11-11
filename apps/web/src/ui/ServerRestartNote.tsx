// "Saving… the server is restarting, trying again." A calm note, not an
// error, while a save waits for the server to come back (serverRestart.ts).

import { useSyncExternalStore } from 'react';
import { onServerRestarting, serverRestarting } from '../serverRestart';

export function ServerRestartNote() {
  const restarting = useSyncExternalStore(onServerRestarting, serverRestarting, () => false);
  if (!restarting) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] z-[90] flex justify-center px-4">
      <p role="status" data-testid="server-restart-note" className="rounded-full border border-line bg-panel px-4 py-2 text-sm text-ink shadow-pop">
        Saving… the server is restarting, trying again.
      </p>
    </div>
  );
}
