'use client';

import { useState } from 'react';
import { Copy, Check, ChevronDown, ChevronRight, ExternalLink, Key } from 'lucide-react';
import Link from 'next/link';

const TOOLS = [
  { name: 'create_log', scope: 'ingest', description: 'Create a log entry — record agent activity, task progress, errors, or structured events' },
  { name: 'search_logs', scope: 'read', description: 'Search and filter log events by source, level, text, and property filters' },
  { name: 'execute_query', scope: 'read', description: 'Execute a read-only SQL SELECT query against the ClickHouse logs database' },
  { name: 'get_overview', scope: 'read', description: 'One-shot investigation starter: metrics, service breakdown, and top errors for the last 24h' },
  { name: 'get_firing_alerts', scope: 'read', description: 'Check if any alert rules are currently firing' },
  { name: 'get_docs', scope: 'read', description: 'Get log-cannon documentation — API reference, logger integration, dashboard schema, or system overview with live data' },
  { name: 'create_dashboard', scope: 'write', description: 'Create a new dashboard with configurable widgets' },
  { name: 'create_alert', scope: 'write', description: 'Create a threshold alert rule with destination-based notifications' },
];

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="absolute top-3 right-3 p-1.5 rounded-md text-gray-400 hover:text-white hover:bg-cannon-steel transition-colors"
      title="Copy to clipboard"
    >
      {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
    </button>
  );
}

function ConfigBlock({ title, config }: { title: string; config: string }) {
  return (
    <div>
      <h3 className="text-sm font-medium text-gray-300 mb-2">{title}</h3>
      <div className="relative">
        <pre className="bg-cannon-charcoal border border-cannon-graphite rounded-lg p-4 pr-12 text-sm text-gray-300 overflow-x-auto font-mono">
          {config}
        </pre>
        <CopyButton text={config} />
      </div>
    </div>
  );
}

