import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import Image from "next/image";
import { SITE_NAME, SITE_URL } from "@/lib/site-config";

export const metadata = {
  title: `Apps — ${SITE_NAME}`,
  description: `Get the ${SITE_NAME} app for your device. Same account, all your devices.`,
  alternates: { canonical: `${SITE_URL}/apps/` },
};

// Set at build time once a signed Windows installer is published. Until then
// the page says so instead of pointing at a file that does not exist.
const WINDOWS_DOWNLOAD_URL = process.env.NEXT_PUBLIC_WINDOWS_DOWNLOAD_URL || "";

const FEATURES = [
  { title: "Easy to use", text: "Connect in one tap. No complex settings.", d: "M5 3l12 9-5 1-3 5z" },
  { title: "Works in the background", text: "Stays out of your way while keeping you protected.", d: "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" },
  { title: "Automatic reconnection", text: "Keeps you secure if your connection drops.", d: "M20 12a8 8 0 0 1-14 5.3M4 12a8 8 0 0 1 14-5.3M18 3v4h-4M6 21v-4h4" },
  { title: "Kill switch", text: "Blocks internet if the VPN disconnects.", d: "M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6l7-3z" },
];

const ICON_PATHS = {
  windows: "M3 5.5l8-1.1v7.1H3zM12 4.3l9-1.3v8.5h-9zM3 12.5h8v7.1l-8-1.1zM12 12.5h9V21l-9-1.3z",
  macos: "M5 5h14v10H5zM3 19h18",
  ios: "M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2",
  android: "M6 15a6 6 0 0 1 12 0zM9 9L7.5 6.5M15 9l1.5-2.5M9.5 12h.01M14.5 12h.01",
  linux: "M4 5h16v14H4zM8 10l3 2-3 2M13 14h4",
} as const;

const PLATFORMS = [
  { name: "Windows", req: "10+", available: true, icon: "windows" },
  { name: "macOS", req: "11+", available: false, icon: "macos" },
  { name: "iOS", req: "15+", available: false, icon: "ios" },
  { name: "Android", req: "8.0+", available: false, icon: "android" },
  { name: "Linux", req: "Various distros", available: false, icon: "linux" },
] as const;

function PlatformIcon({ name, size = 28 }: { name: keyof typeof ICON_PATHS; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

export default function AppsPage() {
  return (
    <>
      <Nav />
      <main className="page">
        <section className="apps-hero">
          <div>
            <p className="eyebrow">Apps</p>
            <h1 className="page__title page__title--sm">Apps for all your devices.</h1>
            <p className="page__lede">Connect on your terms.</p>
            <p className="page__body">
              Get the {SITE_NAME} app for your preferred device and enjoy private, secure access to a more
              open internet. Same account. All your devices.
            </p>
            <ul className="feature-list">
              {FEATURES.map((f) => (
                <li key={f.title}>
                  <span className="feature-list__icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d={f.d} />
                    </svg>
                  </span>
                  <span>
                    <strong>{f.title}</strong>
                    <span className="muted">{f.text}</span>
                  </span>
                </li>
              ))}
            </ul>
            {WINDOWS_DOWNLOAD_URL ? (
              <a className="btn btn-primary btn-lg btn--icon" href={WINDOWS_DOWNLOAD_URL}>
                <PlatformIcon name="windows" size={22} /> Download for Windows
              </a>
            ) : (
              <span className="btn btn-primary btn-lg btn--icon btn--disabled" aria-disabled="true">
                <PlatformIcon name="windows" size={22} /> Windows download coming soon
              </span>
            )}
            <p className="fineprint">Requires Windows 10 or later.</p>
          </div>
          <Image
            className="hero-image"
            src="/images/hero-apps.webp"
            width={795}
            height={500}
            alt="The Arcana app connected on a laptop"
            priority
          />
        </section>

        <ul className="platforms">
          {PLATFORMS.map((p) => (
            <li key={p.name} className={`platforms__tile${p.available ? " platforms__tile--on" : ""}`}>
              <PlatformIcon name={p.icon} />
              <span className="platforms__text">
                <strong>{p.name}</strong>
                <span className="muted">{p.available ? p.req : `${p.req} · Coming soon`}</span>
              </span>
            </li>
          ))}
        </ul>

        <p className="setup-line">
          <strong>Setup in minutes. End with a verified, protected connection.</strong>
          <span className="muted">
            Download the app, sign in, connect, and you’re ready. {SITE_NAME} encrypts your traffic and hides
            your IP address across all your devices.
          </span>
        </p>
      </main>
      <Footer />
    </>
  );
}
