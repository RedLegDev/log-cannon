'use client';

import { useState, useEffect } from 'react';
import { Plus, X, Trash2, ToggleLeft, ToggleRight, AlertCircle, Loader2, Pencil, Mail, Webhook, ChevronDown, ChevronUp, Send } from 'lucide-react';

interface Destination {
  id: string;
  name: string;
  type: string;
  config: string;
  enabled: number;
  created_at: string;
}

interface ParsedEmailConfig {
  email: string;
  from?: string;
}

interface ParsedWebhookConfig {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  timeout_seconds?: number;
}

export default function DestinationsPage() {
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingDest, setEditingDest] = useState<Destination | null>(null);

  // Form state
  const [formName, setFormName] = useState('');
  const [formType, setFormType] = useState<'email' | 'webhook'>('email');
  const [formEmail, setFormEmail] = useState('');
  const [formFrom, setFormFrom] = useState('');
  const [formUrl, setFormUrl] = useState('');
  const [formMethod, setFormMethod] = useState('POST');
  const [formHeaders, setFormHeaders] = useState<{ key: string; value: string }[]>([]);
  const [formTimeout, setFormTimeout] = useState(10);
  const [saving, setSaving] = useState(false);

  const fetchDestinations = async () => {
    try {
      const res = await fetch('/api/alert-destinations');
      if (!res.ok) throw new Error('Failed to fetch destinations');
      const data = await res.json();
      setDestinations(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch destinations');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDestinations();
  }, []);

  const resetForm = () => {
    setFormName('');
    setFormType('email');
    setFormEmail('');
    setFormFrom('');
    setFormUrl('');
    setFormMethod('POST');
    setFormHeaders([]);
    setFormTimeout(10);
    setEditingDest(null);
    setShowCreateForm(false);
  };

  const buildConfig = () => {
    if (formType === 'email') {
      const config: ParsedEmailConfig = { email: formEmail.trim() };
      if (formFrom.trim()) config.from = formFrom.trim();
      return config;
    } else {
      const config: ParsedWebhookConfig = { url: formUrl.trim() };
      if (formMethod !== 'POST') config.method = formMethod;
      const headers: Record<string, string> = {};
      for (const h of formHeaders) {
        if (h.key.trim() && h.value.trim()) {
          headers[h.key.trim()] = h.value.trim();
        }
      }
      if (Object.keys(headers).length > 0) config.headers = headers;
      if (formTimeout !== 10) config.timeout_seconds = formTimeout;
      return config;
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName.trim()) {
      setError('Name is required');
      return;
    }
    if (formType === 'email' && !formEmail.trim()) {
      setError('Email address is required');
      return;
    }
    if (formType === 'webhook' && !formUrl.trim()) {
      setError('Webhook URL is required');
      return;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/alert-destinations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formName.trim(),
          type: formType,
          config: buildConfig(),
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create destination');
      }
      resetForm();
      await fetchDestinations();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create destination');
    } finally {
      setSaving(false);
    }
  };

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingDest) return;

    setSaving(true);
    try {
      const res = await fetch('/api/alert-destinations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editingDest.id,
          name: formName.trim(),
          type: formType,
          config: buildConfig(),
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to update destination');
      }
      resetForm();
      await fetchDestinations();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update destination');
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (id: string, currentEnabled: number) => {
    try {
      const res = await fetch('/api/alert-destinations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, enabled: currentEnabled === 0 }),
      });
      if (!res.ok) throw new Error('Failed to toggle destination');
      await fetchDestinations();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to toggle destination');
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete destination "${name}"? This cannot be undone.`)) return;

    try {
      const res = await fetch('/api/alert-destinations', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) throw new Error('Failed to delete destination');
      await fetchDestinations();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete destination');
    }
  };

  const startEditing = (dest: Destination) => {
    setEditingDest(dest);
    setFormName(dest.name);
    setFormType(dest.type as 'email' | 'webhook');
    try {
      const config = JSON.parse(dest.config);
      if (dest.type === 'email') {
        setFormEmail(config.email || '');
        setFormFrom(config.from || '');
      } else {
        setFormUrl(config.url || '');
        setFormMethod(config.method || 'POST');
        setFormTimeout(config.timeout_seconds || 10);
        const headers = config.headers || {};
        setFormHeaders(Object.entries(headers).map(([key, value]) => ({ key, value: value as string })));
      }
    } catch {
      // ignore parse errors
    }
    setShowCreateForm(true);
  };

  const parseConfig = (config: string): Record<string, unknown> => {
    try {
      return JSON.parse(config);
    } catch {
      return {};
    }
  };

  const maskValue = (value: string): string => {
    if (value.length <= 4) return '****';
    return value.slice(0, 4) + '****';
  };

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary font-mono">
            <span className="text-cannon-fire">Destinations</span>
          </h1>
          <p className="text-text-secondary text-sm mt-1">
            Configure where alerts are delivered — email addresses and webhook endpoints
          </p>
        </div>
        {!showCreateForm && (
          <button
            onClick={() => setShowCreateForm(true)}
            className="btn-cannon flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            Add Destination
          </button>
        )}
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

      {/* Create/Edit Form */}
      {showCreateForm && (
        <div className="card-cannon p-4 mb-6 animate-slide-down">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-medium text-text-primary">
              {editingDest ? 'Edit Destination' : 'Add Destination'}
            </h2>
            <button onClick={resetForm} className="text-text-muted hover:text-white">
              <X className="w-5 h-5" />
            </button>
          </div>
          <form onSubmit={editingDest ? handleUpdate : handleCreate} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-text-secondary text-sm mb-1">Name *</label>
                <input
                  type="text"
                  placeholder="e.g., Ops Team Email"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  className="input-cannon w-full"
                  required
                />
              </div>
              <div>
                <label className="block text-text-secondary text-sm mb-1">Type *</label>
                <select
                  value={formType}
                  onChange={(e) => setFormType(e.target.value as 'email' | 'webhook')}
                  className="input-cannon w-full"
                >
                  <option value="email">Email</option>
                  <option value="webhook">Webhook</option>
                </select>
              </div>
            </div>

            {formType === 'email' ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-text-secondary text-sm mb-1">Email Address *</label>
                  <input
                    type="email"
                    placeholder="alerts@example.com"
                    value={formEmail}
                    onChange={(e) => setFormEmail(e.target.value)}
                    className="input-cannon w-full"
                    required
                  />
                </div>
                <div>
                  <label className="block text-text-secondary text-sm mb-1">From Address (optional)</label>
                  <input
                    type="email"
                    placeholder="Override sender address"
                    value={formFrom}
                    onChange={(e) => setFormFrom(e.target.value)}
                    className="input-cannon w-full"
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="md:col-span-2">
                    <label className="block text-text-secondary text-sm mb-1">URL *</label>
                    <input
                      type="url"
                      placeholder="https://hooks.example.com/alert"
                      value={formUrl}
                      onChange={(e) => setFormUrl(e.target.value)}
                      className="input-cannon w-full font-mono text-sm"
                      required
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-text-secondary text-sm mb-1">Method</label>
                      <select
                        value={formMethod}
                        onChange={(e) => setFormMethod(e.target.value)}
                        className="input-cannon w-full"
                      >
                        <option value="POST">POST</option>
                        <option value="PUT">PUT</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-text-secondary text-sm mb-1">Timeout (s)</label>
                      <input
                        type="number"
                        min={1}
                        max={60}
                        value={formTimeout}
                        onChange={(e) => setFormTimeout(parseInt(e.target.value) || 10)}
                        className="input-cannon w-full"
                      />
                    </div>
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-text-secondary text-sm">Headers</label>
                    <button
                      type="button"
                      onClick={() => setFormHeaders([...formHeaders, { key: '', value: '' }])}
                      className="text-xs text-cannon-fire hover:text-cannon-ember"
                    >
                      + Add Header
                    </button>
                  </div>
                  {formHeaders.length === 0 ? (
                    <p className="text-text-muted text-xs">No custom headers. Click &quot;Add Header&quot; to include authentication or other headers.</p>
                  ) : (
                    <div className="space-y-2">
                      {formHeaders.map((header, i) => (
                        <div key={i} className="flex gap-2">
                          <input
                            type="text"
                            placeholder="Header name"
                            value={header.key}
                            onChange={(e) => {
                              const updated = [...formHeaders];
                              updated[i].key = e.target.value;
                              setFormHeaders(updated);
                            }}
                            className="input-cannon flex-1 text-sm"
                          />
                          <input
                            type="text"
                            placeholder="Header value"
                            value={header.value}
                            onChange={(e) => {
                              const updated = [...formHeaders];
                              updated[i].value = e.target.value;
                              setFormHeaders(updated);
                            }}
                            className="input-cannon flex-1 text-sm"
                          />
                          <button
                            type="button"
                            onClick={() => setFormHeaders(formHeaders.filter((_, idx) => idx !== i))}
                            className="p-2 text-cannon-critical hover:bg-cannon-critical/20 rounded-lg"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="flex justify-end gap-3">
              <button type="button" onClick={resetForm} className="btn-cannon-ghost">
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="btn-cannon flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Plus className="w-4 h-4" />
                )}
                {saving ? 'Saving...' : (editingDest ? 'Update Destination' : 'Add Destination')}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Destinations List */}
      {loading ? (
        <div className="card-cannon p-8 text-center">
          <Loader2 className="w-8 h-8 animate-spin text-cannon-fire mx-auto mb-3" />
          <p className="text-text-secondary">Loading destinations...</p>
        </div>
      ) : destinations.length === 0 ? (
        <div className="card-cannon p-8 text-center">
          <div className="w-16 h-16 rounded-full bg-cannon-steel flex items-center justify-center mx-auto mb-4">
            <Send className="w-8 h-8 text-text-muted" />
          </div>
          <h3 className="text-lg font-medium text-text-primary mb-2">No destinations configured</h3>
          <p className="text-text-secondary text-sm">
            Add a destination to start routing alert notifications.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {destinations.map((dest) => (
            <DestinationCard
              key={dest.id}
              destination={dest}
              onToggle={handleToggle}
              onEdit={startEditing}
              onDelete={handleDelete}
              parseConfig={parseConfig}
              maskValue={maskValue}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface DestinationCardProps {
  destination: Destination;
  onToggle: (id: string, enabled: number) => void;
  onEdit: (dest: Destination) => void;
  onDelete: (id: string, name: string) => void;
  parseConfig: (config: string) => Record<string, unknown>;
  maskValue: (value: string) => string;
}

function DestinationCard({ destination, onToggle, onEdit, onDelete, parseConfig, maskValue }: DestinationCardProps) {
  const [expanded, setExpanded] = useState(false);
  const config = parseConfig(destination.config);
  const headers = (config.headers && typeof config.headers === 'object' && !Array.isArray(config.headers))
    ? config.headers as Record<string, string>
    : null;

  return (
    <div className="card-cannon overflow-hidden">
      <div className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3">
              {destination.type === 'email' ? (
                <Mail className="w-4 h-4 text-cannon-tracer flex-shrink-0" />
              ) : (
                <Webhook className="w-4 h-4 text-cannon-fire flex-shrink-0" />
              )}
              <h3 className="text-text-primary font-medium font-mono truncate">{destination.name}</h3>
              <span
                className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${
                  destination.type === 'email'
                    ? 'bg-cannon-tracer/20 text-cannon-tracer'
                    : 'bg-cannon-fire/20 text-cannon-fire'
                }`}
              >
                {destination.type}
              </span>
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
                  destination.enabled
                    ? 'bg-cannon-tracer/20 text-cannon-tracer'
                    : 'bg-cannon-graphite text-text-muted'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${destination.enabled ? 'bg-cannon-tracer' : 'bg-text-muted'}`}></span>
                {destination.enabled ? 'Active' : 'Disabled'}
              </span>
            </div>
            <div className="flex items-center gap-4 mt-2 text-xs text-text-muted">
              {destination.type === 'email' ? (
                <span>{String(config.email || '')}</span>
              ) : (
                <span className="font-mono truncate max-w-md">{String(config.url || '')}</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onEdit(destination)}
              className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-cannon-graphite transition-colors"
              title="Edit"
            >
              <Pencil className="w-5 h-5" />
            </button>
            <button
              onClick={() => onToggle(destination.id, destination.enabled)}
              className={`p-2 rounded-lg transition-colors ${
                destination.enabled
                  ? 'text-cannon-warning hover:bg-cannon-warning/20'
                  : 'text-cannon-tracer hover:bg-cannon-tracer/20'
              }`}
              title={destination.enabled ? 'Disable' : 'Enable'}
            >
              {destination.enabled ? <ToggleRight className="w-5 h-5" /> : <ToggleLeft className="w-5 h-5" />}
            </button>
            <button
              onClick={() => onDelete(destination.id, destination.name)}
              className="p-2 rounded-lg text-cannon-critical hover:bg-cannon-critical/20 transition-colors"
              title="Delete"
            >
              <Trash2 className="w-5 h-5" />
            </button>
            <button
              onClick={() => setExpanded(!expanded)}
              className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-cannon-graphite transition-colors"
              title={expanded ? 'Collapse' : 'Expand'}
            >
              {expanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-cannon-graphite bg-cannon-steel/50 p-4 space-y-3">
          {destination.type === 'email' ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-text-muted text-xs uppercase mb-1">Email</label>
                <p className="text-text-primary text-sm">{String(config.email || '')}</p>
              </div>
              {config.from ? (
                <div>
                  <label className="block text-text-muted text-xs uppercase mb-1">From Override</label>
                  <p className="text-text-primary text-sm">{String(config.from)}</p>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="md:col-span-2">
                  <label className="block text-text-muted text-xs uppercase mb-1">URL</label>
                  <p className="text-text-primary text-sm font-mono break-all">{String(config.url || '')}</p>
                </div>
                <div className="flex gap-4">
                  <div>
                    <label className="block text-text-muted text-xs uppercase mb-1">Method</label>
                    <p className="text-text-primary text-sm">{String(config.method || 'POST')}</p>
                  </div>
                  <div>
                    <label className="block text-text-muted text-xs uppercase mb-1">Timeout</label>
                    <p className="text-text-primary text-sm">{Number(config.timeout_seconds) || 10}s</p>
                  </div>
                </div>
              </div>
              {headers && Object.keys(headers).length > 0 && (
                <div>
                  <label className="block text-text-muted text-xs uppercase mb-1">Headers</label>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(headers).map(([key, value]) => (
                      <span key={key} className="px-2 py-0.5 rounded text-xs font-mono bg-cannon-graphite text-text-secondary">
                        {key}: {maskValue(String(value))}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          <div className="text-xs text-text-muted">
            Created: {destination.created_at}
          </div>
        </div>
      )}
    </div>
  );
}
