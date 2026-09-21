import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { SITE_NAME, SITE_URL } from "@/lib/site-config";

export const metadata = {
  description: `Terms of service for ${SITE_NAME}.`,
  alternates: { canonical: `${SITE_URL}/terms/` },
};

export default function TermsPage() {
  return (
    <>
      <Nav />
      <main className="dm-section" style={{ borderBottom: "none" }}>
        <div className="section-head">
          <p className="section-eyebrow">Legal</p>
          <h1 className="section-h2">Terms of Service</h1>
          <p className="section-sub">
            The rules for using {SITE_NAME}.
          </p>
        </div>
        <div className="legal-content">
          <span className="legal-todo">
            TODO (legal review needed): this page is a structural draft, not
            a lawyer-reviewed terms of service. It needs sign-off before
            real customer signups begin.
          </span>

          <h2>The service</h2>
          <p>
            {SITE_NAME} provides a single monthly VPN subscription plan.
            There is no free trial and no one-time plans. Your subscription
            renews automatically each month until cancelled.
          </p>

          <h2>Personal use, one subscription per person</h2>
          <p>
            Your subscription is for your own personal use, on a couple of
            your own devices. It is not intended to be shared across
            multiple people or resold. We monitor for usage patterns
            inconsistent with this (see our{" "}
            <a href="/privacy/" className="text-link">
              Privacy Policy
            </a>{" "}
            for what we sample and why) and may flag an account for manual
            review, or disable it, if usage is clearly inconsistent with
            personal/couple-of-devices use. We do not do this automatically
            or in real time — flagged accounts are reviewed by a person
            before any action is taken.
          </p>

          <h2>Billing and cancellation</h2>
          <p>
            You may cancel your subscription at any time. Cancellation takes
            effect at the end of your current billing period — you keep
            access until then, and are not charged again afterward.
          </p>
          <span className="legal-todo">
            TODO (legal review needed, spec §9 prerequisite): German law
            (§312k BGB) requires a clearly labelled, easily accessible
            &quot;cancellation button&quot; for consumer contracts formed
            online, and §356a BGB governs the associated confirmation
            requirements. This needs a legal determination of whether
            Stripe&apos;s hosted Customer Portal (linked from the dashboard)
            satisfies this requirement on its own, or whether a custom
            in-app cancellation flow is required in addition. Do not treat
            the presence of a &quot;Manage billing&quot; link elsewhere in
            this app as having resolved this — it has not been confirmed
            compliant.
          </span>

          <h2>Right of withdrawal (EU consumers)</h2>
          <p>
            As an EU consumer, you generally have a 14-day right of
            withdrawal from a distance contract. Because {SITE_NAME} is a
            digital service that begins providing value immediately upon
            signup, you acknowledge that by starting to use the service you
            may be consenting to immediate performance, which can affect
            this right under §356(5) BGB.
          </p>
          <span className="legal-todo">
            TODO: the exact wording and consent-capture mechanism (a
            checkbox at signup, specific language) for this needs legal
            review — this paragraph is a placeholder describing the issue,
            not compliant consent-capture language.
          </span>

          <h2>Acceptable use</h2>
          <p>
            You may not use {SITE_NAME} for illegal activity, to attack or
            disrupt other networks, or in any way that would expose us or
            our infrastructure providers to legal liability.
          </p>

          <h2>Service availability</h2>
          <p>
            We aim for high availability but do not guarantee uninterrupted
            service. We may perform maintenance that temporarily affects
            connectivity.
          </p>

          <h2>Changes to these terms</h2>
          <p>
            We may update these terms from time to time. Material changes
            will be communicated to active subscribers.
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
