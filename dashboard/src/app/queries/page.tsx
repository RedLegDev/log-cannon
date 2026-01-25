'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

interface SavedQuery {
  id: string;
  name: string;
  description: string;
  source: string;
  level: string;
  search: string;
  property_filters: string;
  created_at: string;
}

export default function QueriesPage() {
  const [queries, setQueries] = useState<SavedQuery[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchQueries();
  }, []);

  async function fetchQueries() {
    try {
      const res = await fetch('/api/queries');
      if (!res.ok) throw new Error('Failed to fetch queries');
      const data = await res.json();
      setQueries(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch queries');
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this saved query?')) return;

    try {
      const res = await fetch('/api/queries', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      if (!res.ok) throw new Error('Failed to delete query');
      setQueries(queries.filter(q => q.id !== id));
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to delete query');
    }
  }

  function buildQueryUrl(query: SavedQuery): string {
    const params = new URLSearchParams();
    if (query.source) params.set('source', query.source);
    if (query.level) params.set('level', query.level);
    if (query.search) params.set('search', query.search);

    // Parse property filters
    try {
      const filters = JSON.parse(query.property_filters);
      for (const filter of filters) {
        const key = filter.exclude ? `prop.${filter.key}!` : `prop.${filter.key}`;
        params.set(key, filter.value);
      }
    } catch {
      // Ignore parse errors
    }

    const queryString = params.toString();
    return queryString ? `/?${queryString}` : '/';
  }

  if (loading) {
    return (
      <div>
        <h1 className="text-2xl font-bold text-white mb-6">Saved Queries</h1>
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-6">Saved Queries</h1>

      {error && (
        <div className="bg-red-900 border border-red-700 text-red-200 px-4 py-3 rounded mb-4">
          {error}
        </div>
      )}

      {queries.length === 0 ? (
        <div className="text-gray-400 text-center py-8">
          No saved queries yet. Use the &quot;Save Query&quot; button in the Log Explorer to save a query.
        </div>
      ) : (
        <div className="bg-gray-800 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-700">
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-300">Name</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-300">Filters</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-300">Created</th>
                <th className="px-4 py-3 text-right text-sm font-medium text-gray-300">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-700">
              {queries.map(query => (
                <tr key={query.id} className="hover:bg-gray-750">
                  <td className="px-4 py-3">
                    <div className="text-white font-medium">{query.name}</div>
                    {query.description && (
                      <div className="text-gray-400 text-sm">{query.description}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-300 text-sm">
                    <div className="flex flex-wrap gap-1">
                      {query.source && (
                        <span className="bg-blue-900 text-blue-200 px-2 py-0.5 rounded text-xs">
                          source: {query.source}
                        </span>
                      )}
                      {query.level && (
                        <span className="bg-purple-900 text-purple-200 px-2 py-0.5 rounded text-xs">
                          level: {query.level}
                        </span>
                      )}
                      {query.search && (
                        <span className="bg-green-900 text-green-200 px-2 py-0.5 rounded text-xs">
                          search: {query.search}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-sm">{query.created_at}</td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={buildQueryUrl(query)}
                      className="text-blue-400 hover:text-blue-300 mr-3"
                    >
                      Load
                    </Link>
                    <button
                      onClick={() => handleDelete(query.id)}
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
