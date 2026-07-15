// structured engine errors.
// One base class, one convention. Every engine failure — thrown or
// returned via {ok:false, error} — is an EngineError with:
// `category`: a dot-namespaced bucket (e.g. "receive.stall",
//     "manifest.write-fail"). Stable across releases. Callers may
//     branch on category prefix if useful.
// `cause`: a short machine-readable identifier within the category
//     (e.g. "file-stall", "peer-path-traversal"). This is what RN
//     pattern-matches on.
// `message`: human-readable, used in logs and (eventually) in
//     user-visible copy. Never used for control flow.
// `detail?`: optional structured payload — original error code,
//     offending key, size, etc. Must be JSON-serializable.
// Wire transport. `toJSON()` produces a plain object with the four
// fields; `JSON.stringify` calls it automatically, so an EngineError
// instance survives the RPC boundary intact and RN receives a plain
// object shaped identically. `toString()` returns the message so
// defensive `String(err)` in RN code degrades cleanly.
// The taxonomy is documented in claude_doc.md §8 "Error taxonomy" and
// in Unify_process/proposal.md §5.5. Keep the two in sync when adding
// categories.

export class EngineError extends Error {
  constructor({ category, cause, message, detail }) {
    super(message ?? cause ?? String(category ?? "unknown"));
    this.name = "EngineError";
    this.category = String(category ?? "internal.unexpected");
    this.cause = String(cause ?? "unknown");
    if (detail !== undefined) this.detail = detail;
  }

  toJSON() {
    const out = {
      category: this.category,
      cause: this.cause,
      message: this.message,
    };
    if (this.detail !== undefined) out.detail = this.detail;
    return out;
  }

  toString() {
    return this.message || `${this.category}:${this.cause}`;
  }
}

// Wrap an arbitrary caught value (usually from bare-fs, hyperdrive, or
// hyperswarm) into an EngineError. Preserves the underlying error's
// message and code where useful; assigns a fallback category / cause
// when the caller doesn't have a more specific one.
export function wrapError(err, { category, cause, message, detail } = {}) {
  if (err instanceof EngineError) return err;
  return new EngineError({
    category: category || "internal.unexpected",
    cause: cause || err?.code || "unknown",
    message: message || String(err?.message || err),
    detail: {
      ...(detail || {}),
      ...(err?.code ? { code: err.code } : {}),
      ...(err?.name && err.name !== "Error" ? { originalName: err.name } : {}),
    },
  });
}

// Small helper for the common failure-return pattern. Reads left-to-right:
//   return failure("receive", "invalid-link", "expect peardrop:// + 64 hex");
// Produces the {ok:false, error: EngineError} shape.
export function failure(category, cause, message, detail) {
  return {
    ok: false,
    error: new EngineError({ category, cause, message, detail }),
  };
}
