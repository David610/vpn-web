import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";
import { SITE_URL, SITE_NAME, IS_PRODUCTION } from "@/lib/site-config";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${SITE_NAME} — Private VPN access`,
    template: `%s — ${SITE_NAME}`,
  },
  robots: IS_PRODUCTION
    ? { index: true, follow: true }
    : { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        {/* F-15: must register the Trusted Types 'default' policy before
            anything else runs, so require-trusted-types-for 'script' (see
            public/_headers) never blocks Next.js's own script-loading
            machinery or the Telegram Mini App bootstrap (next/script in
            src/app/telegram/layout.tsx). beforeInteractive guarantees this
            executes ahead of hydration and any other Script tag. */}
        <Script src="/trusted-types-policy.js" strategy="beforeInteractive" />
        <a href="#main" className="sr-only">
          Skip to main content
        </a>
        <div id="main">{children}</div>
      </body>
    </html>
  );
}
