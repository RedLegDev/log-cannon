'use client';

import { useState } from 'react';
import { Server, Cloud, Zap, Webhook, Copy, Check, ChevronDown, ChevronRight, ExternalLink, Key } from 'lucide-react';
import Link from 'next/link';

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

function CodeBlock({ code }: { code: string }) {
  return (
    <div className="relative">
      <pre className="bg-cannon-charcoal border border-cannon-graphite rounded-lg p-4 pr-12 text-sm text-gray-300 overflow-x-auto font-mono">
        {code}
      </pre>
      <CopyButton text={code} />
    </div>
  );
}

function CollapsibleSection({
  icon: Icon,
  title,
  children,
  defaultOpen = false,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultOpen);

  return (
    <div className="bg-cannon-iron border border-cannon-graphite rounded-lg p-6">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full text-left"
      >
        {expanded ? <ChevronDown className="w-5 h-5 text-gray-400" /> : <ChevronRight className="w-5 h-5 text-gray-400" />}
        <Icon className="w-5 h-5 text-cannon-fire" />
        <h2 className="text-lg font-semibold text-white">{title}</h2>
      </button>
      {expanded && <div className="mt-4 space-y-4">{children}</div>}
    </div>
  );
}

export default function IntegrationsPage() {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://your-log-cannon-instance';
  const ingestBase = origin.replace(/:\d+$/, ':8080');

  const serilogInstall = `dotnet add package Serilog.Sinks.Seq`;

  const serilogCode = `using Serilog;

Log.Logger = new LoggerConfiguration()
    .MinimumLevel.Debug()
    .WriteTo.Seq("${ingestBase}")
    .Enrich.WithProperty("Application", "MyApp")
    .CreateLogger();

Log.Information("Order {OrderId} placed by {User}", orderId, user);`;

  const cloudflareDestination = `${ingestBase}/ingest/webhook?preset=cloudflare`;

  const cloudflareOutputOptions = JSON.stringify({
    "timestamp_format": "rfc3339",
    "sample_rate": 1,
    "field_names": {
      "ClientIP": "ClientIP",
      "ClientRequestHost": "ClientRequestHost",
      "ClientRequestMethod": "ClientRequestMethod",
      "ClientRequestURI": "ClientRequestURI",
      "EdgeResponseStatus": "EdgeResponseStatus",
      "EdgeStartTimestamp": "EdgeStartTimestamp",
      "RayID": "RayID"
    }
  }, null, 2);

  const cloudflareCurl = `curl -X POST \\
  "https://api.cloudflare.com/client/v4/zones/{zone_id}/logpush/jobs" \\
  -H "Authorization: Bearer {cf_api_token}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "destination_conf": "${ingestBase}/ingest/webhook?preset=cloudflare&header_X-Api-Key={your_lc_api_key}",
    "dataset": "http_requests",
    "enabled": true,
    "output_options": ${cloudflareOutputOptions}
  }'`;

  const otelWranglerConfig = `// wrangler.jsonc
{
  "observability": {
    "enabled": true,
    "logs": { "enabled": true },
    "head_sampling_rate": 1
  },
  // Baselime-compatible binding
  "tail_consumers": [
    {
      "service": "log-cannon-otel-worker",
      "environment": "production"
    }
  ]
}`;

  const otelNodeCode = `import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';

const exporter = new OTLPLogExporter({
  url: '${ingestBase}/v1/logs',
  headers: { 'X-Api-Key': 'your-api-key' },
});

const loggerProvider = new LoggerProvider();
loggerProvider.addLogRecordProcessor(
  new BatchLogRecordProcessor(exporter)
);

const logger = loggerProvider.getLogger('my-service');
logger.emit({ body: 'Hello from OTel!' });`;

  const otelCurl = `curl -X POST "${ingestBase}/v1/logs" \\
  -H "Content-Type: application/json" \\
  -H "X-Api-Key: your-api-key" \\
  -d '{
    "resourceLogs": [{
      "resource": { "attributes": [{ "key": "service.name", "value": { "stringValue": "test" } }] },
      "scopeLogs": [{
        "logRecords": [{
          "timeUnixNano": "'$(date +%s)'000000000",
          "severityText": "INFO",
          "body": { "stringValue": "Hello from curl" }
        }]
      }]
    }]
  }'`;

  const webhookBasicCurl = `curl -X POST "${ingestBase}/ingest/webhook" \\
  -H "Content-Type: application/json" \\
  -H "X-Api-Key: your-api-key" \\
  -d '{"message": "deploy finished", "level": "Information", "source": "ci-pipeline"}'`;

  const webhookGzipCurl = `echo '{"message":"compressed log","level":"Information"}' \\
  | gzip \\
  | curl -X POST "${ingestBase}/ingest/webhook" \\
    -H "Content-Type: application/json" \\
    -H "Content-Encoding: gzip" \\
    -H "X-Api-Key: your-api-key" \\
    --data-binary @-`;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 pt-20 pb-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white mb-2">Integrations</h1>
        <p className="text-gray-400">
          Send logs to Log Cannon from any source. All endpoints feed into the same events table and dashboard.
        </p>
      </div>

      {/* Authentication */}
      <div className="bg-cannon-iron border border-cannon-graphite rounded-lg p-6 mb-6">
        <h2 className="text-lg font-semibold text-white mb-3">Authentication</h2>
        <p className="text-gray-400 text-sm mb-3">
          All endpoints require an API key. Use any of these methods:
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
          <div className="bg-cannon-charcoal border border-cannon-graphite rounded-lg px-3 py-2">
            <span className="text-gray-500 block text-xs mb-1">Header (preferred)</span>
            <code className="text-cannon-fire text-sm">X-Api-Key: your-key</code>
          </div>
          <div className="bg-cannon-charcoal border border-cannon-graphite rounded-lg px-3 py-2">
            <span className="text-gray-500 block text-xs mb-1">Seq-compatible header</span>
            <code className="text-cannon-fire text-sm">X-Seq-ApiKey: your-key</code>
          </div>
          <div className="bg-cannon-charcoal border border-cannon-graphite rounded-lg px-3 py-2">
            <span className="text-gray-500 block text-xs mb-1">Bearer token</span>
            <code className="text-cannon-fire text-sm">Authorization: Bearer your-key</code>
          </div>
          <div className="bg-cannon-charcoal border border-cannon-graphite rounded-lg px-3 py-2">
            <span className="text-gray-500 block text-xs mb-1">Query parameter</span>
            <code className="text-cannon-fire text-sm">?apiKey=your-key</code>
          </div>
        </div>
        <CodeBlock code={`X-Api-Key: your-api-key`} />
        <div className="flex items-center gap-2 text-sm mt-3">
          <Key className="w-4 h-4 text-gray-400" />
          <span className="text-gray-400">Need an API key?</span>
          <Link href="/keys" className="text-cannon-fire hover:text-cannon-ember transition-colors inline-flex items-center gap-1">
            Manage API Keys <ExternalLink className="w-3 h-3" />
          </Link>
        </div>
      </div>

      {/* Endpoints Overview */}
      <div className="bg-cannon-iron border border-cannon-graphite rounded-lg p-6 mb-6">
        <h2 className="text-lg font-semibold text-white mb-4">Endpoints Overview</h2>
        <div className="space-y-3">
          <div className="flex items-start gap-3">
            <span className="shrink-0 mt-0.5 px-2 py-0.5 rounded text-xs font-bold bg-green-900/50 text-green-400 border border-green-800">POST</span>
            <div>
              <code className="text-cannon-fire text-sm font-mono">/ingest/clef</code>
              <p className="text-gray-400 text-sm mt-0.5">Structured logging via Compact Log Event Format</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <span className="shrink-0 mt-0.5 px-2 py-0.5 rounded text-xs font-bold bg-green-900/50 text-green-400 border border-green-800">POST</span>
            <div>
              <code className="text-cannon-fire text-sm font-mono">/ingest/webhook</code>
              <p className="text-gray-400 text-sm mt-0.5">Generic ndjson receiver with provider presets</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <span className="shrink-0 mt-0.5 px-2 py-0.5 rounded text-xs font-bold bg-green-900/50 text-green-400 border border-green-800">POST</span>
            <div>
              <code className="text-cannon-fire text-sm font-mono">/v1/logs</code>
              <p className="text-gray-400 text-sm mt-0.5">OpenTelemetry log records (protobuf or JSON)</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <span className="shrink-0 mt-0.5 px-2 py-0.5 rounded text-xs font-bold bg-green-900/50 text-green-400 border border-green-800">POST</span>
            <div>
              <code className="text-cannon-fire text-sm font-mono">/v1/traces</code>
              <p className="text-gray-400 text-sm mt-0.5">OpenTelemetry trace spans (protobuf or JSON)</p>
            </div>
          </div>
        </div>
        <p className="text-gray-500 text-sm mt-4 pt-4 border-t border-cannon-graphite">
          Pass your API key via the <code className="text-gray-400">X-Api-Key</code> header on all requests.
        </p>
      </div>

      <div className="space-y-4">
        {/* Serilog / .NET */}
        <CollapsibleSection icon={Server} title="Serilog / .NET">
          <p className="text-gray-400 text-sm">
            Use the Serilog Seq sink to send structured logs from any .NET application. The Seq sink posts CLEF-formatted events
            to <code className="text-cannon-fire bg-cannon-charcoal px-1.5 py-0.5 rounded">/api/events/raw</code>, which Log Cannon supports natively.
          </p>

          <div>
            <h3 className="text-sm font-medium text-gray-300 mb-2">1. Install the NuGet package</h3>
            <CodeBlock code={serilogInstall} />
          </div>

          <div>
            <h3 className="text-sm font-medium text-gray-300 mb-2">2. Configure Serilog</h3>
            <CodeBlock code={serilogCode} />
          </div>

          <p className="text-gray-500 text-sm">
            The Seq sink uses <code className="text-gray-400">/api/events/raw</code> under the hood, which maps to the CLEF ingestion endpoint.
          </p>
        </CollapsibleSection>

        {/* Cloudflare Logpush */}
        <CollapsibleSection icon={Cloud} title="Cloudflare Logpush">
          <p className="text-gray-400 text-sm">
            Push Cloudflare HTTP request logs, Workers logs, or any Logpush dataset directly to Log Cannon.
          </p>

          <div>
            <h3 className="text-sm font-medium text-gray-300 mb-2">Setup Steps</h3>
            <ol className="list-decimal list-inside text-gray-400 text-sm space-y-1.5">
              <li>Open the Cloudflare dashboard and navigate to <strong className="text-gray-300">Analytics &amp; Logs &gt; Logpush</strong></li>
              <li>Create a new Logpush job and select the dataset (e.g. HTTP requests)</li>
              <li>Choose <strong className="text-gray-300">Custom HTTP destination</strong></li>
              <li>Set the destination URL to your Log Cannon webhook endpoint with the Cloudflare preset</li>
              <li>Add your API key as a header parameter in the destination URL</li>
            </ol>
          </div>

          <div>
            <h3 className="text-sm font-medium text-gray-300 mb-2">Destination URL</h3>
            <CodeBlock code={cloudflareDestination} />
          </div>

          <div>
            <h3 className="text-sm font-medium text-gray-300 mb-2">Recommended Output Options</h3>
            <CodeBlock code={cloudflareOutputOptions} />
          </div>

          <div>
            <h3 className="text-sm font-medium text-gray-300 mb-2">Create via Cloudflare API</h3>
            <CodeBlock code={cloudflareCurl} />
          </div>
        </CollapsibleSection>

        {/* OpenTelemetry */}
        <CollapsibleSection icon={Zap} title="OpenTelemetry">
          <p className="text-gray-400 text-sm">
            Send logs and traces using the OpenTelemetry protocol (OTLP). Supports both JSON and protobuf payloads.
          </p>

          <div>
            <h3 className="text-sm font-medium text-gray-300 mb-2">Cloudflare Workers (wrangler.jsonc)</h3>
            <CodeBlock code={otelWranglerConfig} />
          </div>

          <div>
            <h3 className="text-sm font-medium text-gray-300 mb-2">Node.js OTel SDK</h3>
            <CodeBlock code={otelNodeCode} />
          </div>

          <div>
            <h3 className="text-sm font-medium text-gray-300 mb-2">Test with curl</h3>
            <CodeBlock code={otelCurl} />
          </div>
        </CollapsibleSection>

        {/* Generic Webhook */}
        <CollapsibleSection icon={Webhook} title="Generic Webhook">
          <p className="text-gray-400 text-sm">
            Send JSON or ndjson payloads to the webhook endpoint. Log Cannon auto-detects common fields and normalizes them into structured events.
          </p>

          <div>
            <h3 className="text-sm font-medium text-gray-300 mb-2">Basic Example</h3>
            <CodeBlock code={webhookBasicCurl} />
          </div>

          <div>
            <h3 className="text-sm font-medium text-gray-300 mb-2">Gzip Compressed</h3>
            <CodeBlock code={webhookGzipCurl} />
          </div>

          <div>
            <h3 className="text-sm font-medium text-gray-300 mb-2">Available Presets</h3>
            <div className="bg-cannon-charcoal border border-cannon-graphite rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-cannon-graphite">
                    <th className="text-left px-4 py-2 text-gray-400 font-medium">Preset</th>
                    <th className="text-left px-4 py-2 text-gray-400 font-medium">Provider</th>
                  </tr>
                </thead>
                <tbody className="text-gray-300">
                  <tr className="border-b border-cannon-graphite/50">
                    <td className="px-4 py-2 font-mono text-cannon-fire">cloudflare</td>
                    <td className="px-4 py-2">Cloudflare Logpush — maps EdgeStartTimestamp, EdgeResponseStatus, builds request message</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-2 font-mono text-gray-400">(none)</td>
                    <td className="px-4 py-2">Auto-detect — scans for common timestamp/level field names</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <h3 className="text-sm font-medium text-gray-300 mb-2">Auto-detected Fields</h3>
            <p className="text-gray-400 text-sm mb-2">
              When no preset is specified, the webhook endpoint auto-detects these fields from your JSON payload:
            </p>
            <div className="flex flex-wrap gap-2">
              {['message', 'msg', 'level', 'severity', 'timestamp', 'time', 'source', 'service', 'logger', 'exception', 'error', 'stack'].map((field) => (
                <code key={field} className="text-xs bg-cannon-charcoal border border-cannon-graphite px-2 py-1 rounded text-gray-300 font-mono">
                  {field}
                </code>
              ))}
            </div>
          </div>
        </CollapsibleSection>
      </div>
    </div>
  );
}
