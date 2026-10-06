"use client";

import { useMemo, useState } from "react";
import { HELP_CATEGORIES, HELP_ITEMS, type HelpCategory } from "@/lib/help-content";
import { SITE_NAME, SUPPORT_EMAIL } from "@/lib/site-config";

function CategoryIcon({ icon }: { icon: HelpCategory["icon"] }) {
  const common = { width: 24, height: 24, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (icon) {
    case "book":
      return (<svg {...common}><path d="M12 6C10 4.5 7 4 3 4v14c4 0 7 .5 9 2 2-1.5 5-2 9-2V4c-4 0-7 .5-9 2zM12 6v14" /></svg>);
    case "laptop":
      return (<svg {...common}><rect x="4" y="5" width="16" height="11" rx="1.5" /><path d="M2 19h20" /></svg>);
    case "globe":
      return (<svg {...common}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18" /></svg>);
    case "card":
      return (<svg {...common}><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M3 10h18" /></svg>);
    case "shield":
      return (<svg {...common}><path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6l7-3z" /><path d="M9 12l2 2 4-4" /></svg>);
    default:
      return (<svg {...common}><path d="M14.5 6.5a4 4 0 0 0-5 5L4 17l3 3 5.5-5.5a4 4 0 0 0 5-5l-2.5 2.5-2-.5-.5-2 2.5-2.5z" /></svg>);
  }
}

export default function HelpCenter() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState(HELP_CATEGORIES[0].id);
  const [openQuestion, setOpenQuestion] = useState<string | null>(null);

  const q = query.trim().toLowerCase();
  const items = useMemo(() => {
    if (q) {
      return HELP_ITEMS.filter((i) =>
        [i.question, i.summary, ...i.answer].some((t) => t.toLowerCase().includes(q)),
      );
    }
    return HELP_ITEMS.filter((i) => i.category === category);
  }, [q, category]);
  const active = HELP_CATEGORIES.find((c) => c.id === category)!;

  return (
    <>
      <label className="searchbar searchbar--lg">
        <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
          <circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M14 14l4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <input
          type="search"
          placeholder="Search for help articles…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search for help articles"
        />
      </label>

      <div className="help-layout">
        <nav className="help-nav" aria-label="Help topics">
          {HELP_CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`help-nav__item${!q && c.id === category ? " help-nav__item--active" : ""}`}
              aria-current={!q && c.id === category ? "true" : undefined}
              onClick={() => {
                setQuery("");
                setCategory(c.id);
                setOpenQuestion(null);
              }}
            >
              <CategoryIcon icon={c.icon} />
              {c.label}
            </button>
          ))}
        </nav>

        <section className="help-list" aria-live="polite">
          <p className="eyebrow">{q ? "Search results" : active.label}</p>
          <h2 className="help-list__title">{q ? `${items.length} ${items.length === 1 ? "result" : "results"}` : "Popular questions"}</h2>
          {items.length === 0 ? (
            <p className="muted">No articles match “{query.trim()}”. Try different words, or contact support below.</p>
          ) : (
            <ul>
              {items.map((i) => {
                const open = openQuestion === i.question;
                return (
                  <li key={i.question} className="faq">
                    <button
                      type="button"
                      className="faq__head"
                      aria-expanded={open}
                      onClick={() => setOpenQuestion(open ? null : i.question)}
                    >
                      <span>
                        <span className="faq__q">{i.question}</span>
                        <span className="faq__s">{i.summary}</span>
                      </span>
                      <svg className={`faq__chev${open ? " faq__chev--open" : ""}`} viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
                        <path d="M7 4l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                    {open ? (
                      <div className="faq__body">
                        {i.answer.map((p) => (
                          <p key={p}>{p}</p>
                        ))}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <section className="support-band">
        <span className="support-band__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
            <path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-4 4v-4H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" />
          </svg>
        </span>
        <div className="support-band__text">
          <h2>Still need help?</h2>
          <p>Our support team is here to help. Get in touch and we’ll get back to you as soon as possible.</p>
        </div>
        <a className="btn btn-primary" href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`${SITE_NAME} support`)}`}>
          Contact support
        </a>
      </section>
    </>
  );
}
