import { SITE_NAME } from "@/lib/site-config";

// Illustration of the app window, not a screenshot: the location shown is sample data.
export default function AppMock() {
  return (
    <div className="mock" role="img" aria-label={`The ${SITE_NAME} app showing a protected connection`}>
      <div className="mock__screen">
        <div className="mock__win">
          <aside className="mock__side">
            <strong>{SITE_NAME}</strong>
            <span className="mock__nav mock__nav--on">Home</span>
            <span className="mock__nav">Locations</span>
            <span className="mock__nav">Settings</span>
          </aside>
          <div className="mock__main">
            <span className="mock__ring">
              <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M12 3v8M6.3 6.8a8 8 0 1 0 11.4 0" />
              </svg>
            </span>
            <strong>Connected</strong>
            <span className="mock__muted">Your connection is private</span>
            <div className="mock__loc">
              <span>Germany</span>
              <span className="mock__muted">Frankfurt</span>
            </div>
          </div>
        </div>
      </div>
      <div className="mock__base" />
    </div>
  );
}
