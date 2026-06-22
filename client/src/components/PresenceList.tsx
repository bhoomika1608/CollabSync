/**
 * PresenceList.tsx — Sidebar panel listing all currently connected users.
 * Shows the current user at the top, then remote users in join order.
 */

import React from 'react';
import { type RemoteUser } from '../lib/provider';

interface CurrentUser {
  userId: string;
  name: string;
  color: string;
}

interface Props {
  currentUser: CurrentUser;
  remoteUsers: RemoteUser[];
}

function UserCard({
  name,
  color,
  isSelf,
  hasCursor,
}: {
  name: string;
  color: string;
  isSelf: boolean;
  hasCursor: boolean;
}) {
  return (
    <div
      className="
        flex items-center gap-3 px-3 py-2.5 rounded-lg
        transition-all duration-200
        hover:bg-[#1e293b]
        animate-fade_in
      "
    >
      {/* Avatar */}
      <div className="relative shrink-0">
        <div
          className="
            w-8 h-8 rounded-full
            flex items-center justify-center
            text-xs font-bold text-white
            shadow-md
          "
          style={{ background: color }}
        >
          {name.slice(0, 2).toUpperCase()}
        </div>
        {/* Online dot */}
        <span
          className="
            absolute -bottom-0.5 -right-0.5
            w-2.5 h-2.5 rounded-full
            border-2 border-[#111827]
            bg-emerald-400
          "
        />
      </div>

      {/* Name + status */}
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold text-slate-200 truncate">
          {name}
          {isSelf && (
            <span className="ml-1 text-[10px] font-normal text-slate-500">(you)</span>
          )}
        </p>
        <p className="text-[10px] text-slate-500 mt-0.5">
          {hasCursor ? (
            <span className="text-emerald-400">● Editing</span>
          ) : (
            <span>● Viewing</span>
          )}
        </p>
      </div>

      {/* Color swatch */}
      <div
        className="w-2 h-8 rounded-full shrink-0 opacity-60"
        style={{ background: color }}
      />
    </div>
  );
}

export function PresenceList({ currentUser, remoteUsers }: Props) {
  const total = 1 + remoteUsers.length;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Panel header */}
      <div className="px-4 pt-4 pb-3 border-b border-[#1e293b] shrink-0">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">
            Collaborators
          </h2>
          {/* Live count badge */}
          <span
            id="presence-count"
            className="
              px-2 py-0.5 rounded-full
              bg-emerald-500/10 text-emerald-400
              text-xs font-semibold tabular-nums
              border border-emerald-500/20
            "
          >
            {total}
          </span>
        </div>
      </div>

      {/* User list */}
      <div className="flex-1 overflow-y-auto py-2 px-1">
        {/* Current user always first */}
        <UserCard
          name={currentUser.name}
          color={currentUser.color}
          isSelf={true}
          hasCursor={true}
        />

        {/* Remote users */}
        {remoteUsers.map(user => (
          <UserCard
            key={user.socketId}
            name={user.name}
            color={user.color}
            isSelf={false}
            hasCursor={user.cursor !== null}
          />
        ))}

        {/* Empty state */}
        {remoteUsers.length === 0 && (
          <div className="px-3 pt-4 text-center">
            <p className="text-xs text-slate-600 leading-relaxed">
              Open this page in another tab to start collaborating.
            </p>
          </div>
        )}
      </div>

      {/* Footer hint */}
      <div className="px-4 py-3 border-t border-[#1e293b] shrink-0">
        <p className="text-[10px] text-slate-600 text-center leading-relaxed">
          Edits sync via Yjs CRDTs
          <br />
          across {total === 1 ? '1 instance' : `${total} peers`}
        </p>
      </div>
    </div>
  );
}
