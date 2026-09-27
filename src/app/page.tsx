import Link from "next/link";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import LocationsList from "@/components/LocationsList";
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
          <div className="hero__inner">
            <p className="section-eyebrow">Arcana</p>
            <h1 className="hero__title">A simpler, more private internet.</h1>
            <p className="hero__lede">
              Private VPN access without the clutter. One plan, a few
              devices, and nothing to configure.
            </p>
            <div className="hero__actions">
              <Link href="/signup" className="btn btn-primary">
                Create account
              </Link>
            </div>
            <p className="hero__meta">
              <span>€6.99 / month</span>
              <span>3 devices</span>
              <span>Cancel anytime</span>
            </p>
          </div>
        </section>

        <section id="locations" className="dm-section">
          <div className="section-head">
            <p className="section-eyebrow">Locations</p>
            <h2 className="section-h2">Where you can connect.</h2>
            <p className="section-sub">
              Only locations with a server running right now are listed.
            </p>
          </div>
          <LocationsList />
        </section>

        <section id="pricing" className="dm-section" style={{ borderBottom: "none" }}>
          <div className="section-head">
            <p className="section-eyebrow">Pricing</p>
            <h2 className="section-h2">One plan.</h2>
            <p className="section-sub">
              No tiers to compare. Add devices in packs of three when you
              need them.
            </p>
          </div>
          <div className="plan">
            <div className="plan__main">
              <p className="plan__price">
                €6.99 <span className="plan__unit">/ month</span>
              </p>
              <p className="muted">3 devices included</p>
              <ul className="plan__list">
                <li>Every Arcana location</li>
                <li>1 server for speed, or 2 for an extra hop — never silently downgraded</li>
                <li>Manage devices and cancel anytime from your account</li>
              </ul>
              <Link href="/signup" className="btn btn-primary">
                Subscribe
              </Link>
            </div>
            <div className="plan__side">
              <table className="plan__table">
                <caption className="sr-only">Monthly price by number of devices</caption>
                <thead>
                  <tr>
                    <th scope="col">Devices</th>
                    <th scope="col">Per month</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>3</td>
                    <td>€6.99</td>
                  </tr>
                  <tr>
                    <td>6</td>
                    <td>€13.98</td>
                  </tr>
                  <tr>
                    <td>9</td>
                    <td>€20.97</td>
                  </tr>
                </tbody>
              </table>
              <p className="muted" style={{ marginTop: "var(--space-4)" }}>
                Each extra pack of 3 devices is €6.99 / month.
              </p>
            </div>
          </div>
        </section>

        <p className="muted" style={{ maxWidth: "var(--container-max)", margin: "0 auto", padding: "0 var(--container-pad) var(--space-24)" }}>
          Already have an account? <Link href="/login" className="text-link">Log in</Link>
        </p>
      </main>
      <Footer />
    </>
  );
}
