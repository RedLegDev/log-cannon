'use client';

import { useState, useEffect } from 'react';

interface Endpoint {
  id: string;
  name: string;
  description: string;
  sql_query: string;
  cache_ttl_seconds: number;
  enabled: number;
  created_at: string;
}

export default function EndpointsPage() {
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [testResult, setTestResult] = useState<{ name: string; data: unknown } | null>(null);

  // Form state
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formSql, setFormSql] = useState('');
  const [formCacheTtl, setFormCacheTtl] = useState(0);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    fetchEndpoints();
  }, []);

  async function fetchEndpoints() {
    try {
      const res = await fetch('/api/endpoints');
      if (!res.ok) throw new Error('Failed to fetch endpoints');
      const data = await res.json();
      setEndpoints(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch endpoints');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    try {
      const res = await fetch('/api/endpoints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formName,
          description: formDescription,
          sql_query: formSql,
          cache_ttl_seconds: formCacheTtl
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create endpoint');

      setShowCreate(false);
      setFormName('');
      setFormDescription('');
      setFormSql('');
      setFormCacheTtl(0);
      fetchEndpoints();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Failed to create endpoint');
    }
  }

  async function handleToggle(endpoint: Endpoint) {
    try {
      const res = await fetch('/api/endpoints', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: endpoint.id, enabled: !endpoint.enabled })
      });
      if (!res.ok) throw new Error('Failed to toggle endpoint');
      fetchEndpoints();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to toggle endpoint');
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this endpoint?')) return;

    try {
      const res = await fetch('/api/endpoints', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      if (!res.ok) throw new Error('Failed to delete endpoint');
      setEndpoints(endpoints.filter(e => e.id !== id));
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to delete endpoint');
    }
  }

  async function handleTest(endpoint: Endpoint) {
    try {
      const res = await fetch(`/api/endpoints/${endpoint.name}`);
      const data = await res.json();
      setTestResult({ name: endpoint.name, data });
    } catch (e) {
      setTestResult({ name: endpoint.name, data: { error: e instanceof Error ? e.message : 'Test failed' } });
    }
  }

  function copyUrl(name: string) {
    const url = `${window.location.origin}/api/endpoints/${name}`;
    navigator.clipboard.writeText(url);
  }

  if (loading) {
    return (
      <div>
        <h1 className="text-2xl font-bold text-white mb-6">Query Endpoints</h1>
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-white">Query Endpoints</h1>
        <button
          onClick={() => setShowCreate(true)}
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded"
        >
          Create Endpoint
        </button>
      </div>

      {error && (
        <div className="bg-red-900 border border-red-700 text-red-200 px-4 py-3 rounded mb-4">
          {error}
        </div>
      )}

      {showCreate && (
        <div className="bg-gray-800 rounded-lg p-6 mb-6">
          <h2 className="text-lg font-semibold text-white mb-4">Create Endpoint</h2>
          <form onSubmit={handleCreate} className="space-y-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Name (URL-safe)</label>
              <input
                type="text"
                value={formName}
                onChange={e => setFormName(e.target.value)}
                placeholder="error-counts"
                className="w-full bg-gray-700 border border-gray-600 text-white rounded px-3 py-2"
                required
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Description</label>
              <input
                type="text"
                value={formDescription}
                onChange={e => setFormDescription(e.target.value)}
                placeholder="Count errors by source"
                className="w-full bg-gray-700 border border-gray-600 text-white rounded px-3 py-2"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">SQL Query</label>
              <textarea
                value={formSql}
                onChange={e => setFormSql(e.target.value)}
                placeholder="SELECT count(*) as count FROM logs.events WHERE source = @source"
                className="w-full bg-gray-700 border border-gray-600 text-white rounded px-3 py-2 font-mono text-sm h-32"
                required
              />
              <p className="text-gray-500 text-xs mt-1">
                Use @param syntax for parameters. Only SELECT statements allowed.
              </p>
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Cache TTL (seconds, 0 = no cache)</label>
              <input
                type="number"
                value={formCacheTtl}
                onChange={e => setFormCacheTtl(parseInt(e.target.value) || 0)}
                min="0"
                className="w-full bg-gray-700 border border-gray-600 text-white rounded px-3 py-2"
              />
            </div>
            {formError && (
              <div className="text-red-400 text-sm">{formError}</div>
            )}
            <div className="flex gap-2">
              <button
                type="submit"
                className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded"
              >
                Create
              </button>
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="bg-gray-600 hover:bg-gray-700 text-white px-4 py-2 rounded"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {testResult && (
        <div className="bg-gray-800 rounded-lg p-6 mb-6">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-semibold text-white">Test Result: {testResult.name}</h2>
            <button
              onClick={() => setTestResult(null)}
              className="text-gray-400 hover:text-white"
            >
              Close
            </button>
          </div>
          <pre className="bg-gray-900 p-4 rounded overflow-auto max-h-64 text-sm text-gray-300">
            {JSON.stringify(testResult.data, null, 2)}
          </pre>
        </div>
      )}

      {endpoints.length === 0 ? (
        <div className="text-gray-400 text-center py-8">
          No endpoints yet. Create one to expose your logs as a REST API.
        </div>
      ) : (
        <div className="bg-gray-800 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-700">
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-300">Name</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-300">SQL</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-300">Cache</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-300">Status</th>
                <th className="px-4 py-3 text-right text-sm font-medium text-gray-300">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-700">
              {endpoints.map(endpoint => (
                <tr key={endpoint.id} className="hover:bg-gray-750">
                  <td className="px-4 py-3">
                    <div className="text-white font-medium font-mono">{endpoint.name}</div>
                    {endpoint.description && (
                      <div className="text-gray-400 text-sm">{endpoint.description}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <code className="text-gray-300 text-xs bg-gray-900 px-2 py-1 rounded block max-w-xs truncate">
                      {endpoint.sql_query}
                    </code>
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-sm">
                    {endpoint.cache_ttl_seconds > 0 ? `${endpoint.cache_ttl_seconds}s` : 'None'}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => handleToggle(endpoint)}
                      className={`px-2 py-1 rounded text-xs ${
                        endpoint.enabled
                          ? 'bg-green-900 text-green-200'
                          : 'bg-gray-600 text-gray-300'
                      }`}
                    >
                      {endpoint.enabled ? 'Enabled' : 'Disabled'}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-right space-x-2">
                    <button
                      onClick={() => handleTest(endpoint)}
                      className="text-blue-400 hover:text-blue-300"
                    >
                      Test
                    </button>
                    <button
                      onClick={() => copyUrl(endpoint.name)}
                      className="text-gray-400 hover:text-gray-300"
                    >
                      Copy URL
                    </button>
                    <button
                      onClick={() => handleDelete(endpoint.id)}
                      className="text-red-400 hover:text-red-300"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
