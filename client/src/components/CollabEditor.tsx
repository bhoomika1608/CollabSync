/**
 * CollabEditor.tsx — CodeMirror 6 editor with bidirectional Y.Text binding
 * and remote cursor decorations.
 *
 * ── Text sync ────────────────────────────────────────────────────────────────
 * Local edits:  CM updateListener → Y.Doc.transact (origin='local') → provider
 *               sends doc:update to server → server re-broadcasts to peers.
 * Remote edits: Y.Text observer receives update from provider → dispatches
 *               changes into CM with RemoteUpdate annotation.
 *
 * The RemoteUpdate annotation prevents the updateListener from echoing the
 * remote change back to Y.Text, avoiding an infinite update loop.
 *
 * ── Cursor rendering ─────────────────────────────────────────────────────────
 * Remote cursors are rendered as CodeMirror widget decorations.
 * A StateField holds the current DecorationSet; a StateEffect replaces it
 * whenever the remoteUsers prop changes.
 * Each widget is a small DOM element styled via CSS variables for the color.
 */

import React, { useEffect, useRef } from 'react';
import {
  EditorState,
  StateField,
  StateEffect,
  Annotation,
  type Extension,
  type Range,
} from '@codemirror/state';
import {
  EditorView,
  Decoration,
  type DecorationSet,
  WidgetType,
  keymap,
  lineNumbers,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  highlightActiveLine,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { oneDark } from '@codemirror/theme-one-dark';
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  bracketMatching,
  foldGutter,
  indentOnInput,
} from '@codemirror/language';
import * as Y from 'yjs';
import { type CollabSyncProvider, type RemoteUser } from '../lib/provider';

// ─────────────────────────────────────────────────────────────
// Remote update annotation (breaks the echo-back loop)
// ─────────────────────────────────────────────────────────────
const RemoteUpdate = Annotation.define<boolean>();

// ─────────────────────────────────────────────────────────────
// Cursor widget DOM element
// ─────────────────────────────────────────────────────────────

class RemoteCursorWidget extends WidgetType {
  constructor(
    private readonly name: string,
    private readonly color: string,
  ) {
    super();
  }

  // Reuse existing DOM if name+color are the same (avoids flicker on re-render).
  eq(other: RemoteCursorWidget): boolean {
    return this.name === other.name && this.color === other.color;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'cm-remote-cursor';
    wrap.style.setProperty('--cursor-color', this.color);
    wrap.setAttribute('aria-hidden', 'true');

    const caret = document.createElement('span');
    caret.className = 'cm-remote-cursor-caret';

    const label = document.createElement('span');
    label.className = 'cm-remote-cursor-label';
    label.textContent = this.name;

    wrap.appendChild(caret);
    wrap.appendChild(label);
    return wrap;
  }

  ignoreEvent(): boolean { return true; }
}

// ─────────────────────────────────────────────────────────────
// Remote cursors StateField + StateEffect
// ─────────────────────────────────────────────────────────────

/** Replaces the entire cursor decoration set with a new one. */
const setCursorsEffect = StateEffect.define<RemoteUser[]>();

/**
 * StateField that holds the current DecorationSet for remote cursors.
 * On every transaction it maps existing decorations through the document
 * changes (so cursor positions stay correct as text is inserted/deleted)
 * and replaces the set whenever a setCursorsEffect is dispatched.
 */
const remoteCursorsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    // Keep cursors anchored as text changes around them.
    let mapped = value.map(tr.changes);

    for (const effect of tr.effects) {
      if (effect.is(setCursorsEffect)) {
        const ranges: Range<Decoration>[] = [];
        for (const user of effect.value) {
          if (user.cursor == null) continue;
          // Clamp to doc length so we never produce an out-of-range decoration.
          const anchorClamped = Math.min(Math.max(0, user.cursor.anchor), tr.newDoc.length);
          const headClamped = Math.min(Math.max(0, user.cursor.head), tr.newDoc.length);

          if (anchorClamped !== headClamped) {
            const from = Math.min(anchorClamped, headClamped);
            const to = Math.max(anchorClamped, headClamped);
            ranges.push(
              Decoration.mark({
                attributes: { style: `background-color: ${user.color}26;` },
                class: 'cm-remote-selection',
              }).range(from, to)
            );
          }

          ranges.push(
            Decoration.widget({
              widget: new RemoteCursorWidget(user.name, user.color),
              side: 1, // render AFTER the character at this position
            }).range(headClamped),
          );
        }
        // Decoration.set requires sorted ranges; sort by position.
        ranges.sort((a, b) => {
          if (a.from !== b.from) return a.from - b.from;
          // If positions are the same, place mark decorations before widget decorations.
          return (a.value.spec.widget ? 1 : 0) - (b.value.spec.widget ? 1 : 0);
        });
        mapped = ranges.length > 0
          ? Decoration.set(ranges, true)
          : Decoration.none;
      }
    }
    return mapped;
  },
  provide: f => EditorView.decorations.from(f),
});

