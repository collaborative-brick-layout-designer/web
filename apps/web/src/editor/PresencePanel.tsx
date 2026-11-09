import type { Awareness } from 'y-protocols/awareness';
import { useRemotePeers } from './useAwareness';
import { HelpButton } from '../help/HelpButton';

/** Shows everyone connected to the layout. Renders nothing if alone. */
export function PresencePanel({ awareness }: { awareness: Awareness | null }) {
  const peers = useRemotePeers(awareness);
  if (peers.length === 0) return null;
  return (
    <div className="flex items-center gap-2">
    <div className="flex items-center" aria-label="People here now" role="group">
      {peers.map(({ clientId, state, isIdle }, i) => (
        <span
          key={clientId}
          title={`${state.user.displayName}${isIdle ? ' · idle' : ''}`}
          className={`flex h-[30px] w-[30px] items-center justify-center rounded-full border-2 border-panel text-xs font-bold text-white ${i > 0 ? '-ml-2' : ''}`}
          style={{ backgroundColor: state.user.color, opacity: isIdle ? 0.45 : 1 }}
        >
          <span aria-hidden>{initials(state.user.displayName)}</span>
          <span className="sr-only">{state.user.displayName}</span>
        </span>
      ))}
    </div>
    <HelpButton helpKey="people.here" />
    </div>
  );
}

function initials(name: string): string {
  const parts = String(name ?? '').trim().split(/[\s@._-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? parts[0]![0]! + parts[1]![0]! : (parts[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
}
