import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import HeroActions from "@/components/HeroActions";
import { PLAN_PRICE_LABEL, SITE_URL } from "@/lib/site-config";

export const metadata = {
  description: `Arcana is private VPN access through secure links for compatible third-party VPN clients. One plan: ${PLAN_PRICE_LABEL} a month.`,
  alternates: { canonical: `${SITE_URL}/` },
};

const STEPS = [
  {
    title: "Create your account",
    text: "Sign up in a few seconds.",
    d: "M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4.5 20c.8-3.6 3.8-5.5 7.5-5.5s6.7 1.9 7.5 5.5",
  },
  {
    title: "Configure your VPN link",
    text: "Choose a location and other settings.",
    d: "M4 8h9M17 8h3M4 16h3M11 16h9M15 5v6M9 13v6",
  },
  {
    title: "Copy to a compatible VPN client",
    text: "Use the link in your preferred VPN client.",
    d: "M9 9h10v11H9zM5 15V4h10",
  },
];

export default function Home() {
  return (
    <>
      <Nav />
      <main className="page hero-split">
        <section className="hero-split__intro">
          <h1 className="page__title">A simpler internet.</h1>
          <p className="page__lede hero-split__lede">
            Private VPN access through secure links. Use Arcana with compatible third-party VPN clients.
          </p>
          <p className="price">
            {PLAN_PRICE_LABEL} <span className="price__unit">/ month</span>
            <span className="price__sep" aria-hidden="true">
              ·
            </span>
            <span className="price__unit">One plan</span>
          </p>
          <HeroActions />
        </section>
        <ol className="steps" id="how-it-works" aria-label="How it works">
          {STEPS.map((s, i) => (
            <li key={s.title}>
              <span className="steps__n" aria-hidden="true">
                {i + 1}
              </span>
              <svg
                className="steps__icon"
                viewBox="0 0 24 24"
                width="32"
                height="32"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d={s.d} />
              </svg>
              <div>
                <h2>{s.title}</h2>
                <p className="muted">{s.text}</p>
              </div>
            </li>
          ))}
        </ol>
      </main>
      <Footer />
    </>
  );
}
