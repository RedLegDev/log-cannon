'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Trash2 } from 'lucide-react';

export function DeleteLogsButton() {
  const searchParams = useSearchParams();
  const [showModal, setShowModal] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [counting, setCounting] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const source = searchParams.get('source') || '';
  const level = searchParams.get('level') || '';
  const search = searchParams.get('search') || '';

  const hasFilters = source || level || search ||
    Array.from(searchParams.keys()).some(k => k.startsWith('prop.'));

  if (!hasFilters) return null;

  async function handleOpenModal() {
    setShowModal(true);
    setCounting(true);
    setError(null);
    setCount(null);

    try {
      // Build query params for count
      const params = new URLSearchParams();
      if (source) params.set('source', source);
      if (level) params.set('level', level);
      if (search) params.set('search', search);
      searchParams.forEach((value, key) => {
        if (key.startsWith('prop.')) params.set(key, value);
      });

      const res = await fetch(`/api/logs/count?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to count logs');
      setCount(data.count);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to count logs');
    } finally {
      setCounting(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    setError(null);

    try {
      // Build query params
      const params = new URLSearchParams();
      if (source) params.set('source', source);
      if (level) params.set('level', level);
      if (search) params.set('search', search);
      searchParams.forEach((value, key) => {
        if (key.startsWith('prop.')) params.set(key, value);
      });

      const res = await fetch(`/api/logs/delete?${params.toString()}`, {
        method: 'DELETE',
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete logs');

      setShowModal(false);
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete logs');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={handleOpenModal}
        className="text-gray-500 hover:text-red-400 p-2 rounded transition-colors"
        title="Delete matching logs"
      >
        <Trash2 className="w-4 h-4" />
      </button>

      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 w-full max-w-md mx-4 border border-gray-700">
            <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
              <Trash2 className="w-5 h-5 text-red-400" />
              Delete Logs
            </h2>

            <div className="space-y-4">
              <div className="text-sm text-gray-400">
                <strong className="text-gray-300">Matching filters:</strong>
                <ul className="mt-2 space-y-1">
                  {source && <li className="flex gap-2"><span className="text-gray-500">Source:</span> <span className="text-white">{source}</span></li>}
                  {level && <li className="flex gap-2"><span className="text-gray-500">Level:</span> <span className="text-white">{level}</span></li>}
                  {search && <li className="flex gap-2"><span className="text-gray-500">Search:</span> <span className="text-white">{search}</span></li>}
                  {Array.from(searchParams.entries())
                    .filter(([key]) => key.startsWith('prop.'))
                    .map(([key, value]) => (
                      <li key={key} className="flex gap-2">
                        <span className="text-gray-500">{key.slice(5)}:</span>
                        <span className="text-white">{value}</span>
                      </li>
                    ))
                  }
                </ul>
              </div>

              {counting ? (
                <div className="text-center py-4">
                  <div className="text-gray-400">Counting logs...</div>
                </div>
              ) : count !== null ? (
                <div className="bg-red-900/20 border border-red-600/30 rounded p-4 text-center">
                  <div className="text-3xl font-bold text-red-400">{count.toLocaleString()}</div>
                  <div className="text-sm text-gray-400 mt-1">logs will be permanently deleted</div>
                </div>
              ) : null}

              {error && (
                <div className="text-red-400 text-sm bg-red-900/20 border border-red-600/30 rounded p-3">{error}</div>
              )}

              <div className="flex gap-2 justify-end pt-2">
                <button
                  onClick={() => setShowModal(false)}
                  className="bg-gray-600 hover:bg-gray-700 text-white px-4 py-2 rounded transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDelete}
                  disabled={deleting || counting || count === 0}
                  className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded disabled:opacity-50 transition-colors flex items-center gap-2"
                >
                  <Trash2 className="w-4 h-4" />
                  {deleting ? 'Deleting...' : 'Delete Logs'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
