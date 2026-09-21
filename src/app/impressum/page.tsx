import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { SITE_URL } from "@/lib/site-config";

export const metadata = {
  description: "Provider information (§5 DDG) for Arcana.",
  alternates: { canonical: `${SITE_URL}/impressum/` },
};

export default function ImpressumPage() {
  return (
    <>
      <Nav />
      <main className="dm-section" style={{ borderBottom: "none" }}>
        <div className="section-head">
          <p className="section-eyebrow">Legal</p>
          <h1 className="section-h2">Impressum</h1>
          <p className="section-sub">
            Provider information required under §5 of the German Digital
            Services Act (DDG, formerly TMG).
          </p>
        </div>
        <div className="legal-content">
          <h2>Provider</h2>
          <p>
            [Company or sole-proprietor legal name]
            <br />
            [Street address]
            <br />
            [Postal code, city, country]
          </p>
          <span className="legal-todo">
            TODO (real legal/business input needed): the operating entity&apos;s
            registered legal name and address. If operating as a sole
            proprietor rather than a registered company, German law still
            requires a real postal address here — a PO box alone does not
            satisfy §5 DDG.
          </span>

          <h2>Contact</h2>
          <p>
            Email: [contact email]
            <br />
            Phone: [contact phone, if required for your entity type]
          </p>

          <h2>Represented by</h2>
          <p>[Name of managing director / authorized representative]</p>

          <h2>Register entry</h2>
          <p>
            [Commercial register, registration number — if operating as a
            registered company (e.g. GmbH, UG)]
          </p>
          <span className="legal-todo">
            TODO: applicable only once a company entity exists (spec §9
            prerequisite — company/business entity + bank account for Stripe
            payouts). A sole proprietorship has no register entry to list.
          </span>

          <h2>VAT ID</h2>
          <p>[VAT identification number per §27a UStG, once registered]</p>
          <span className="legal-todo">
            TODO: depends on VAT/OSS registration for EU consumer sales
            (spec §9 prerequisite) — needs an accountant, not app code.
          </span>

          <h2>Responsible for content (§18(2) MStV)</h2>
          <p>[Name and address, if different from the provider above]</p>

          <h2>Dispute resolution</h2>
          <p>
            The European Commission provides a platform for online dispute
            resolution (ODR):{" "}
            <a
              href="https://ec.europa.eu/consumers/odr/"
              className="text-link"
              target="_blank"
              rel="noopener noreferrer"
            >
              https://ec.europa.eu/consumers/odr/
            </a>
            . We are [not / are — confirm with legal] willing or obliged to
            participate in dispute resolution proceedings before a consumer
            arbitration board.
          </p>
        </div>
      </main>
      <Footer />
    </>
  );
}
