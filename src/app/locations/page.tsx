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
      <main>
        <section className="dm-section" style={{ borderBottom: "none" }}>
          <div className="section-head">
            <p className="section-eyebrow">Locations</p>
            <h1 className="section-h2">Where you can connect.</h1>
            <p className="section-sub">
              Only locations with a server running right now are listed.
            </p>
          </div>
          <LocationsList />
        </section>
      </main>
      <Footer />
    </>
  );
}
