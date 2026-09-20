import type { Metadata } from "next";
import "./globals.css";
import { SITE_URL, SITE_NAME, IS_PRODUCTION } from "@/lib/site-config";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${SITE_NAME} — A VPN without the noise`,
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
        <a href="#main" className="sr-only">
          Skip to main content
        </a>
        <div id="main">{children}</div>
      </body>
    </html>
  );
}
