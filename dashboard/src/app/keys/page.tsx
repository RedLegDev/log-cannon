'use client';

import { useState, useEffect } from 'react';
import { Key, Plus, Copy, Check, X, Trash2, ToggleLeft, ToggleRight, AlertCircle, Loader2, Terminal, Pencil } from 'lucide-react';

interface APIKey {
  key_id: string;
  api_key: string;
  name: string;
  scopes: string;
  created_at: string;
  enabled: number;
}

const SCOPE_OPTIONS = [
  { value: 'ingest', label: 'Ingest', desc: 'Write logs only' },
  { value: 'read', label: 'Read', desc: 'Query logs, view dashboards' },
  { value: 'write', label: 'Write', desc: 'Create/update/delete resources' },
  { value: 'admin', label: 'Admin', desc: 'Full access + manage keys' },
];

export default function APIKeysPage() {
  const [keys, setKeys] = useState<APIKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newKeyName, setNewKeyName] = useState('');
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editingKeyId, setEditingKeyId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [newKeyScopes, setNewKeyScopes] = useState<string[]>(['ingest']);
  const [editingScopes, setEditingScopes] = useState<string[]>([]);

  const fetchKeys = async () => {
    try {
      const res = await fetch('/api/keys');
      if (!res.ok) throw new Error('Failed to fetch keys');
      const data = await res.json();
      setKeys(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch API keys');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchKeys();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKeyName.trim()) return;

    setCreating(true);
    try {
      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newKeyName.trim(), scopes: newKeyScopes })
      });
      if (!res.ok) throw new Error('Failed to create key');
      const data = await res.json();
      setCreatedKey(data.apiKey);
      setNewKeyName('');
      setNewKeyScopes(['ingest']);
      await fetchKeys();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create API key');
    } finally {
      setCreating(false);
    }
  };

  const handleToggle = async (keyId: string, currentEnabled: number) => {
    try {
      const res = await fetch('/api/keys', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyId, enabled: currentEnabled === 0 })
      });
      if (!res.ok) throw new Error('Failed to toggle key');
      await fetchKeys();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to toggle API key');
    }
  };

  const handleDelete = async (keyId: string, name: string) => {
    if (!confirm(`Delete API key "${name}"? This cannot be undone.`)) return;

    try {
      const res = await fetch('/api/keys', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyId })
      });
      if (!res.ok) throw new Error('Failed to delete key');
      await fetchKeys();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete API key');
    }
  };

  const startEditing = (key: APIKey) => {
    setEditingKeyId(key.key_id);
    setEditingName(key.name);
    setEditingScopes(key.scopes ? key.scopes.split(',') : ['ingest']);
  };

  const cancelEditing = () => {
    setEditingKeyId(null);
    setEditingName('');
    setEditingScopes([]);
  };

  const handleSaveEdit = async (keyId: string) => {
    if (!editingName.trim()) {
      cancelEditing();
      return;
    }

    try {
      const res = await fetch('/api/keys', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyId, name: editingName.trim(), scopes: editingScopes })
      });
      if (!res.ok) throw new Error('Failed to update key');
      cancelEditing();
      await fetchKeys();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update API key');
    }
  };

  const toggleScope = (scope: string, scopeList: string[], setScopeList: (scopes: string[]) => void) => {
    if (scopeList.includes(scope)) {
      // Don't allow removing the last scope
      if (scopeList.length > 1) {
        setScopeList(scopeList.filter(s => s !== scope));
      }
    } else {
      setScopeList([...scopeList, scope]);
    }
  };

  const copyToClipboard = async (text: string, id?: string) => {
    await navigator.clipboard.writeText(text);
    if (id) {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    }
  };

  const maskKey = (key: string) => {
    return key.substring(0, 8) + '••••••••' + key.substring(key.length - 4);
  };

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-text-primary font-mono">
          API <span className="text-cannon-fire">Keys</span>
        </h1>
        <p className="text-text-secondary text-sm mt-1">
          Manage authentication keys for log ingestion
        </p>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="card-cannon border-cannon-critical/50 bg-cannon-critical/10 p-4 mb-6">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-cannon-critical flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <span className="text-cannon-critical">{error}</span>
            </div>
            <button onClick={() => setError(null)} className="text-cannon-critical hover:text-white">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Created Key Banner */}
      {createdKey && (
        <div className="card-cannon border-cannon-tracer/50 bg-cannon-tracer/10 p-4 mb-6 animate-slide-down">
          <div className="flex items-start gap-3">
            <Check className="w-5 h-5 text-cannon-tracer flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="font-medium text-cannon-tracer mb-2">API Key Created!</div>
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                <code className="flex-1 bg-cannon-black px-4 py-2 rounded-lg font-mono text-sm text-text-code break-all">
                  {createdKey}
                </code>
                <button
                  onClick={() => copyToClipboard(createdKey)}
                  className="flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-cannon-tracer/20 text-cannon-tracer hover:bg-cannon-tracer/30 transition-colors"
                >
                  <Copy className="w-4 h-4" />
                  Copy
                </button>
              </div>
              <p className="text-xs mt-2 text-cannon-warning">
                Save this key now. You won&apos;t be able to see it again.
              </p>
            </div>
            <button onClick={() => setCreatedKey(null)} className="text-cannon-tracer hover:text-white">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Create Key Form */}
      <div className="card-cannon p-4 mb-6">
        <form onSubmit={handleCreate} className="space-y-3">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
              <input
                type="text"
                placeholder="Service name (e.g., order-service)"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                className="input-cannon pl-10 w-full"
              />
            </div>
            <button
              type="submit"
              disabled={creating || !newKeyName.trim()}
              className="btn-cannon flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {creating ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Plus className="w-4 h-4" />
              )}
              {creating ? 'Creating...' : 'Create Key'}
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="text-text-muted text-sm mr-2">Scopes:</span>
            {SCOPE_OPTIONS.map(scope => (
              <button
                key={scope.value}
                type="button"
                onClick={() => toggleScope(scope.value, newKeyScopes, setNewKeyScopes)}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                  newKeyScopes.includes(scope.value)
                    ? 'bg-cannon-fire text-white'
                    : 'bg-cannon-graphite text-text-muted hover:bg-cannon-steel'
                }`}
                title={scope.desc}
              >
                {scope.label}
              </button>
            ))}
          </div>
        </form>
      </div>

      {/* Keys Table */}
      {loading ? (
        <div className="card-cannon p-8 text-center">
          <Loader2 className="w-8 h-8 animate-spin text-cannon-fire mx-auto mb-3" />
          <p className="text-text-secondary">Loading API keys...</p>
        </div>
      ) : keys.length === 0 ? (
        <div className="card-cannon p-8 text-center">
          <div className="w-16 h-16 rounded-full bg-cannon-steel flex items-center justify-center mx-auto mb-4">
            <Key className="w-8 h-8 text-text-muted" />
          </div>
          <h3 className="text-lg font-medium text-text-primary mb-2">No API keys found</h3>
          <p className="text-text-secondary text-sm">
            Create one above to get started with log ingestion.
          </p>
        </div>
      ) : (
        <div className="card-cannon overflow-hidden mb-6">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-cannon-steel">
                <tr className="text-left text-text-secondary text-sm">
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">API Key</th>
                  <th className="px-4 py-3 font-medium">Scopes</th>
                  <th className="px-4 py-3 font-medium hidden md:table-cell">Created</th>
                  <th className="px-4 py-3 text-center font-medium">Status</th>
                  <th className="px-4 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr key={key.key_id} className="border-t border-cannon-graphite hover:bg-cannon-steel/50 transition-colors">
                    <td className="px-4 py-3">
                      {editingKeyId === key.key_id ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={editingName}
                            onChange={(e) => setEditingName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleSaveEdit(key.key_id);
                              if (e.key === 'Escape') cancelEditing();
                            }}
                            className="input-cannon py-1 px-2 text-sm w-40"
                            autoFocus
                          />
                          <button
                            onClick={() => handleSaveEdit(key.key_id)}
                            className="p-1 rounded hover:bg-cannon-tracer/20 text-cannon-tracer"
                            title="Save"
                          >
                            <Check className="w-4 h-4" />
                          </button>
                          <button
                            onClick={cancelEditing}
                            className="p-1 rounded hover:bg-cannon-graphite text-text-muted"
                            title="Cancel"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      ) : (
                        <span className="text-text-primary font-medium font-mono">{key.name}</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <code className="text-text-muted font-mono text-sm">
                          {maskKey(key.api_key)}
                        </code>
                        <button
                          onClick={() => copyToClipboard(key.api_key, key.key_id)}
                          className="p-1.5 rounded hover:bg-cannon-graphite text-text-muted hover:text-text-primary transition-colors"
                          title="Copy full key"
                        >
                          {copiedId === key.key_id ? (
                            <Check className="w-4 h-4 text-cannon-tracer" />
                          ) : (
                            <Copy className="w-4 h-4" />
                          )}
                        </button>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {editingKeyId === key.key_id ? (
                        <div className="flex flex-wrap gap-1">
                          {SCOPE_OPTIONS.map(scope => (
                            <button
                              key={scope.value}
                              type="button"
                              onClick={() => toggleScope(scope.value, editingScopes, setEditingScopes)}
                              className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                                editingScopes.includes(scope.value)
                                  ? 'bg-cannon-fire text-white'
                                  : 'bg-cannon-graphite text-text-muted hover:bg-cannon-steel'
                              }`}
                              title={scope.desc}
                            >
                              {scope.label}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {(key.scopes || 'ingest').split(',').map(scope => (
                            <span
                              key={scope}
                              className="px-2 py-0.5 rounded text-xs font-medium bg-cannon-steel text-text-secondary"
                              title={SCOPE_OPTIONS.find(s => s.value === scope)?.desc}
                            >
                              {scope}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-text-muted text-sm font-mono hidden md:table-cell">
                      {key.created_at}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
                          key.enabled
                            ? 'bg-cannon-tracer/20 text-cannon-tracer'
                            : 'bg-cannon-graphite text-text-muted'
                        }`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${key.enabled ? 'bg-cannon-tracer' : 'bg-text-muted'}`}></span>
                        {key.enabled ? 'Active' : 'Disabled'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => startEditing(key)}
                          className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-cannon-graphite transition-colors"
                          title="Rename"
                        >
                          <Pencil className="w-5 h-5" />
                        </button>
                        <button
                          onClick={() => handleToggle(key.key_id, key.enabled)}
                          className={`p-2 rounded-lg transition-colors ${
                            key.enabled
                              ? 'text-cannon-warning hover:bg-cannon-warning/20'
                              : 'text-cannon-tracer hover:bg-cannon-tracer/20'
                          }`}
                          title={key.enabled ? 'Disable' : 'Enable'}
                        >
                          {key.enabled ? <ToggleRight className="w-5 h-5" /> : <ToggleLeft className="w-5 h-5" />}
                        </button>
                        <button
                          onClick={() => handleDelete(key.key_id, key.name)}
                          className="p-2 rounded-lg text-cannon-critical hover:bg-cannon-critical/20 transition-colors"
                          title="Delete"
                        >
                          <Trash2 className="w-5 h-5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Usage Guide */}
      <div className="card-cannon overflow-hidden">
        <div className="px-4 py-3 bg-cannon-steel border-b border-cannon-graphite flex items-center gap-2">
          <Terminal className="w-4 h-4 text-cannon-fire" />
          <h3 className="text-text-primary font-medium">Usage</h3>
        </div>
        <div className="p-4">
          <p className="text-text-secondary text-sm mb-3">
            Send logs using the <code className="text-cannon-fire bg-cannon-steel px-1.5 py-0.5 rounded">X-Seq-ApiKey</code> header:
          </p>
          <div className="bg-cannon-black rounded-lg p-4 overflow-x-auto">
            <pre className="text-sm text-text-code font-mono whitespace-pre-wrap break-all">
{`curl -X POST http://localhost:8080/ingest/clef \\
  -H "X-Seq-ApiKey: YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"@t":"2024-01-01T00:00:00Z","@mt":"Hello {Name}","Name":"World"}'`}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
