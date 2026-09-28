import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { SITE_NAME, SITE_URL } from "@/lib/site-config";

export const metadata = {
  description: `Privacy policy for ${SITE_NAME}.`,
  alternates: { canonical: `${SITE_URL}/privacy/` },
};

export default function PrivacyPage() {
  return (
    <>
      <Nav />
      <main className="dm-section" style={{ borderBottom: "none" }}>
        <div className="section-head">
          <p className="section-eyebrow">Legal</p>
          <h1 className="section-h2">Privacy Policy</h1>
          <p className="section-sub">
            What {SITE_NAME} collects, why, and how long it is kept.
          </p>
        </div>
        <div className="legal-content">
          <h2>Overview</h2>
          <p>
            {SITE_NAME} is a VPN service. We collect the minimum needed to
            operate the account and billing relationship, and we do not log
            or sell your browsing activity.
          </p>
          <span className="legal-todo">
            TODO (legal review needed): this page is a structural draft, not
            a lawyer-reviewed privacy policy. It needs sign-off before real
            customer signups begin, and updating whenever a new data
            processor (Stripe, Supabase, Resend, Cloudflare, the hosting
            provider) or data category is added.
          </span>

          <h2>Data we collect</h2>
          <ul>
            <li>
              <strong>Account data:</strong> email address and password hash
              (via Supabase Auth), used to sign you in.
            </li>
            <li>
              <strong>Billing data:</strong> handled by Stripe directly — we
              store only your Stripe customer/subscription IDs and
              subscription status, never your card details.
            </li>
            <li>
              <strong>VPN configuration:</strong> a subscription URL/config
              generated for your account, stored encrypted, used solely to
              deliver your VPN connection details.
            </li>
            <li>
              <strong>Device metadata:</strong> the name, platform, and last
              connection time of each device you register, so you can see
              and revoke them from your account dashboard.
            </li>
            <li>
              <strong>Connection records:</strong> for the managed VPN
              service, a per-device record of which route and server your
              device was assigned and when, used to operate and load-balance
              the network. This is routing metadata, not a browsing
              history — we do not log which sites or services you connect
              to.
            </li>
            <li>
              <strong>Telegram data:</strong> if you link a Telegram account
              to manage your VPN through our Telegram Mini App, we store
              your Telegram user ID and the link between it and your
              account.
            </li>
          </ul>

          <h2>What we do not do</h2>
          <ul>
            <li>We do not log your browsing activity, DNS queries, or the destinations you connect to through the VPN.</li>
            <li>We do not sell or share your data with advertisers.</li>
          </ul>

          <h2>Data processors</h2>
          <p>
            We use the following third-party processors to operate the
            service: Stripe (payments), Supabase (authentication and
            database), Cloudflare (hosting and the config-delivery API),
            Resend (operational email alerts), Hetzner (the VPS servers that
            run the VPN nodes your device connects to), and, if you choose
            to link your account, Telegram (the Mini App used to manage
            devices from Telegram). Each processes only the data necessary
            for its function.
          </p>

          <h2>Data retention</h2>
          <p>
            Account and billing data are retained for the duration of your
            subscription plus [retention period — TODO, confirm with legal;
            typically bounded by tax/accounting record-keeping requirements
            for billing data]. Connection records (which route/server a
            device used and when) are deleted after 30 days; raw per-node
            traffic samples are deleted after 7 days (daily totals are kept
            for capacity planning); short-lived Telegram linking codes are
            deleted shortly after they expire. You may request account
            deletion at any time by contacting us.
          </p>

          <h2>Your rights (GDPR)</h2>
          <p>
            If you are in the EU/EEA, you have the right to access, correct,
            delete, or export your personal data, and to object to or
            restrict certain processing. Contact us at [privacy contact
            email — TODO] to exercise these rights.
          </p>

          <h2>Contact</h2>
          <p>
            See our{" "}
            <a href="/impressum/" className="text-link">
              Impressum
            </a>{" "}
            for the responsible entity and contact details.
          </p>
        </div>
      </main>
      <Footer />
    </>
  );
}
