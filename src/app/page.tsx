import Image from "next/image";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import HeroActions from "@/components/HeroActions";
import { SITE_URL } from "@/lib/site-config";

export const metadata = {
  description:
    "Arcana is private VPN access without the clutter. One plan: €6.99 a month for 3 devices.",
  alternates: { canonical: `${SITE_URL}/` },
};

const FEATURES = [
  {
    title: "Privacy by design",
    text: "We don’t track your activity. That’s a promise.",
    d: "M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z",
  },
  {
    title: "Simple to use",
    text: "Connect in one click. No complex settings.",
    d: "M13 3L5 13h6l-1 8 8-10h-6z",
  },
  {
    title: "Worldwide locations",
    text: "Pick where you connect. Access a more open internet.",
    d: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18",
  },
  {
    title: "Use on your devices",
    text: "Windows today, with more platforms in preparation.",
    d: "M4 6h12v9H4zM2 19h16M18 9h4v10h-4z",
  },
];

export default function Home() {
  return (
    <>
      <Nav />
      <main className="page">
        <section className="apps-hero">
          <div>
            <h1 className="page__title page__title--md">A simpler internet.</h1>
            <p className="page__lede">Private VPN access, without the clutter.</p>
            <p className="page__body">
              Arcana encrypts your connection, hides your IP address and helps you access a more open
              internet — on your terms. Fast, reliable and easy to use.
            </p>
            <p className="price">
              €6.99 <span className="price__unit">/ month</span>
            </p>
            <p className="price__note">3 devices included. Every location. One or two servers.</p>
            <HeroActions />
          </div>
          <Image
            className="hero-image"
            src="/images/hero-landing.webp"
            width={805}
            height={485}
            alt="The Arcana app connected, on a laptop and a phone"
            priority
          />
        </section>

        <ul className="principles">
          {FEATURES.map((f) => (
            <li key={f.title}>
              <span className="feature-list__icon feature-list__icon--lg" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d={f.d} />
                </svg>
              </span>
              <div>
                <h2>{f.title}</h2>
                <p className="muted">{f.text}</p>
              </div>
            </li>
          ))}
        </ul>

        <section className="statement">
          <div>
            <p className="eyebrow">Built for a more open internet</p>
            <h2 className="statement__title">More freedom. Greater privacy.</h2>
          </div>
          <p className="muted statement__text">
            Arcana gives you the tools to take back control of your online experience. Whether you’re at
            home or on the go, your connection stays private and secure.
          </p>
        </section>
      </main>
      <Footer />
    </>
  );
}
