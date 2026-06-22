/**
 * OfflineBar.tsx — Dismissible status bar shown when the socket disconnects.
 *
 * Shows two states:
 *  • "offline"      — connection lost, edits are being queued locally.
 *  • "reconnecting" — connection restored, syncing missed updates.
 *
 * WHY show a pending-edits count?
 * The user needs to know that their offline edits are NOT lost — they're
 * stored in the local Y.Doc and will merge cleanly on reconnect.
 * Showing the count reassures them that the CRDT is doing its job.
 */

import React from 'react';
import { type ConnectionStatus } from '../lib/provider';

interface Props {
  status: ConnectionStatus;
  pendingUpdates: number;
}

export function OfflineBar({ status, pendingUpdates }: Props) {
  if (status === 'connected' || status === 'connecting') return null;

  const isReconnecting = status === 'reconnecting';

  return (
    <div
      id="offline-bar"
      role="alert"
      aria-live="polite"
      className={`
        flex items-center gap-3 px-5 py-2.5
        text-sm font-medium
        animate-slide_down
        shrink-0
        ${isReconnecting
          ? 'bg-amber-500/10 border-b border-amber-500/30 text-amber-300'
          : 'bg-red-500/10 border-b border-red-500/30 text-red-300'
        }
      `}
    >
      {/* Icon */}
      <span className="text-base shrink-0">
        {isReconnecting ? '🔄' : '📡'}
      </span>

      {/* Message */}
      <span className="flex-1">
        {isReconnecting ? (
          <>Reconnected — syncing {pendingUpdates > 0 ? `${pendingUpdates} queued edit${pendingUpdates !== 1 ? 's' : ''}` : 'changes'}…</>
        ) : (
          <>
            You&apos;re offline.
            {pendingUpdates > 0 && (
              <> <strong>{pendingUpdates} edit{pendingUpdates !== 1 ? 's' : ''}</strong> queued locally and will sync when you reconnect.</>
            )}
            {pendingUpdates === 0 && ' Your edits will sync automatically when reconnected.'}
          </>
        )}
      </span>

      {/* Spinner (reconnecting) or offline badge */}
      <span
        className={`
          text-xs px-2 py-1 rounded-full
          ${isReconnecting
            ? 'bg-amber-500/20 text-amber-300'
            : 'bg-red-500/20 text-red-300'
          }
        `}
      >
        {isReconnecting ? 'Syncing…' : 'Offline'}
      </span>
    </div>
  );
}
