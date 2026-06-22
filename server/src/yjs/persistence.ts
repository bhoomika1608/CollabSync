/**
 * persistence.ts — MongoDB snapshot persistence for CollabSync documents.
 *
 * ═══════════════════════════════════════════════════════════════
 * SNAPSHOT STRATEGY — WHY a single upserted document per docId?
 * ═══════════════════════════════════════════════════════════════
 *
 * An append log would require replaying potentially thousands of Yjs ops on
 * every server start-up. Y.encodeStateAsUpdate (with no state-vector filter)
 * produces a compact, self-contained binary that represents the ENTIRE document.
 * Restoring it is a single Y.applyUpdate call — O(n) in document size,
 * independent of edit history.
 *
 * Trade-off: we lose fine-grained per-edit undo history across server restarts.
 * For a collaborative text editor this is acceptable — undo is per-session and
 * handled by Yjs UndoManager on the client, not by replaying server history.
 *
 * ═══════════════════════════════════════════════════════════════
 * WRITE PATTERN — findOneAndUpdate with { upsert: true }
 * ═══════════════════════════════════════════════════════════════
 *
 * WHY upsert instead of save() or insertOne?
 *   • Idempotent: works correctly whether the document exists or not.
 *   • Atomic: MongoDB's findAndModify guarantees no race condition between
 *     the check-then-write, even if two server instances flush the same docId
 *     simultaneously (which can happen with two active instances).
 *   • Single round-trip: one network call to MongoDB vs. two for find-then-save.
 *
 * ═══════════════════════════════════════════════════════════════
 * READ PATTERN — findOne sorted by updatedAt descending
 * ═══════════════════════════════════════════════════════════════
 *
 * Since we upsert a single record per docId, the sort is technically redundant,
 * but it's defensive: if a bug created multiple records for the same docId,
 * we always load the most recent one rather than an arbitrary one.
 */

import mongoose, { Schema, Document, Model } from 'mongoose';

// ─────────────────────────────────────────────────────────────
// Schema definition
// ─────────────────────────────────────────────────────────────

interface IDocumentSnapshot extends Document {
  /** The collaborative document identifier (matches yjsRoom's docId). */
  docId: string;
  /**
   * Binary encoding of the full Y.Doc state (Y.encodeStateAsUpdate output).
   * Stored as a Buffer (MongoDB Binary subtype 0). Read back and wrapped in
   * Uint8Array before passing to Y.applyUpdate.
   */
  update: Buffer;
  /**
   * Monotonically increasing version counter. Incremented on every save.
   * Useful for debugging: you can inspect MongoDB and see how many times
   * a document has been snapshotted without decoding the binary.
   */
  version: number;
  /** Wall-clock time of the last successful save. Used for the sort-by-recency read. */
  updatedAt: Date;
}

const DocumentSnapshotSchema = new Schema<IDocumentSnapshot>(
  {
    docId: {
      type: String,
      required: true,
      unique: true,  // enforces one snapshot record per document
      index: true,   // makes findOne({ docId }) fast even with many documents
    },
    update: {
      type: Buffer,
      required: true,
    },
    version: {
      type: Number,
      default: 0,
    },
  },
  {
    // WHY timestamps: true?
    // Mongoose automatically manages createdAt and updatedAt fields.
    // We expose updatedAt in the query sort so we always read the most
    // recently written snapshot.
    timestamps: true,
  },
);

// Lazily initialise the model. Mongoose caches models by name, so calling
// mongoose.model() with the same name twice returns the same model — safe
// to call at module load time even before connectMongo() runs.
let DocumentSnapshot: Model<IDocumentSnapshot>;

function getModel(): Model<IDocumentSnapshot> {
  if (!DocumentSnapshot) {
    // WHY guard against re-registration?
    // During Jest tests, modules are re-required between test files. Calling
    // mongoose.model('DocumentSnapshot', schema) twice throws OverwriteModelError.
    // The guard makes the module idempotent.
    DocumentSnapshot =
      (mongoose.models['DocumentSnapshot'] as Model<IDocumentSnapshot>) ??
      mongoose.model<IDocumentSnapshot>('DocumentSnapshot', DocumentSnapshotSchema);
  }
  return DocumentSnapshot;
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/**
 * Load the most recent snapshot for `docId` from MongoDB.
 * Returns null if no snapshot exists yet (new document — start from empty Y.Doc).
 *
 * WHY .lean()?
 * .lean() returns a plain JS object instead of a Mongoose Document instance.
 * This avoids the Mongoose Document prototype chain overhead and makes the
 * Buffer → Uint8Array conversion simpler (no .toObject() call needed).
 */
export async function loadSnapshot(docId: string): Promise<Uint8Array | null> {
  try {
    const model = getModel();
    const record = await model
      .findOne({ docId })
      .sort({ updatedAt: -1 })
      .lean()
      .exec();

    if (!record) return null;

    // MongoDB stores Buffer as Binary. The lean() result gives us a Buffer
    // (Node.js Buffer extends Uint8Array, so this cast is safe and zero-copy).
    return new Uint8Array(record.update.buffer);
  } catch (err) {
    // WHY swallow and return null instead of throwing?
    // A read failure (e.g., MongoDB restart mid-query) should not prevent a
    // room from being created. The room starts empty and collaboration continues;
    // the next save cycle will attempt to persist again. yjsRoom.ts already
    // wraps this call in its own try/catch, but being defensive here keeps
    // the error handling explicit.
    console.error(`[persistence] loadSnapshot failed for "${docId}":`, err);
    return null;
  }
}

/**
 * Persist a full Y.Doc binary update to MongoDB for `docId`.
 *
 * Uses findOneAndUpdate with upsert:true so the operation is:
 *   • Safe to call multiple times (idempotent)
 *   • Atomic (no lost-update race between two server instances)
 *   • Single round-trip
 *
 * WHY $inc version instead of setting it explicitly?
 * $inc is an atomic server-side increment — no read-modify-write cycle needed.
 * Two concurrent saves from server:1 and server:2 will each increment correctly
 * without overwriting each other's counter.
 */
export async function saveSnapshot(
  docId: string,
  update: Uint8Array,
): Promise<void> {
  try {
    const model = getModel();
    await model.findOneAndUpdate(
      { docId },
      {
        $set: {
          update: Buffer.from(update),
          // updatedAt is managed by Mongoose timestamps:true, but we set it
          // explicitly here as well so the sort in loadSnapshot is reliable
          // even if Mongoose's automatic update is delayed.
          updatedAt: new Date(),
        },
        $inc: { version: 1 },
      },
      {
        upsert: true,   // insert if no record exists for this docId
        new: true,      // return the updated document (unused here, but good practice)
      },
    );

    console.log(`[persistence] Snapshot saved for "${docId}".`);
  } catch (err) {
    // WHY not rethrow?
    // A failed snapshot is bad (we'll lose up to snapshotIntervalMs of edits
    // if the server crashes before the next attempt) but it's not fatal.
    // Active clients can keep collaborating; the next interval will retry.
    // yjsRoom.ts also wraps this in its own catch, so this is a second line
    // of defence for visibility.
    console.error(`[persistence] saveSnapshot failed for "${docId}":`, err);
    throw err; // re-throw so yjsRoom.ts can log and reset its counter
  }
}

