import Link from "next/link";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";

export default function Home() {
  return (
    <>
      <Nav />
      <main>
        <section className="hero">
          <div className="hero__inner">
            <p className="section-eyebrow">Arcana VPN</p>
            <h1 className="hero__title">A VPN without the noise.</h1>
            <p className="hero__lede">
              One plan. No upsells, no traffic charts, no server maps.
              Sign up, connect, and get on with your day.
            </p>
            <div className="hero__actions">
              <Link href="/signup" className="btn btn-primary">
                Get started
              </Link>
              <a href="#plan" className="btn btn-secondary">
                See the plan
              </a>
            </div>
            <div className="hero__tags">
              <span className="tag">VLESS + REALITY</span>
              <span className="tag">Hysteria2</span>
              <span className="tag">EU-based</span>
            </div>
          </div>
        </section>

        <section id="plan" className="dm-section">
          <div className="section-head">
            <p className="section-eyebrow">Plan</p>
            <h2 className="section-h2">One plan. That&apos;s it.</h2>
            <p className="section-sub">
              A single monthly subscription, usable on a couple of devices
              at once. No tiers to compare.
            </p>
          </div>
          <div className="dm-card" style={{ maxWidth: "26rem" }}>
            <div className="dm-card-header">
              <span className="dm-card-title">Arcana</span>
            </div>
            <div style={{ padding: "var(--space-6)" }}>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--space-3)",
                  marginBottom: "var(--space-6)",
                }}
              >
                <span className="check-row">
                  <span className="check-bullet">✓</span>
                  Unlimited data
                </span>
                <span className="check-row">
                  <span className="check-bullet">✓</span>
                  Works on a couple of devices at once
                </span>
                <span className="check-row">
                  <span className="check-bullet">✓</span>
                  Cancel anytime
                </span>
              </div>
              <Link href="/signup" className="btn btn-primary" style={{ width: "100%" }}>
                Get started
              </Link>
            </div>
          </div>
        </section>

        <section className="dm-section" style={{ borderBottom: "none" }}>
          <div className="section-head">
            <p className="section-eyebrow">Setup</p>
            <h2 className="section-h2">Works with the app you already use.</h2>
            <p className="section-sub">
              After signing up, you get a link and a QR code — import it into
              your VPN client of choice on iOS, Android, Windows, or macOS.
            </p>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
