import Link from "next/link";
import type { ReactNode } from "react";

export function MarketingFooter({ className = "" }: Readonly<{ className?: string }>) {
  return (
    <footer
      className={`border-t border-zinc-800 pt-6 pb-2 ${className}`.trim()}
    >
      <div className="grid grid-cols-2 gap-6 text-xs sm:gap-8">
        <FooterColumn title="Explore">
          <Link
            href="/"
            className="block text-zinc-400 transition-colors hover:text-zinc-200"
          >
            Home
          </Link>
          <Link
            href="/#solutions"
            className="block text-zinc-400 transition-colors hover:text-zinc-200"
          >
            Solutions
          </Link>
          <Link
            href="/marketplace"
            className="block text-zinc-400 transition-colors hover:text-zinc-200"
          >
            Marketplace
          </Link>
          <Link
            href="/start"
            className="block text-zinc-400 transition-colors hover:text-zinc-200"
          >
            Get Started
          </Link>
        </FooterColumn>

        <FooterColumn title="Help">
          <a
            href="https://github.com/pymthouse/pymthouse"
            target="_blank"
            rel="noopener noreferrer"
            className="block text-zinc-400 transition-colors hover:text-zinc-200"
          >
            GitHub
          </a>
          <a
            href="https://docs.pymthouse.com"
            target="_blank"
            rel="noopener noreferrer"
            className="block text-zinc-400 transition-colors hover:text-zinc-200"
          >
            Docs
          </a>
          <a
            href="https://github.com/livepeer/livepeer-python-gateway"
            target="_blank"
            rel="noopener noreferrer"
            className="block text-zinc-400 transition-colors hover:text-zinc-200"
          >
            Python SDK
          </a>
          <a
            href="mailto:john@eliteencoder.net"
            className="block text-zinc-400 transition-colors hover:text-zinc-200"
          >
            Support
          </a>
        </FooterColumn>
      </div>
    </footer>
  );
}

function FooterColumn({
  title,
  children,
}: Readonly<{
  title: string;
  children: ReactNode;
}>) {
  return (
    <div>
      <p className="mb-3 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
        {title}
      </p>
      <div className="space-y-2">{children}</div>
    </div>
  );
}
