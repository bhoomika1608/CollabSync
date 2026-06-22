/**
 * App.tsx — Root component: initialises the CollabSyncProvider and
 * wires its callbacks into React state for the rest of the UI.
 *
 * State management strategy:
 * ─────────────────────────────────────────────────────────────────
 * The provider is created once in a useEffect and stored in a ref
 * (providerRef) for stable access. Its event callbacks update React
 * state, triggering re-renders only where needed:
 *   • status + pendingUpdates → Header + OfflineBar
 *   • remoteUsers             → PresenceList + CollabEditor (cursors)
 *
 * The provider ref is also exposed as state (providerState) so that
 * CollabEditor (which needs the provider) renders only after it's ready.
 */

import React, { useState, useEffect, useRef } from 'react';
import { CollabSyncProvider, type RemoteUser, type ConnectionStatus } from './lib/provider';
import { generateUserId, generateUserName, getColorForUser } from './lib/colors';
import { CollabEditor } from './components/CollabEditor';
import { PresenceList } from './components/PresenceList';
import { OfflineBar } from './components/OfflineBar';
import { Header } from './components/Header';

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

// The Socket.io client connects to the same origin as the page.
// In dev: http://localhost:5173 -> Vite proxies /socket.io -> nginx -> backends.
// In prod: the static build is served from the same nginx, so origin is fine.
const SERVER_URL = window.location.origin;

// ─────────────────────────────────────────────────────────────
// User identity (persisted to localStorage so it survives refreshes)
// ─────────────────────────────────────────────────────────────

function getOrCreateIdentity() {
  let userId = localStorage.getItem('cs:userId');
  let userName = localStorage.getItem('cs:userName');

  if (!userId) {
    userId = generateUserId();
    localStorage.setItem('cs:userId', userId);
  }
  if (!userName) {
    userName = generateUserName();
    localStorage.setItem('cs:userName', userName);
  }

  return {
    userId,
    userName,
    userColor: getColorForUser(userId),
  };
}

// ─────────────────────────────────────────────────────────────
// Root component
// ─────────────────────────────────────────────────────────────

