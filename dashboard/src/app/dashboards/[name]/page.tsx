import { getDashboardByName } from '@/lib/clickhouse';
import { DashboardView } from '@/components/dashboards/DashboardView';
import { ShareButton } from '@/components/dashboards/ShareButton';
import { AutoRefreshToggle } from '@/components/dashboards/AutoRefreshToggle';
import { AlertCircle, ArrowLeft } from 'lucide-react';
import Link from 'next/link';

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  const dashboard = await getDashboardByName(name);

  if (!dashboard) {
    return (
      <div className="animate-fade-in">
        <Link
          href="/dashboards"
          className="inline-flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors mb-6"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Dashboards
        </Link>

        <div className="card-cannon border-cannon-critical/50 bg-cannon-critical/10 p-6">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-cannon-critical flex-shrink-0 mt-0.5" />
            <div>
              <h3 className="font-medium text-cannon-critical">Dashboard Not Found</h3>
              <p className="text-text-secondary text-sm mt-1">
                No dashboard found with name: {name}
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!dashboard.enabled) {
    return (
      <div className="animate-fade-in">
        <Link
          href="/dashboards"
          className="inline-flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors mb-6"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Dashboards
        </Link>

        <div className="card-cannon border-cannon-warning/50 bg-cannon-warning/10 p-6">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-cannon-warning flex-shrink-0 mt-0.5" />
            <div>
              <h3 className="font-medium text-cannon-warning">Dashboard Disabled</h3>
              <p className="text-text-secondary text-sm mt-1">
                This dashboard is currently disabled.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="mb-6">
        <Link
          href="/dashboards"
          className="inline-flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors mb-3"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Dashboards
        </Link>

        <div className="flex justify-between items-start">
          <div>
            <h1 className="text-2xl font-bold text-text-primary font-mono">
              {dashboard.name}
            </h1>
            {dashboard.description && (
              <p className="text-text-secondary text-sm mt-1">
                {dashboard.description}
              </p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <AutoRefreshToggle />
            <ShareButton />
          </div>
        </div>
      </div>

      {/* Dashboard */}
      <DashboardView dashboard={dashboard} />
    </div>
  );
}