// ─────────────────────────────────────────────────────────────
// Editor theme overrides (on top of oneDark)
// ─────────────────────────────────────────────────────────────
const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    background: '#0d1117',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    fontSize: '14px',
    lineHeight: '1.75',
  },
  '.cm-content': {
    padding: '24px 16px',
    minHeight: '100%',
    caretColor: '#e2e8f0',
  },
  '.cm-gutters': {
    background: '#0d1117',
    borderRight: '1px solid #1e293b',
    color: '#4b5563',
  },
  '.cm-activeLineGutter': { background: '#1a2332' },
  '.cm-activeLine': { background: '#1a2332' },
  '.cm-cursor': { borderLeftColor: '#e2e8f0', borderLeftWidth: '2px' },
  '.cm-selectionBackground': { background: '#2563eb44' },
  '&.cm-focused .cm-selectionBackground': { background: '#2563eb55' },
  '.cm-lineNumbers': { minWidth: '40px' },
  '.cm-placeholder': { color: '#4b5563', fontStyle: 'italic' },
});

// ─────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────

interface Props {
  provider: CollabSyncProvider;
  remoteUsers: RemoteUser[];
}

export function CollabEditor({ provider, remoteUsers }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  // ── Initialise editor once (on mount) ─────────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    const { ydoc, ytext } = provider;
    let applyingRemote = false;

    // ── Build extension list ─────────────────────────────────
    const extensions: Extension[] = [
      // Appearance
      oneDark,
      editorTheme,
      // Core features
      history(),
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      drawSelection(),
      dropCursor(),
      rectangularSelection(),
      highlightActiveLine(),
      indentOnInput(),
      bracketMatching(),
      foldGutter(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      // Language
      javascript({ jsx: true, typescript: true }),
      // Keybindings
      keymap.of([...defaultKeymap, ...historyKeymap]),
      // Remote cursors
      remoteCursorsField,
      // ── Local → Y.Text sync ─────────────────────────────────
      // WHY updateListener instead of a custom transaction filter?
      // updateListener fires after the view has been updated, giving us
      // the final changed ranges. A filter would run before the view
      // updates, making it harder to map character positions correctly.
      EditorView.updateListener.of(update => {
        if (update.docChanged) {
          // Skip: this change came FROM Y.Text (would cause echo-back loop).
          if (!update.transactions.some(tr => tr.annotation(RemoteUpdate)) && !applyingRemote) {
            // Convert CodeMirror change ranges to Y.Text operations.
            // WHY wrap in transact? Yjs batches all changes in one transaction,
            // producing a single binary update — more efficient than one update
            // per character range.
            ydoc.transact(() => {
              update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
                if (toA > fromA) {
                  ytext.delete(fromA, toA - fromA);
                }
                if (inserted.length > 0) {
                  ytext.insert(fromA, inserted.toString());
                }
              });
            }, 'local'); // 'local' origin → Y.Doc observer sends to server
          }
        }

        if (update.selectionSet || update.docChanged) {
          // Broadcast this user's cursor position.
          const sel = update.state.selection.main;
          provider.sendCursorUpdate({ anchor: sel.anchor, head: sel.head });
        }
      }),
    ];

    const view = new EditorView({
      state: EditorState.create({
        doc: ytext.toString(),
        extensions,
      }),
      parent: containerRef.current,
    });

    viewRef.current = view;

    // ── Y.Text → CodeMirror sync ─────────────────────────────
    // Fires whenever any client (including remote ones via the server)
    // changes the shared text.
    const ytextObserver = (event: Y.YTextEvent, transaction: Y.Transaction) => {
      // 'local' origin = our own edit already reflected in CM. Skip.
      if (transaction.origin === 'local') return;

      applyingRemote = true;

      // Convert Y.Text delta format to CodeMirror ChangeSpec.
      // Delta format: [{retain: N}, {insert: 'str'}, {delete: N}, ...]
      const changes: { from: number; to?: number; insert?: string }[] = [];
      let index = 0;

      event.delta.forEach((op: { retain?: number; insert?: unknown; delete?: number }) => {
        if (op.retain != null) {
          index += op.retain;
        } else if (op.insert != null) {
          changes.push({ from: index, insert: String(op.insert) });
          index += String(op.insert).length;
        } else if (op.delete != null) {
          changes.push({ from: index, to: index + op.delete });
        }
      });

      if (changes.length > 0) {
        view.dispatch({
          changes,
          // Mark as remote so the updateListener skips it.
          annotations: RemoteUpdate.of(true),
        });
      }

      applyingRemote = false;
    };

    ytext.observe(ytextObserver);

    // Also send cursor cleared when editor loses focus.
    const handleBlur = () => provider.sendCursorUpdate(null);
    view.dom.addEventListener('blur', handleBlur);

    return () => {
      ytext.unobserve(ytextObserver);
      view.dom.removeEventListener('blur', handleBlur);
      view.destroy();
      viewRef.current = null;
    };
  }, [provider]); // provider is stable (created once in App)

  // ── Update remote cursor decorations ──────────────────────
  // Fires whenever the remoteUsers array changes (cursor moved / user joined).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setCursorsEffect.of(remoteUsers) });
  }, [remoteUsers]);

  return (
    <div
      ref={containerRef}
      id="collab-editor"
      className="h-full w-full overflow-hidden"
      aria-label="Collaborative code editor"
    />
  );
}