export default function App() {
  const identity = useRef(getOrCreateIdentity());
  const [userName, setUserName] = useState<string>(identity.current.userName);
  const userColor = identity.current.userColor;
  const userId = identity.current.userId;

  const [isNameModalOpen, setIsNameModalOpen] = useState<boolean>(() => {
    return localStorage.getItem('cs:hasSetUserName') !== 'true';
  });

  const [docId, setDocId] = useState<string>(() => {
    const path = window.location.pathname;
    if (path.startsWith('/doc/')) {
      const id = path.slice(5).trim();
      if (id) return id;
    }
    // Default redirect to /doc/default without full page reload
    window.history.replaceState(null, '', '/doc/default');
    return 'default';
  });

  const providerRef = useRef<CollabSyncProvider | null>(null);
  const [provider, setProvider] = useState<CollabSyncProvider | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [pendingUpdates, setPendingUpdates] = useState(0);
  const [remoteUsers, setRemoteUsers] = useState<RemoteUser[]>([]);

  useEffect(() => {
    const handlePopState = () => {
      const path = window.location.pathname;
      if (path.startsWith('/doc/')) {
        const id = path.slice(5).trim();
        if (id) {
          setDocId(id);
          return;
        }
      }
      setDocId('default');
    };
    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  useEffect(() => {
    const p = new CollabSyncProvider(SERVER_URL, docId, userId, userName, userColor);

    p.onStatusChange = (s, pending) => {
      setStatus(s);
      setPendingUpdates(pending);
    };

    p.onUsersChange = users => {
      // Spread to a new array so React detects the change and re-renders.
      setRemoteUsers([...users]);
    };

    providerRef.current = p;
    setProvider(p);

    return () => {
      p.destroy();
      setProvider(null);
    };
  }, [docId]); // Recreate provider when docId changes

  const handleNewDoc = () => {
    const newId = Math.random().toString(36).substring(2, 10);
    window.history.pushState(null, '', `/doc/${newId}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  };

  // While provider is being constructed, show loading screen.
  if (!provider) {
    return (
      <div className="h-screen flex items-center justify-center bg-[#030712]">
        <div className="flex flex-col items-center gap-4 text-slate-400">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center text-2xl shadow-lg shadow-blue-500/20 animate-bounce">
            ⚡
          </div>
          <p className="text-sm">Connecting to CollabSync (doc/{docId})…</p>
        </div>
      </div>
    );
  }

  const currentUser = { userId, name: userName, color: userColor };

  const handleSaveName = (newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    localStorage.setItem('cs:userName', trimmed);
    localStorage.setItem('cs:hasSetUserName', 'true');
    setUserName(trimmed);
    if (providerRef.current) {
      providerRef.current.updateName(trimmed);
    }
    setIsNameModalOpen(false);
  };

  return (
    <div id="app-root" className="flex flex-col h-screen bg-[#030712] text-white overflow-hidden">
      {/* ── Header ──────────────────────────────────────────── */}
      <Header
        userName={userName}
        userColor={userColor}
        docId={docId}
        status={status}
        onNewDoc={handleNewDoc}
        onEditName={() => setIsNameModalOpen(true)}
      />

      {/* ── Offline / reconnecting banner ───────────────────── */}
      <OfflineBar status={status} pendingUpdates={pendingUpdates} />

      {/* ── Body ────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* Sidebar */}
        <aside
          className="
            w-56 shrink-0
            bg-[#0f172a]
            border-r border-[#1e293b]
            flex flex-col
            overflow-hidden
          "
        >
          <PresenceList currentUser={currentUser} remoteUsers={remoteUsers} />
        </aside>

        {/* Editor area */}
        <main className="flex-1 flex flex-col overflow-hidden relative">
          {/* Thin colored top bar showing server instance info */}
          <div className="shrink-0 flex items-center gap-2 px-4 py-1.5 bg-[#0a0f1a] border-b border-[#1e293b]">
            <span className="text-[11px] text-slate-600 font-mono">
              doc/{docId}
            </span>
            <span className="text-slate-700 text-[11px]">·</span>
            <span className="text-[11px] text-slate-600">
              {status === 'connected' ? (
                <span className="text-emerald-500">● synced</span>
              ) : status === 'offline' ? (
                <span className="text-red-500">● offline</span>
              ) : (
                <span className="text-yellow-500">● {status}</span>
              )}
            </span>
            {remoteUsers.length > 0 && (
              <>
                <span className="text-slate-700 text-[11px]">·</span>
                <span className="text-[11px] text-slate-500">
                  {remoteUsers.length} other{remoteUsers.length !== 1 ? 's' : ''} editing
                </span>
              </>
            )}
          </div>

          <div className="flex-1 overflow-hidden">
            <CollabEditor provider={provider} remoteUsers={remoteUsers} />
          </div>
        </main>
      </div>

      {/* ── Username Modal Overlay ──────────────────────────── */}
      {isNameModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md animate-fade_in">
          <div className="
            w-full max-w-md p-6 rounded-2xl
            bg-slate-900/90 border border-slate-800
            shadow-2xl shadow-black/50
            flex flex-col gap-4
            mx-4
          ">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center text-xl shadow-lg shadow-blue-500/20">
                👤
              </div>
              <div>
                <h3 className="text-base font-semibold text-white">
                  Set Your Display Name
                </h3>
                <p className="text-xs text-slate-400">
                  How should others see you in this document?
                </p>
              </div>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                const formData = new FormData(e.currentTarget);
                const name = formData.get('name') as string;
                handleSaveName(name);
              }}
              className="flex flex-col gap-4 mt-2"
            >
              <div className="relative">
                <input
                  type="text"
                  name="name"
                  required
                  defaultValue={userName}
                  placeholder="Enter username..."
                  maxLength={20}
                  className="
                    w-full px-4 py-3 rounded-xl
                    bg-slate-950 border border-slate-800 focus:border-blue-500/50
                    text-sm text-white placeholder-slate-600
                    outline-none transition-all duration-200
                    focus:shadow-lg focus:shadow-blue-500/5
                  "
                  autoFocus
                />
              </div>

              <div className="flex justify-end gap-2.5 mt-2">
                {localStorage.getItem('cs:hasSetUserName') === 'true' && (
                  <button
                    type="button"
                    onClick={() => setIsNameModalOpen(false)}
                    className="
                      px-4 py-2 rounded-xl
                      bg-slate-800 hover:bg-slate-700
                      text-xs font-semibold text-slate-300 hover:text-white
                      transition-all duration-200
                    "
                  >
                    Cancel
                  </button>
                )}
                <button
                  type="submit"
                  className="
                    px-5 py-2 rounded-xl
                    bg-gradient-to-r from-blue-500 to-violet-600 hover:from-blue-600 hover:to-violet-700
                    text-xs font-semibold text-white
                    shadow-md shadow-blue-500/10 hover:shadow-lg hover:shadow-blue-500/20
                    transition-all duration-200
                  "
                >
                  Save Display Name
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
