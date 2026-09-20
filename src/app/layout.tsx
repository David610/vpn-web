import type { Metadata } from "next";
import "./globals.css";
import { SITE_URL, SITE_NAME, IS_PRODUCTION } from "@/lib/site-config";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: `${SITE_NAME} — A VPN without the noise`,
  description:
    "A fast, private VPN with one plan and no upsells. Sign up, pay, connect.",
  robots: IS_PRODUCTION
    ? { index: true, follow: true }
    : { index: false, follow: false },
  alternates: { canonical: `${SITE_URL}/` },
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