export default function MCPSetupPage() {
  const [toolsExpanded, setToolsExpanded] = useState(false);

  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://your-instance';
  const mcpUrl = `${origin}/api/mcp`;

  const claudeConfig = JSON.stringify({
    mcpServers: {
      'log-cannon': {
        type: 'http',
        url: mcpUrl,
        headers: { 'X-Api-Key': 'your-api-key' },
      },
    },
  }, null, 2);

  const cursorConfig = JSON.stringify({
    mcpServers: {
      'log-cannon': {
        type: 'http',
        url: mcpUrl,
        headers: { 'X-Api-Key': 'your-api-key' },
      },
    },
  }, null, 2);

  const ingestTools = TOOLS.filter(t => t.scope === 'ingest');
  const readTools = TOOLS.filter(t => t.scope === 'read');
  const writeTools = TOOLS.filter(t => t.scope === 'write');

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 pt-20 pb-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white mb-2">MCP Server</h1>
        <p className="text-gray-400">
          Connect AI assistants and MCP-compatible clients directly to Log Cannon.
          Tools are automatically scoped to your API key&apos;s permissions.
        </p>
      </div>

      {/* Endpoint */}
      <div className="bg-cannon-iron border border-cannon-graphite rounded-lg p-6 mb-6">
        <h2 className="text-lg font-semibold text-white mb-3">Endpoint</h2>
        <div className="relative">
          <div className="bg-cannon-charcoal border border-cannon-graphite rounded-lg px-4 py-3 pr-12 font-mono text-sm text-cannon-fire break-all">
            {mcpUrl}
          </div>
          <CopyButton text={mcpUrl} />
        </div>
        <p className="text-sm text-gray-500 mt-2">
          POST requests only. Stateless — no session management required.
        </p>
      </div>

      {/* Auth */}
      <div className="bg-cannon-iron border border-cannon-graphite rounded-lg p-6 mb-6">
        <h2 className="text-lg font-semibold text-white mb-3">Authentication</h2>
        <p className="text-gray-400 text-sm mb-3">
          Include your API key in the <code className="text-cannon-fire bg-cannon-charcoal px-1.5 py-0.5 rounded">X-Api-Key</code> header
          or as <code className="text-cannon-fire bg-cannon-charcoal px-1.5 py-0.5 rounded">Authorization: Bearer &lt;key&gt;</code>.
        </p>
        <div className="flex items-center gap-2 text-sm">
          <Key className="w-4 h-4 text-gray-400" />
          <span className="text-gray-400">Need an API key?</span>
          <Link href="/keys" className="text-cannon-fire hover:text-cannon-ember transition-colors inline-flex items-center gap-1">
            Manage API Keys <ExternalLink className="w-3 h-3" />
          </Link>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
          <div className="bg-cannon-charcoal border border-cannon-graphite rounded-lg px-3 py-2">
            <span className="text-gray-500 block text-xs mb-1">ingest scope</span>
            <span className="text-gray-300">Create log entries</span>
          </div>
          <div className="bg-cannon-charcoal border border-cannon-graphite rounded-lg px-3 py-2">
            <span className="text-gray-500 block text-xs mb-1">read scope</span>
            <span className="text-gray-300">Ingest + query logs, dashboards, alerts</span>
          </div>
          <div className="bg-cannon-charcoal border border-cannon-graphite rounded-lg px-3 py-2">
            <span className="text-gray-500 block text-xs mb-1">write scope</span>
            <span className="text-gray-300">All read tools + create/update/delete resources</span>
          </div>
        </div>
      </div>

      {/* Config Snippets */}
      <div className="bg-cannon-iron border border-cannon-graphite rounded-lg p-6 mb-6">
        <h2 className="text-lg font-semibold text-white mb-4">Client Configuration</h2>
        <div className="space-y-5">
          <ConfigBlock
            title="Claude Code (~/.claude.json)"
            config={claudeConfig}
          />
          <ConfigBlock
            title="Cursor (.cursor/mcp.json)"
            config={cursorConfig}
          />
        </div>
        <p className="text-sm text-gray-500 mt-4">
          Replace <code className="text-gray-400">your-api-key</code> with a key that has at least <code className="text-gray-400">read</code> scope.
        </p>
      </div>

      {/* Tools */}
      <div className="bg-cannon-iron border border-cannon-graphite rounded-lg p-6">
        <button
          onClick={() => setToolsExpanded(!toolsExpanded)}
          className="flex items-center gap-2 w-full text-left"
        >
          {toolsExpanded ? <ChevronDown className="w-5 h-5 text-gray-400" /> : <ChevronRight className="w-5 h-5 text-gray-400" />}
          <h2 className="text-lg font-semibold text-white">Available Tools ({TOOLS.length})</h2>
        </button>

        {toolsExpanded && (
          <div className="mt-4 space-y-6">
            <div>
              <h3 className="text-sm font-medium text-gray-400 mb-2 uppercase tracking-wider">Ingest Tools ({ingestTools.length})</h3>
              <div className="space-y-1">
                {ingestTools.map(tool => (
                  <div key={tool.name} className="flex items-start gap-3 px-3 py-2 rounded-md hover:bg-cannon-charcoal transition-colors">
                    <code className="text-cannon-fire text-sm font-mono shrink-0 mt-0.5">{tool.name}</code>
                    <span className="text-gray-400 text-sm">{tool.description}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <h3 className="text-sm font-medium text-gray-400 mb-2 uppercase tracking-wider">Read Tools ({readTools.length})</h3>
              <div className="space-y-1">
                {readTools.map(tool => (
                  <div key={tool.name} className="flex items-start gap-3 px-3 py-2 rounded-md hover:bg-cannon-charcoal transition-colors">
                    <code className="text-cannon-fire text-sm font-mono shrink-0 mt-0.5">{tool.name}</code>
                    <span className="text-gray-400 text-sm">{tool.description}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <h3 className="text-sm font-medium text-gray-400 mb-2 uppercase tracking-wider">Write Tools ({writeTools.length})</h3>
              <div className="space-y-1">
                {writeTools.map(tool => (
                  <div key={tool.name} className="flex items-start gap-3 px-3 py-2 rounded-md hover:bg-cannon-charcoal transition-colors">
                    <code className="text-cannon-fire text-sm font-mono shrink-0 mt-0.5">{tool.name}</code>
                    <span className="text-gray-400 text-sm">{tool.description}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
