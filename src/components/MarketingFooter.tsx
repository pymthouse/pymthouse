import Link from "next/link";

export function MarketingFooter({ className = "" }: { className?: string }) {
  return (
    <footer
      className={`border-t border-zinc-800 pt-4 ${className}`.trim()}
    >
      <div className="grid grid-cols-3 gap-3 text-xs">
        <div>
          <p className="text-zinc-500 uppercase tracking-wider mb-2">Explore</p>
          <div className="space-y-1.5">
            <Link
              href="/"
              className="block text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Home
            </Link>
            <Link
              href="/#solutions"
              className="block text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Solutions
            </Link>
            <Link
              href="/marketplace"
              className="block text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Marketplace
            </Link>
          </div>
        </div>
        <div>
          <p className="text-zinc-500 uppercase tracking-wider mb-2">Platform</p>
          <div className="space-y-1.5">
            <Link
              href="/apps"
              className="block text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              My Apps
            </Link>
          </div>
        </div>
        <div>
          <p className="text-zinc-500 uppercase tracking-wider mb-2">Help</p>
          <div className="space-y-1.5">
            <a
              href="https://github.com/pymthouse/pymthouse"
              target="_blank"
              rel="noopener noreferrer"
              className="block text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              GitHub
            </a>
            <a
              href="https://docs.pymthouse.com"
              target="_blank"
              rel="noopener noreferrer"
              className="block text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Docs
            </a>
            <a
              href="https://github.com/livepeer/livepeer-python-gateway"
              target="_blank"
              rel="noopener noreferrer"
              className="block text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Python SDK
            </a>
            <a
              href="mailto:john@eliteencoder.net"
              className="block text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Support
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
