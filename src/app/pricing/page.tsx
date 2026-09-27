import Link from "next/link";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { SITE_NAME, SITE_URL } from "@/lib/site-config";

export const metadata = {
  description: `${SITE_NAME} pricing: one plan, €6.99 a month for 3 devices, plus device packs.`,
  alternates: { canonical: `${SITE_URL}/pricing/` },
};

export default function PricingPage() {
  return (
    <>
      <Nav />
      <main>
        <section className="dm-section" style={{ borderBottom: "none" }}>
          <div className="section-head">
            <p className="section-eyebrow">Pricing</p>
            <h1 className="section-h2">One plan.</h1>
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
      </main>
      <Footer />
    </>
  );
}
