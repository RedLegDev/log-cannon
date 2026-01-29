'use client';

import { useState, useEffect } from 'react';
import { Bell, Plus, X, Trash2, ToggleLeft, ToggleRight, AlertCircle, Loader2, Pencil, Play, ChevronDown, ChevronUp } from 'lucide-react';

interface Alert {
  id: string;
  name: string;
  description: string;
  query: string;
  condition: string;
  interval_seconds: number;
  cooldown_seconds: number;
  recipients: string;
  subject: string;
  enabled: number;
  created_at: string;
  last_triggered_at: string;
}

interface TestResult {
  success: boolean;
  results: Record<string, unknown>[];
  query: string;
  condition: string;
  error?: string;
}

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingAlert, setEditingAlert] = useState<Alert | null>(null);
  const [testingAlertId, setTestingAlertId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  // Form state
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formQuery, setFormQuery] = useState('');
  const [formCondition, setFormCondition] = useState('');
  const [formIntervalSeconds, setFormIntervalSeconds] = useState(60);
  const [formCooldownSeconds, setFormCooldownSeconds] = useState(300);
  const [formRecipients, setFormRecipients] = useState('');
  const [formSubject, setFormSubject] = useState('');
  const [saving, setSaving] = useState(false);

  const fetchAlerts = async () => {
    try {
      const res = await fetch('/api/alerts');
      if (!res.ok) throw new Error('Failed to fetch alerts');
      const data = await res.json();
      setAlerts(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch alerts');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAlerts();
  }, []);

  const resetForm = () => {
    setFormName('');
    setFormDescription('');
    setFormQuery('');
    setFormCondition('');
    setFormIntervalSeconds(60);
    setFormCooldownSeconds(300);
    setFormRecipients('');
    setFormSubject('');
    setEditingAlert(null);
    setShowCreateForm(false);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName.trim() || !formQuery.trim() || !formCondition.trim() || !formSubject.trim() || !formRecipients.trim()) {
      setError('Please fill in all required fields');
      return;
    }

    const recipients = formRecipients.split(',').map(r => r.trim()).filter(r => r);
    if (recipients.length === 0) {
      setError('At least one recipient email is required');
      return;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formName.trim(),
          description: formDescription.trim(),
          query: formQuery.trim(),
          condition: formCondition.trim(),
          interval_seconds: formIntervalSeconds,
          cooldown_seconds: formCooldownSeconds,
          recipients,
          subject: formSubject.trim()
        })
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create alert');
      }
      resetForm();
      await fetchAlerts();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create alert');
    } finally {
      setSaving(false);
    }
  };

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingAlert) return;

    const recipients = formRecipients.split(',').map(r => r.trim()).filter(r => r);
    if (recipients.length === 0) {
      setError('At least one recipient email is required');
      return;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/alerts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editingAlert.id,
          name: formName.trim(),
          description: formDescription.trim(),
          query: formQuery.trim(),
          condition: formCondition.trim(),
          interval_seconds: formIntervalSeconds,
          cooldown_seconds: formCooldownSeconds,
          recipients,
          subject: formSubject.trim()
        })
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to update alert');
      }
      resetForm();
      await fetchAlerts();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update alert');
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (alertId: string, currentEnabled: number) => {
    try {
      const res = await fetch('/api/alerts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: alertId, enabled: currentEnabled === 0 ? 1 : 0 })
      });
      if (!res.ok) throw new Error('Failed to toggle alert');
      await fetchAlerts();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to toggle alert');
    }
  };

  const handleDelete = async (alertId: string, name: string) => {
    if (!confirm(`Delete alert "${name}"? This cannot be undone.`)) return;

    try {
      const res = await fetch('/api/alerts', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: alertId })
      });
      if (!res.ok) throw new Error('Failed to delete alert');
      await fetchAlerts();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete alert');
    }
  };

  const handleTest = async (alertId: string) => {
    setTestingAlertId(alertId);
    setTestResult(null);
    try {
      const res = await fetch(`/api/alerts/${alertId}/test`, {
        method: 'POST'
      });
      const data = await res.json();
      if (!res.ok) {
        setTestResult({ success: false, results: [], query: '', condition: '', error: data.error });
      } else {
        setTestResult(data);
      }
    } catch (e) {
      setTestResult({ success: false, results: [], query: '', condition: '', error: e instanceof Error ? e.message : 'Test failed' });
    } finally {
      setTestingAlertId(null);
    }
  };

  const startEditing = (alert: Alert) => {
    setEditingAlert(alert);
    setFormName(alert.name);
    setFormDescription(alert.description);
    setFormQuery(alert.query);
    setFormCondition(alert.condition);
    setFormIntervalSeconds(alert.interval_seconds);
    setFormCooldownSeconds(alert.cooldown_seconds);
    try {
      const recipients = JSON.parse(alert.recipients);
      setFormRecipients(Array.isArray(recipients) ? recipients.join(', ') : '');
    } catch {
      setFormRecipients('');
    }
    setFormSubject(alert.subject);
    setShowCreateForm(true);
  };

  const parseRecipients = (recipientsJson: string): string[] => {
    try {
      const parsed = JSON.parse(recipientsJson);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  const formatLastTriggered = (timestamp: string): string => {
    if (!timestamp || timestamp === '1970-01-01 00:00:00') {
      return 'Never';
    }
    return timestamp;
  };

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary font-mono">
            <span className="text-cannon-fire">Alerts</span>
          </h1>
          <p className="text-text-secondary text-sm mt-1">
            Configure threshold-based alerts with email notifications
          </p>
        </div>
        {!showCreateForm && (
          <button
            onClick={() => setShowCreateForm(true)}
            className="btn-cannon flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            Create Alert
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

      {/* Test Result Banner */}
      {testResult && (
        <div className={`card-cannon p-4 mb-6 animate-slide-down ${testResult.success ? 'border-cannon-tracer/50 bg-cannon-tracer/10' : 'border-cannon-critical/50 bg-cannon-critical/10'}`}>
          <div className="flex items-start gap-3">
            <div className="flex-1">
              <div className={`font-medium mb-2 ${testResult.success ? 'text-cannon-tracer' : 'text-cannon-critical'}`}>
                {testResult.success ? 'Query Test Results' : 'Query Test Failed'}
              </div>
              {testResult.error ? (
                <p className="text-cannon-critical text-sm">{testResult.error}</p>
              ) : (
                <div className="space-y-2">
                  <div className="bg-cannon-black rounded-lg p-3 overflow-x-auto">
                    <pre className="text-xs text-text-code font-mono">
                      {JSON.stringify(testResult.results, null, 2)}
                    </pre>
                  </div>
                  <p className="text-text-secondary text-xs">
                    Condition: <code className="text-cannon-fire bg-cannon-steel px-1.5 py-0.5 rounded">{testResult.condition}</code>
                  </p>
                </div>
              )}
            </div>
            <button onClick={() => setTestResult(null)} className={testResult.success ? 'text-cannon-tracer hover:text-white' : 'text-cannon-critical hover:text-white'}>
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
              {editingAlert ? 'Edit Alert' : 'Create Alert'}
            </h2>
            <button onClick={resetForm} className="text-text-muted hover:text-white">
              <X className="w-5 h-5" />
            </button>
          </div>
          <form onSubmit={editingAlert ? handleUpdate : handleCreate} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-text-secondary text-sm mb-1">Name *</label>
                <input
                  type="text"
                  placeholder="e.g., high-error-rate"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  className="input-cannon w-full"
                  required
                />
              </div>
              <div>
                <label className="block text-text-secondary text-sm mb-1">Subject *</label>
                <input
                  type="text"
                  placeholder="Email subject line"
                  value={formSubject}
                  onChange={(e) => setFormSubject(e.target.value)}
                  className="input-cannon w-full"
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-text-secondary text-sm mb-1">Description</label>
              <input
                type="text"
                placeholder="What this alert monitors"
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                className="input-cannon w-full"
              />
            </div>

            <div>
              <label className="block text-text-secondary text-sm mb-1">Query * (SELECT statement)</label>
              <textarea
                placeholder="SELECT count() as cnt FROM logs.events WHERE level IN ('Error', 'Fatal') AND timestamp > now() - INTERVAL 5 MINUTE"
                value={formQuery}
                onChange={(e) => setFormQuery(e.target.value)}
                className="input-cannon w-full h-24 font-mono text-sm"
                required
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-text-secondary text-sm mb-1">Condition *</label>
                <input
                  type="text"
                  placeholder="e.g., cnt > 50"
                  value={formCondition}
                  onChange={(e) => setFormCondition(e.target.value)}
                  className="input-cannon w-full font-mono"
                  required
                />
              </div>
              <div>
                <label className="block text-text-secondary text-sm mb-1">Check Interval (seconds)</label>
                <input
                  type="number"
                  min={30}
                  value={formIntervalSeconds}
                  onChange={(e) => setFormIntervalSeconds(parseInt(e.target.value) || 60)}
                  className="input-cannon w-full"
                />
              </div>
              <div>
                <label className="block text-text-secondary text-sm mb-1">Cooldown (seconds)</label>
                <input
                  type="number"
                  min={0}
                  value={formCooldownSeconds}
                  onChange={(e) => setFormCooldownSeconds(parseInt(e.target.value) || 300)}
                  className="input-cannon w-full"
                />
              </div>
            </div>

            <div>
              <label className="block text-text-secondary text-sm mb-1">Recipients * (comma-separated emails)</label>
              <input
                type="text"
                placeholder="alerts@example.com, oncall@example.com"
                value={formRecipients}
                onChange={(e) => setFormRecipients(e.target.value)}
                className="input-cannon w-full"
                required
              />
            </div>

            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={resetForm}
                className="btn-cannon-ghost"
              >
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
                {saving ? 'Saving...' : (editingAlert ? 'Update Alert' : 'Create Alert')}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Alerts Table */}
      {loading ? (
        <div className="card-cannon p-8 text-center">
          <Loader2 className="w-8 h-8 animate-spin text-cannon-fire mx-auto mb-3" />
          <p className="text-text-secondary">Loading alerts...</p>
        </div>
      ) : alerts.length === 0 ? (
        <div className="card-cannon p-8 text-center">
          <div className="w-16 h-16 rounded-full bg-cannon-steel flex items-center justify-center mx-auto mb-4">
            <Bell className="w-8 h-8 text-text-muted" />
          </div>
          <h3 className="text-lg font-medium text-text-primary mb-2">No alerts configured</h3>
          <p className="text-text-secondary text-sm">
            Create an alert to start monitoring your logs.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {alerts.map((alert) => (
            <AlertCard
              key={alert.id}
              alert={alert}
              onToggle={handleToggle}
              onEdit={startEditing}
              onDelete={handleDelete}
              onTest={handleTest}
              testingAlertId={testingAlertId}
              parseRecipients={parseRecipients}
              formatLastTriggered={formatLastTriggered}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface AlertCardProps {
  alert: Alert;
  onToggle: (id: string, enabled: number) => void;
  onEdit: (alert: Alert) => void;
  onDelete: (id: string, name: string) => void;
  onTest: (id: string) => void;
  testingAlertId: string | null;
  parseRecipients: (json: string) => string[];
  formatLastTriggered: (timestamp: string) => string;
}

function AlertCard({ alert, onToggle, onEdit, onDelete, onTest, testingAlertId, parseRecipients, formatLastTriggered }: AlertCardProps) {
  const [expanded, setExpanded] = useState(false);
  const recipients = parseRecipients(alert.recipients);

  return (
    <div className="card-cannon overflow-hidden">
      <div className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3">
              <h3 className="text-text-primary font-medium font-mono truncate">{alert.name}</h3>
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
                  alert.enabled
                    ? 'bg-cannon-tracer/20 text-cannon-tracer'
                    : 'bg-cannon-graphite text-text-muted'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${alert.enabled ? 'bg-cannon-tracer' : 'bg-text-muted'}`}></span>
                {alert.enabled ? 'Active' : 'Disabled'}
              </span>
            </div>
            {alert.description && (
              <p className="text-text-secondary text-sm mt-1 truncate">{alert.description}</p>
            )}
            <div className="flex flex-wrap items-center gap-4 mt-2 text-xs text-text-muted">
              <span>Condition: <code className="text-cannon-fire bg-cannon-steel px-1.5 py-0.5 rounded">{alert.condition}</code></span>
              <span>Every {alert.interval_seconds}s</span>
              <span>Cooldown {alert.cooldown_seconds}s</span>
              <span>Last triggered: {formatLastTriggered(alert.last_triggered_at)}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onTest(alert.id)}
              disabled={testingAlertId === alert.id}
              className="p-2 rounded-lg text-text-muted hover:text-cannon-tracer hover:bg-cannon-tracer/20 transition-colors disabled:opacity-50"
              title="Test query"
            >
              {testingAlertId === alert.id ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <Play className="w-5 h-5" />
              )}
            </button>
            <button
              onClick={() => onEdit(alert)}
              className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-cannon-graphite transition-colors"
              title="Edit"
            >
              <Pencil className="w-5 h-5" />
            </button>
            <button
              onClick={() => onToggle(alert.id, alert.enabled)}
              className={`p-2 rounded-lg transition-colors ${
                alert.enabled
                  ? 'text-cannon-warning hover:bg-cannon-warning/20'
                  : 'text-cannon-tracer hover:bg-cannon-tracer/20'
              }`}
              title={alert.enabled ? 'Disable' : 'Enable'}
            >
              {alert.enabled ? <ToggleRight className="w-5 h-5" /> : <ToggleLeft className="w-5 h-5" />}
            </button>
            <button
              onClick={() => onDelete(alert.id, alert.name)}
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
          <div>
            <label className="block text-text-muted text-xs uppercase mb-1">Query</label>
            <pre className="text-xs text-text-code font-mono bg-cannon-black rounded-lg p-3 overflow-x-auto whitespace-pre-wrap">
              {alert.query}
            </pre>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-text-muted text-xs uppercase mb-1">Subject</label>
              <p className="text-text-primary text-sm">{alert.subject}</p>
            </div>
            <div>
              <label className="block text-text-muted text-xs uppercase mb-1">Recipients</label>
              <div className="flex flex-wrap gap-1">
                {recipients.map((email, i) => (
                  <span key={i} className="px-2 py-0.5 rounded text-xs font-medium bg-cannon-graphite text-text-secondary">
                    {email}
                  </span>
                ))}
              </div>
            </div>
          </div>
          <div className="text-xs text-text-muted">
            Created: {alert.created_at}
          </div>
        </div>
      )}
    </div>
  );
}
