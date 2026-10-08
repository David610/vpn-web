import Link from "next/link";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { PLAN_DEVICES, PLAN_PRICE_LABEL, SITE_NAME, SITE_URL, TWO_SERVER_LINKS } from "@/lib/site-config";

export const metadata = {
  description: `${SITE_NAME} pricing: one plan, ${PLAN_PRICE_LABEL} a month, with VPN links for compatible clients.`,
  alternates: { canonical: `${SITE_URL}/pricing/` },
};

const FEATURES = [
  "Create and manage VPN links",
  `Up to ${PLAN_DEVICES} devices`,
  TWO_SERVER_LINKS ? "1 or 2 servers" : "Fast single-server routing",
  "Automatic or manual locations",
];

const FAQ = [
  {
    q: "How do I connect?",
    a: "Create an account and subscribe, then create a VPN link in your account. Copy the link into a compatible third-party VPN client such as Hiddify, Shadowrocket or sing-box. No Arcana app is needed.",
  },
  {
    q: "Can I cancel anytime?",
    a: "Yes. Cancel from Account & plan whenever you like. Your links keep working until the end of the billing period you have already paid for.",
  },
];

function Check() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

export default function PricingPage() {
  return (
    <>
      <Nav />
      <main className="page page--center">
        <h1 className="page__title page__title--sm">Simple pricing.</h1>
        <p className="page__lede">One plan. VPN links for compatible clients.</p>

        <section className="plan-card" aria-labelledby="plan-name">
          <h2 id="plan-name" className="plan-card__name">
            {SITE_NAME}
          </h2>
          <p className="plan-card__price">
            {PLAN_PRICE_LABEL} <span className="plan__unit">/ month</span>
          </p>
          <ul className="plan-card__list">
            {FEATURES.map((f) => (
              <li key={f}>
                <Check />
                {f}
              </li>
            ))}
          </ul>
          <Link href="/signup" className="btn btn-primary btn-block btn-lg">
            Get {SITE_NAME}
          </Link>
        </section>

        <div className="faq">
          {FAQ.map((item) => (
            <details key={item.q}>
              <summary>
                {item.q}
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </summary>
              <p className="muted">{item.a}</p>
            </details>
          ))}
        </div>
      </main>
      <Footer />
    </>
  );
}
