import type { Metadata } from "next";
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
      <head>
        {/* F-15: registers the Trusted Types 'default' policy before
            anything else runs, so require-trusted-types-for 'script' (see
            public/_headers) never blocks Next.js's own script-loading
            machinery or the Telegram Mini App bootstrap (next/script in
            src/app/telegram/layout.tsx).

            This must be a plain, parser-inserted <script> in <head>, not
            next/script. next/script (even beforeInteractive) loads its
            script at runtime by assigning a string to script.src, which is
            exactly the assignment the policy exists to allow -- so under
            enforcement it is blocked before the policy can register, and
            the policy never exists. A parser-inserted external script is
            not a DOM-sink assignment, is allowed by script-src 'self', and
            runs before any later script. */}
        {/* eslint-disable-next-line @next/next/no-sync-scripts -- synchronous on purpose: it must run before any other script */}
        <script src="/trusted-types-policy.js" />
      </head>
      <body className="antialiased">
        <a href="#main" className="sr-only">
          Skip to main content
        </a>
        <div id="main">{children}</div>
      </body>
    </html>
  );
}
