import Link from "next/link";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";

export default function NotFound() {
  return (
    <>
      <Nav />
      <main className="dm-section">
        <div className="dm-container">
          <p className="section-eyebrow">404</p>
          <h1 className="section-h2">Page not found</h1>
          <p className="section-sub">
            The page you&apos;re looking for doesn&apos;t exist.
          </p>
          <div style={{ marginTop: "var(--space-8)" }}>
            <Link href="/" className="btn btn-primary">
              Back home
            </Link>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
