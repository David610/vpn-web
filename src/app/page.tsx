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

const FEATURES = [
  {
    title: "1 server or 2 servers",
    body:
      "Connect through one server for speed, or two for extra privacy — one server sees your address, the other where you go. A 2-server connection never quietly becomes 1.",
  },
  {
    title: "Automatic",
    body:
      "Arcana picks a healthy location for you. Choose a country yourself whenever you want to.",
  },
  {
    title: "Your devices",
    body:
      "Three devices on one plan. See and remove them from your account, and add more in packs of three.",
  },
  {
    title: "Kept apart",
    body:
      "Your account and payment details are held separately from your VPN connection. No ads, no analytics, no browsing history.",
  },
];

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
              <a href="#pricing" className="btn btn-secondary">
                View pricing
              </a>
            </div>
            <p className="hero__meta">
              <span>€6.99 / month</span>
              <span>3 devices</span>
              <span>Cancel anytime</span>
            </p>
          </div>
        </section>

        <section id="features" className="dm-section">
          <div className="section-head">
            <p className="section-eyebrow">Features</p>
            <h2 className="section-h2">What it does, and nothing else.</h2>
          </div>
          <div className="grid-rule">
            {FEATURES.map((feature, index) => (
              <div key={feature.title} className="grid-rule__cell">
                <p className="grid-rule__index">{String(index + 1).padStart(2, "0")}</p>
                <h3 className="grid-rule__title">{feature.title}</h3>
                <p className="grid-rule__body">{feature.body}</p>
              </div>
            ))}
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

        <section id="pricing" className="dm-section">
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
                <li>1-server and 2-server connections</li>
                <li>Manage your devices from your account</li>
                <li>Cancel anytime from your account</li>
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

        <section className="dm-section" style={{ borderBottom: "none" }}>
          <div className="section-head">
            <p className="section-eyebrow">Getting started</p>
            <h2 className="section-h2">Three steps.</h2>
          </div>
          <div className="grid-rule grid-rule--3">
            <div className="grid-rule__cell">
              <p className="grid-rule__index">01</p>
              <h3 className="grid-rule__title">Create an account</h3>
              <p className="grid-rule__body">An email and a password.</p>
            </div>
            <div className="grid-rule__cell">
              <p className="grid-rule__index">02</p>
              <h3 className="grid-rule__title">Subscribe</h3>
              <p className="grid-rule__body">€6.99 a month. Cancel anytime.</p>
            </div>
            <div className="grid-rule__cell">
              <p className="grid-rule__index">03</p>
              <h3 className="grid-rule__title">Connect</h3>
              <p className="grid-rule__body">
                Set up your devices from your account and connect.
              </p>
            </div>
          </div>
          <p className="muted" style={{ marginTop: "var(--space-8)" }}>
            Already have an account? <Link href="/login" className="text-link">Log in</Link>
          </p>
        </section>
      </main>
      <Footer />
    </>
  );
}
