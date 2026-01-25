'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { parseOperatorFromValue, PropertyOperator } from '@/lib/clickhouse';

export function SaveQueryButton() {
  const searchParams = useSearchParams();
  const [showModal, setShowModal] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasFilters = searchParams.get('source') || searchParams.get('level') || searchParams.get('search') ||
    Array.from(searchParams.keys()).some(k => k.startsWith('prop.'));

  if (!hasFilters) return null;

  async function handleSave() {
    setSaving(true);
    setError(null);

    const source = searchParams.get('source') || '';
    const level = searchParams.get('level') || '';
    const search = searchParams.get('search') || '';

    // Extract property filters
    const propertyFilters: { key: string; value: string; operator: PropertyOperator }[] = [];
    searchParams.forEach((value, key) => {
      if (key.startsWith('prop.')) {
        const propKey = key.slice(5);
        const { operator, value: parsedValue } = parseOperatorFromValue(value);
        propertyFilters.push({ key: propKey, value: parsedValue, operator });
      }
    });

    try {
      const res = await fetch('/api/queries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          description,
          source,
          level,
          search,
          propertyFilters
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save query');

      setShowModal(false);
      setName('');
      setDescription('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save query');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setShowModal(true)}
        className="bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded"
      >
        Save Query
      </button>

      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 w-full max-w-md mx-4">
            <h2 className="text-lg font-semibold text-white mb-4">Save Query</h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="My saved query"
                  className="w-full bg-gray-700 border border-gray-600 text-white rounded px-3 py-2"
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-sm text-gray-400 mb-1">Description (optional)</label>
                <input
                  type="text"
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder="What this query is for"
                  className="w-full bg-gray-700 border border-gray-600 text-white rounded px-3 py-2"
                />
              </div>

              <div className="text-sm text-gray-400">
                <strong>Current filters:</strong>
                <ul className="mt-1 space-y-1">
                  {searchParams.get('source') && <li>Source: {searchParams.get('source')}</li>}
                  {searchParams.get('level') && <li>Level: {searchParams.get('level')}</li>}
                  {searchParams.get('search') && <li>Search: {searchParams.get('search')}</li>}
                </ul>
              </div>

              {error && (
                <div className="text-red-400 text-sm">{error}</div>
              )}

              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setShowModal(false)}
                  className="bg-gray-600 hover:bg-gray-700 text-white px-4 py-2 rounded"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={!name || saving}
                  className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
