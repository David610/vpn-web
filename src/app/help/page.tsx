import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import HelpCenter from "@/components/HelpCenter";
import { SITE_NAME, SITE_URL } from "@/lib/site-config";

export const metadata = {
  title: `Help — ${SITE_NAME}`,
  description: `Find answers and get support for ${SITE_NAME}.`,
  alternates: { canonical: `${SITE_URL}/help/` },
};

export default function HelpPage() {
  return (
    <>
      <Nav />
      <main className="page">
        <h1 className="page__title">Help</h1>
        <p className="page__lede">Find answers and get support.</p>
        <HelpCenter />
      </main>
      <Footer />
    </>
  );
}
