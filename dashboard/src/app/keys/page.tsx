'use client';

import { useState, useEffect } from 'react';

interface APIKey {
  key_id: string;
  api_key: string;
  name: string;
  created_at: string;
  enabled: number;
}

export default function APIKeysPage() {
  const [keys, setKeys] = useState<APIKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newKeyName, setNewKeyName] = useState('');
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

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
        body: JSON.stringify({ name: newKeyName.trim() })
      });
      if (!res.ok) throw new Error('Failed to create key');
      const data = await res.json();
      setCreatedKey(data.apiKey);
      setNewKeyName('');
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

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const maskKey = (key: string) => {
    return key.substring(0, 8) + '...' + key.substring(key.length - 4);
  };

  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-6">API Keys</h1>

      {error && (
        <div className="bg-red-900 border border-red-700 text-red-200 px-4 py-3 rounded mb-6">
          {error}
        </div>
      )}

      {createdKey && (
        <div className="bg-green-900 border border-green-700 text-green-200 px-4 py-3 rounded mb-6">
          <div className="font-medium mb-2">API Key Created!</div>
          <div className="flex items-center gap-2">
            <code className="bg-gray-800 px-3 py-1 rounded font-mono text-sm flex-1">
              {createdKey}
            </code>
            <button
              onClick={() => copyToClipboard(createdKey)}
              className="bg-green-700 hover:bg-green-600 px-3 py-1 rounded text-sm"
            >
              Copy
            </button>
            <button
              onClick={() => setCreatedKey(null)}
              className="text-green-400 hover:text-green-300 px-2"
            >
              ✕
            </button>
          </div>
          <div className="text-xs mt-2 text-green-400">
            Save this key now. You won&apos;t be able to see it again.
          </div>
        </div>
      )}

      <div className="bg-gray-800 rounded border border-gray-700 p-4 mb-6">
        <form onSubmit={handleCreate} className="flex gap-4">
          <input
            type="text"
            placeholder="Service name (e.g., order-service)"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            className="flex-1 bg-gray-700 border border-gray-600 rounded px-4 py-2 text-white placeholder-gray-400 focus:outline-none focus:border-blue-500"
          />
          <button
            type="submit"
            disabled={creating || !newKeyName.trim()}
            className="bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 disabled:cursor-not-allowed px-6 py-2 rounded text-white font-medium"
          >
            {creating ? 'Creating...' : 'Create Key'}
          </button>
        </form>
      </div>

      {loading ? (
        <div className="text-gray-400 text-center py-8">Loading...</div>
      ) : keys.length === 0 ? (
        <div className="text-gray-400 text-center py-8 bg-gray-800 rounded border border-gray-700">
          No API keys found. Create one above to get started.
        </div>
      ) : (
        <div className="bg-gray-800 rounded border border-gray-700 overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-750">
              <tr className="text-left text-gray-400 text-sm">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">API Key</th>
                <th className="px-4 py-3">Created</th>
                <th className="px-4 py-3 text-center">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.key_id} className="border-t border-gray-700 hover:bg-gray-750">
                  <td className="px-4 py-3 text-white font-medium">{key.name}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <code className="text-gray-400 font-mono text-sm">
                        {maskKey(key.api_key)}
                      </code>
                      <button
                        onClick={() => copyToClipboard(key.api_key)}
                        className="text-gray-500 hover:text-gray-300 text-xs"
                        title="Copy full key"
                      >
                        Copy
                      </button>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-sm">{key.created_at}</td>
                  <td className="px-4 py-3 text-center">
                    <span
                      className={`inline-block px-2 py-1 rounded text-xs font-medium ${
                        key.enabled ? 'bg-green-900 text-green-300' : 'bg-red-900 text-red-300'
                      }`}
                    >
                      {key.enabled ? 'Active' : 'Disabled'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => handleToggle(key.key_id, key.enabled)}
                        className={`px-3 py-1 rounded text-sm ${
                          key.enabled
                            ? 'bg-yellow-700 hover:bg-yellow-600 text-yellow-100'
                            : 'bg-green-700 hover:bg-green-600 text-green-100'
                        }`}
                      >
                        {key.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button
                        onClick={() => handleDelete(key.key_id, key.name)}
                        className="bg-red-700 hover:bg-red-600 px-3 py-1 rounded text-sm text-red-100"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-6 bg-gray-800 rounded border border-gray-700 p-4">
        <h3 className="text-white font-medium mb-2">Usage</h3>
        <p className="text-gray-400 text-sm mb-3">
          Send logs using the <code className="text-blue-400">X-Seq-ApiKey</code> header:
        </p>
        <pre className="bg-gray-900 rounded p-3 text-sm text-gray-300 overflow-x-auto">
{`curl -X POST http://localhost:8080/ingest/clef \\
  -H "X-Seq-ApiKey: YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"@t":"2024-01-01T00:00:00Z","@mt":"Hello {Name}","Name":"World"}'`}
        </pre>
      </div>
    </div>
  );
}
