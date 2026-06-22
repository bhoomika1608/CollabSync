/**
 * Header.tsx — App header: branding, document info, connection status,
 * and the current user's identity badge.
 */

import React from 'react';
import { type ConnectionStatus } from '../lib/provider';

interface Props {
  userName: string;
  userColor: string;
  docId: string;
  status: ConnectionStatus;
  onNewDoc: () => void;
  onEditName: () => void;
}

const STATUS_CONFIG: Record<
  ConnectionStatus,
  { label: string; dotClass: string; textClass: string }
> = {
  connecting:   { label: 'Connecting…', dotClass: 'bg-yellow-400', textClass: 'text-yellow-400' },
  connected:    { label: 'Live',        dotClass: 'bg-emerald-400', textClass: 'text-emerald-400' },
  reconnecting: { label: 'Syncing…',   dotClass: 'bg-amber-400',   textClass: 'text-amber-400' },
  offline:      { label: 'Offline',    dotClass: 'bg-red-500',     textClass: 'text-red-400' },
};

export function Header({ userName, userColor, docId, status, onNewDoc, onEditName }: Props) {
  const cfg = STATUS_CONFIG[status];

  return (
    <header
      id="app-header"
      className="
        flex items-center justify-between
        px-5 py-3
        bg-[#0f172a]
        border-b border-[#1e293b]
        select-none
        z-10
        shrink-0
      "
    >
      {/* ── Brand ────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        {/* Lightning bolt logo */}
        <div className="
          w-8 h-8 rounded-lg
          bg-gradient-to-br from-blue-500 to-violet-600
          flex items-center justify-center
          shadow-lg shadow-blue-500/20
          text-white text-sm font-bold
        ">
          ⚡
        </div>
        <div>
          <h1 className="text-sm font-semibold text-white leading-none tracking-wide">
            CollabSync
          </h1>
          <p className="text-xs text-slate-400 leading-none mt-0.5">
            doc: <span className="text-slate-300 font-mono">{docId}</span>
          </p>
        </div>
      </div>

      {/* ── Center: status pill ──────────────────────────── */}
      <div
        id="connection-status"
        className="
          flex items-center gap-2
          px-3 py-1.5
          rounded-full
          bg-[#1e293b]
          border border-[#334155]
          text-xs font-medium
        "
      >
        <span className={`
          relative w-2 h-2 rounded-full
          ${cfg.dotClass}
          ${status === 'connected' ? 'animate-pulse_dot' : ''}
        `} />
        <span className={cfg.textClass}>{cfg.label}</span>
      </div>

      {/* ── User identity & actions ────────────────────────── */}
      <div className="flex items-center gap-3">
        <button
          onClick={onNewDoc}
          className="
            px-3 py-1.5 rounded-full
            bg-[#1e293b] hover:bg-[#334155]
            border border-[#334155] hover:border-[#475569]
            text-xs font-medium text-slate-300 hover:text-white
            transition-all duration-200
            shadow-md hover:shadow-lg
          "
        >
          ➕ New Doc
        </button>
        <span className="text-xs text-slate-400 hidden sm:block">You are</span>
        <div
          onClick={onEditName}
          className="
            flex items-center gap-2
            px-3 py-1.5
            rounded-full
            bg-[#1e293b] hover:bg-[#334155]
            border border-[#334155] hover:border-[#475569]
            cursor-pointer
            transition-all duration-200
            active:scale-95
          "
          title="Click to edit name"
        >
          {/* Colored avatar circle */}
          <span
            className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0"
            style={{ background: userColor }}
          >
            {userName.slice(0, 1)}
          </span>
          <span className="text-xs font-medium text-slate-200">{userName}</span>
        </div>
      </div>
    </header>
  );
}
