import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import LocationsList from "@/components/LocationsList";
import { SITE_NAME, SITE_URL } from "@/lib/site-config";

export const metadata = {
  description: `Where ${SITE_NAME} can connect — every location with a server running right now.`,
  alternates: { canonical: `${SITE_URL}/locations/` },
};

export default function LocationsPage() {
  return (
    <>
      <Nav />
      <main className="page page--split">
        <div className="page__main">
          <h1 className="page__title">Locations</h1>
          <p className="page__lede">Connect through privacy-focused locations around the world.</p>
          <p className="page__body">
            Our network helps you access a more open internet, protects your connection and keeps
            your IP address private — on your terms. Only locations with a server running right now
            are listed.
          </p>
          <LocationsList />
        </div>
        <aside className="page__aside">
          <div className="panel">
            <p className="eyebrow">Connection options</p>
            <div className="option">
              <span className="option__icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18" />
                </svg>
              </span>
              <div>
                <h2 className="option__title">
                  Automatic <span className="pill pill--ok">Recommended</span>
                </h2>
                <p className="muted">
                  Connect to the best location for you automatically. We choose the fastest, most
                  reliable server based on your location and network conditions.
                </p>
              </div>
            </div>
            <div className="option">
              <span className="option__icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="6" cy="18" r="2.2" />
                  <circle cx="18" cy="6" r="2.2" />
                  <path d="M7.6 16.4C10 14 11 13 13 11s3-3 3.4-3.4" />
                </svg>
              </span>
              <div>
                <h2 className="option__title">
                  Two servers <span className="pill">Extra privacy</span>
                </h2>
                <p className="muted">
                  Route your connection through two locations instead of one for an additional layer
                  of privacy. This may reduce performance.
                </p>
              </div>
            </div>
          </div>
        </aside>
      </main>
      <Footer />
    </>
  );
}
