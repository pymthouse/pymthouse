import Link from "next/link";

interface Props {
  appId: string;
  appName: string;
}

/**
 * In-app navigation: My Apps → app → Plans (current).
 */
export default function AppSectionBreadcrumb({ appId, appName }: Readonly<Props>) {
  return (
    <nav className="text-sm text-zinc-500 mb-3" aria-label="Breadcrumb">
      <Link href="/apps" className="hover:text-zinc-300 transition-colors">
        My Apps
      </Link>
      <span className="mx-1.5 text-zinc-600" aria-hidden>
        /
      </span>
      <Link href={`/apps/${appId}`} className="hover:text-zinc-300 transition-colors">
        {appName}
      </Link>
      <span className="mx-1.5 text-zinc-600" aria-hidden>
        /
      </span>
      <span className="text-zinc-200 font-medium" aria-current="page">
        Plans
      </span>
    </nav>
  );
}
