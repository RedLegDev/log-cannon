'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Eye, Trash2, ToggleLeft, ToggleRight, Plus } from 'lucide-react';

interface Dashboard {
  id: string;
  name: string;
  description: string;
  config: string;
  enabled: number;
  created_at: string;
}

export default function DashboardsPage() {
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  // Form state
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formConfig, setFormConfig] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    fetchDashboards();
  }, []);

  async function fetchDashboards() {
    try {
      const res = await fetch('/api/dashboards');
      if (!res.ok) throw new Error('Failed to fetch dashboards');
      const data = await res.json();
      setDashboards(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch dashboards');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    try {
      // Parse config JSON
      const config = JSON.parse(formConfig);

      const res = await fetch('/api/dashboards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formName,
          description: formDescription,
          config
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create dashboard');

      setShowCreate(false);
      setFormName('');
      setFormDescription('');
      setFormConfig('');
      fetchDashboards();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Failed to create dashboard');
    }
  }

  async function handleToggle(dashboard: Dashboard) {
    try {
      const res = await fetch('/api/dashboards', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: dashboard.id, enabled: !dashboard.enabled })
      });
      if (!res.ok) throw new Error('Failed to toggle dashboard');
      fetchDashboards();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to toggle dashboard');
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this dashboard?')) return;

    try {
      const res = await fetch('/api/dashboards', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      if (!res.ok) throw new Error('Failed to delete dashboard');
      setDashboards(dashboards.filter(d => d.id !== id));
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to delete dashboard');
    }
  }

  function loadExample() {
    setFormConfig(JSON.stringify({
      "layout": "auto",
      "widgets": [
        {
          "id": "example-stat",
          "type": "stat",
          "title": "Total Logs (24h)",
          "dataSource": {
            "type": "inline",
            "sql": "SELECT count(*) as count FROM logs.events WHERE timestamp > now() - INTERVAL 24 HOUR",
            "refreshInterval": 30
          },
          "visualization": {
            "valueField": "count",
            "format": "number"
          }
        }
      ]
    }, null, 2));
  }

  if (loading) {
    return (
      <div className="animate-fade-in">
        <h1 className="text-2xl font-bold text-text-primary font-mono mb-6">
          <span className="text-cannon-fire">Dashboards</span>
        </h1>
        <div className="text-text-muted">Loading...</div>
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold text-text-primary font-mono">
            <span className="text-cannon-fire">Dashboards</span>
          </h1>
          <p className="text-text-secondary text-sm mt-1">
            Create custom dashboards with widgets and visualizations
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="btn-cannon flex items-center gap-2"
        >
          <Plus className="w-4 h-4" />
          Create Dashboard
        </button>
      </div>

      {error && (
        <div className="card-cannon border-cannon-critical/50 bg-cannon-critical/10 p-4 mb-6">
          <p className="text-cannon-critical">{error}</p>
        </div>
      )}

      {showCreate && (
        <div className="card-cannon p-6 mb-6">
          <h2 className="text-lg font-semibold text-text-primary mb-4">Create Dashboard</h2>
          <form onSubmit={handleCreate} className="space-y-4">
            <div>
              <label className="block text-sm text-text-secondary mb-1">Name (URL-safe)</label>
              <input
                type="text"
                value={formName}
                onChange={e => setFormName(e.target.value)}
                placeholder="api-health"
                className="input-cannon w-full"
                required
              />
            </div>
            <div>
              <label className="block text-sm text-text-secondary mb-1">Description</label>
              <input
                type="text"
                value={formDescription}
                onChange={e => setFormDescription(e.target.value)}
                placeholder="API health monitoring dashboard"
                className="input-cannon w-full"
              />
            </div>
            <div>
              <div className="flex justify-between items-center mb-1">
                <label className="block text-sm text-text-secondary">Dashboard Config (JSON)</label>
                <button
                  type="button"
                  onClick={loadExample}
                  className="text-xs text-cannon-fire hover:text-cannon-warning transition-colors"
                >
                  Load Example
                </button>
              </div>
              <textarea
                value={formConfig}
                onChange={e => setFormConfig(e.target.value)}
                placeholder='{"layout": "auto", "widgets": [...]}'
                className="input-cannon w-full font-mono text-sm h-64"
                required
              />
              <p className="text-text-muted text-xs mt-1">
                Paste your dashboard JSON configuration. See docs for widget types and options.
              </p>
            </div>
            {formError && (
              <div className="text-cannon-critical text-sm">{formError}</div>
            )}
            <div className="flex gap-2">
              <button type="submit" className="btn-cannon">
                Create
              </button>
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="btn-cannon bg-bg-tertiary hover:bg-bg-secondary"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {dashboards.length === 0 ? (
        <div className="card-cannon p-8 text-center">
          <p className="text-text-muted">
            No dashboards yet. Create one to visualize your log data.
          </p>
        </div>
      ) : (
        <div className="card-cannon overflow-hidden">
          <table className="w-full">
            <thead className="bg-bg-secondary border-b border-border-subtle">
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium text-text-secondary">Name</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-text-secondary">Description</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-text-secondary">Widgets</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-text-secondary">Status</th>
                <th className="px-4 py-3 text-right text-sm font-medium text-text-secondary">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {dashboards.map(dashboard => {
                let widgetCount = 0;
                try {
                  const config = JSON.parse(dashboard.config);
                  widgetCount = config.widgets?.length || 0;
                } catch {
                  // Invalid config
                }

                return (
                  <tr key={dashboard.id} className="hover:bg-bg-secondary transition-colors">
                    <td className="px-4 py-3">
                      <div className="text-text-primary font-medium font-mono">{dashboard.name}</div>
                      <div className="text-text-muted text-xs">{dashboard.created_at}</div>
                    </td>
                    <td className="px-4 py-3 text-text-secondary text-sm">
                      {dashboard.description || '-'}
                    </td>
                    <td className="px-4 py-3 text-text-muted text-sm">
                      {widgetCount} widget{widgetCount !== 1 ? 's' : ''}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => handleToggle(dashboard)}
                        className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${
                          dashboard.enabled
                            ? 'bg-cannon-success/20 text-cannon-success'
                            : 'bg-bg-tertiary text-text-muted'
                        }`}
                      >
                        {dashboard.enabled ? (
                          <><ToggleRight className="w-3 h-3" /> Enabled</>
                        ) : (
                          <><ToggleLeft className="w-3 h-3" /> Disabled</>
                        )}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-right space-x-3">
                      <Link
                        href={`/dashboards/${dashboard.name}`}
                        className="text-cannon-fire hover:text-cannon-warning transition-colors inline-flex items-center gap-1"
                      >
                        <Eye className="w-4 h-4" />
                        View
                      </Link>
                      <button
                        onClick={() => handleDelete(dashboard.id)}
                        className="text-cannon-critical hover:text-cannon-warning transition-colors inline-flex items-center gap-1"
                      >
                        <Trash2 className="w-4 h-4" />
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
