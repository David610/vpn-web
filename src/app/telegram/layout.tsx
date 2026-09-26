import type { Metadata } from "next";
import Script from "next/script";

export const metadata: Metadata = {
  title: "Telegram",
  robots: { index: false, follow: false },
};

export default function TelegramLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Script src="https://telegram.org/js/telegram-web-app.js" strategy="beforeInteractive" />
      {children}
    </>
  );
}
