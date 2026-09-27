import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import WorldMap from "@/components/WorldMap";
import HeroActions from "@/components/HeroActions";
import HomeFootnote from "@/components/HomeFootnote";
import { SITE_URL } from "@/lib/site-config";

export const metadata = {
  description:
    "Arcana is private VPN access without the clutter. One plan: €6.99 a month for 3 devices.",
  alternates: { canonical: `${SITE_URL}/` },
};

export default function Home() {
  return (
    <>
      <Nav />
      <main>
        <section className="hero">
          <div className="hero__frame">
            <div className="hero__grid">
              <div className="hero__copy">
                <p className="section-eyebrow">Arcana</p>
                <h1 className="hero__title">
                  A simpler
                  <br />
                  internet.
                </h1>
                <p className="hero__lede">
                  Private VPN access, without the clutter.
                </p>
                <HeroActions />
                <p className="hero__meta">
                  <span>€6.99 / month</span>
                  <span>3 devices</span>
                </p>
              </div>
              <div className="hero__visual" aria-hidden="true">
                <WorldMap />
              </div>
            </div>
            <div className="hero__strip">
              <div className="hero__strip-cell">Stronger privacy</div>
              <div className="hero__strip-cell">Fast global access</div>
            </div>
          </div>
        </section>

        <HomeFootnote />
      </main>
      <Footer />
    </>
  );
}
