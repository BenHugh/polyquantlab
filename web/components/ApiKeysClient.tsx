"use client";

import { formatDateTime } from "@/libs/formatDate";
import { useState } from "react";
import toast from "react-hot-toast";

/**
 * Shape mirrors the rows returned by FastAPI's GET /v1/internal/users/{email}/keys
 * (proxied through /api/keys). Kept loose on purpose — we never want a
 * server-side schema tweak to crash the dashboard rendering.
 */
export interface ApiKeyRow {
  api_key_id: string;
  key_prefix: string;
  label: string | null;
  created_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

export default function ApiKeysClient({
  initialKeys,
}: {
  initialKeys: ApiKeyRow[];
}) {
  const [keys, setKeys] = useState<ApiKeyRow[]>(initialKeys);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  // Plaintext key shown once after creation. Null when no fresh key.
  const [freshKey, setFreshKey] = useState<string | null>(null);

  async function refresh() {
    const res = await fetch("/api/keys", { cache: "no-store" });
    if (res.ok) {
      const body = await res.json();
      setKeys(body.keys ?? []);
    }
  }

  async function createKey() {
    if (creating) return;
    setCreating(true);
    setFreshKey(null);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label || undefined }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(body?.error || `Create failed (${res.status})`);
        return;
      }
      const body = await res.json();
      setFreshKey(body.key);
      setLabel("");
      await refresh();
      toast.success("Key created — copy it now, it won't be shown again.");
    } catch (e: any) {
      toast.error(e?.message || "Create failed");
    } finally {
      setCreating(false);
    }
  }

  async function revokeKey(id: string) {
    if (!confirm("Revoke this key? Any client using it will start failing.")) {
      return;
    }
    try {
      const res = await fetch(`/api/keys/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(body?.error || `Revoke failed (${res.status})`);
        return;
      }
      await refresh();
      toast.success("Key revoked");
    } catch (e: any) {
      toast.error(e?.message || "Revoke failed");
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Copy failed — select and copy manually");
    }
  }

  return (
    <div className="space-y-6">
      {/* Create form */}
      <div className="space-y-2 rounded-lg border border-base-300 p-4">
        <h2 className="font-semibold">Create a key</h2>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            className="input input-bordered flex-1"
            placeholder="Label (e.g. local-dev, prod-bot)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={128}
            disabled={creating}
          />
          <button
            className="btn btn-primary"
            onClick={createKey}
            disabled={creating}
          >
            {creating ? "Creating…" : "Create key"}
          </button>
        </div>

        {freshKey && (
          <div className="alert alert-warning mt-3 flex flex-col items-start gap-2">
            <span className="font-semibold">
              Save this key now — it will not be shown again.
            </span>
            <code className="break-all w-full bg-base-100 p-2 rounded text-xs">
              {freshKey}
            </code>
            <div className="flex gap-2">
              <button
                className="btn btn-xs"
                onClick={() => copy(freshKey)}
              >
                Copy
              </button>
              <button
                className="btn btn-xs btn-ghost"
                onClick={() => setFreshKey(null)}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Key list */}
      <div className="rounded-lg border border-base-300 overflow-x-auto">
        <table className="table table-sm">
          <thead>
            <tr>
              <th>Prefix</th>
              <th>Label</th>
              <th>Created</th>
              <th>Last used</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {keys.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center opacity-60 py-6">
                  No keys yet. Create one above.
                </td>
              </tr>
            )}
            {keys.map((k) => {
              const revoked = !!k.revoked_at;
              return (
                <tr key={k.api_key_id} className={revoked ? "opacity-50" : ""}>
                  <td>
                    <code>{k.key_prefix}…</code>
                  </td>
                  <td>{k.label || <span className="opacity-50">—</span>}</td>
                  <td>{formatDate(k.created_at)}</td>
                  <td>{formatDate(k.last_used_at) || <span className="opacity-50">never</span>}</td>
                  <td>
                    {revoked ? (
                      <span className="badge badge-ghost">revoked</span>
                    ) : (
                      <span className="badge badge-success">active</span>
                    )}
                  </td>
                  <td className="text-right">
                    {!revoked && (
                      <button
                        className="btn btn-xs btn-error btn-outline"
                        onClick={() => revokeKey(k.api_key_id)}
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Locale-independent formatter from libs/formatDate. Returns "" instead
// of "—" for null to keep the table cell visually empty (different
// requirement than the markets table).
function formatDate(iso: string | null): string {
  if (!iso) return "";
  const out = formatDateTime(iso);
  return out === "—" ? "" : out;
}
