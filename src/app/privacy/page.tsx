import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { SITE_NAME, SITE_URL, TWO_SERVER_LINKS } from "@/lib/site-config";

export const metadata = {
  title: `Privacy — ${SITE_NAME}`,
  description: `How ${SITE_NAME} protects your privacy: what we collect, what we never do, and the limits of any VPN.`,
  alternates: { canonical: `${SITE_URL}/privacy/` },
};

const PRINCIPLES = [
  {
    title: "No activity logs",
    text: "We do not track, store or share your browsing activity, DNS queries or the apps you use.",
    d: "M7 3h7l4 4v14H7zM14 3v4h4",
  },
  {
    title: "Minimal account information",
    text: "You only need an email address to get started. We don’t ask for your name, address or payment details beyond what’s required to process your subscription.",
    d: "M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4.5 20c.8-3.6 3.8-5.5 7.5-5.5s6.7 1.9 7.5 5.5",
  },
  {
    title: "No trackers on this site",
    text: "We don’t use advertising trackers or third-party analytics on this website.",
    d: "M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6l7-3z",
  },
  {
    title: "Transparent infrastructure",
    text: "Your links use connection credentials that are kept separate from your account identity, and we explain how the service works.",
    d: "M5 5h14v5H5zM5 14h14v5H5zM8 7.5h.01M8 16.5h.01",
  },
];

const DOES = [
  "Encrypts your internet connection, keeping your data private on public networks and from your ISP.",
  "Hides your IP address from the sites and services you visit.",
  TWO_SERVER_LINKS
    ? "Lets you choose where you connect, with one server or two."
    : "Lets you choose where you connect.",
  "Gives each VPN link its own connection credentials, so you can revoke one without affecting the others.",
];

const DOES_NOT = [
  "It does not make you anonymous. Websites and online services can still identify you through your account, cookies or other data.",
  "It does not protect you from malware, phishing or unsafe websites. You still need good security habits and up-to-date software.",
  "It does not change the content of websites or services, or guarantee access to every platform.",
  "It does not replace a secure browser, password manager or other privacy tools, but it works well alongside them.",
];

function Check({ kind }: { kind: "yes" | "no" }) {
  return (
    <svg className="mark" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      {kind === "yes" ? <path d="M8.5 12.5l2.5 2.5 4.5-5" /> : <path d="M9 9l6 6M15 9l-6 6" />}
    </svg>
  );
}

export default function PrivacyPage() {
  return (
    <>
      <Nav />
      <main className="page">
        <section>
          <p className="eyebrow">Our privacy principles</p>
          <h1 className="page__title">Privacy</h1>
          <p className="page__lede">Your connection. Your business.</p>
          <p className="page__body">
            {SITE_NAME} is built around a simple idea: you should be in control of your online life. We
            design our service to protect your privacy, minimize the data we collect, and be transparent
            about how it all works.
          </p>
        </section>

        <ul className="principles">
          {PRINCIPLES.map((p) => (
            <li key={p.title}>
              <span className="feature-list__icon feature-list__icon--lg" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d={p.d} />
                </svg>
              </span>
              <div>
                <h2>{p.title}</h2>
                <p className="muted">{p.text}</p>
              </div>
            </li>
          ))}
        </ul>

        <div className="two-col">
          <section>
            <p className="eyebrow">What {SITE_NAME} does</p>
            <h2 className="two-col__title">A more private and open internet.</h2>
            <p className="muted two-col__sub">{SITE_NAME} helps you take back control of your online experience.</p>
            <ul className="marks">
              {DOES.map((t) => (
                <li key={t}>
                  <Check kind="yes" />
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          </section>
          <section>
            <p className="eyebrow">What a VPN does not do</p>
            <h2 className="two-col__title">A VPN isn’t a complete solution.</h2>
            <p className="muted two-col__sub">It’s important to understand the limits of any VPN service.</p>
            <ul className="marks">
              {DOES_NOT.map((t) => (
                <li key={t}>
                  <Check kind="no" />
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <p className="fineprint">
          We do keep some account and service data, such as your email address, your devices and when each
          last connected. The <a className="text-link" href="/privacy/policy/">privacy policy</a> lists exactly
          what we keep and for how long.
        </p>
      </main>
      <Footer />
    </>
  );
}
