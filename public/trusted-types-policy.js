(function () {
  if (typeof window === "undefined" || !window.trustedTypes || !window.trustedTypes.createPolicy) {
    return;
  }
  // F-15 (Trusted Types half): registered as the 'default' policy so every
  // DOM-XSS-sink assignment this app's own runtime makes (Next.js's own
  // hydration/script-loading machinery, next/script's <script>.src writes
  // for the Telegram Mini App bootstrap in src/app/telegram/layout.tsx) is
  // routed through here instead of throwing under
  // `require-trusted-types-for 'script'` enforcement (see public/_headers).
  //
  // This app has no innerHTML/outerHTML/document.write/eval call sites of
  // its own (re-verified for this remediation round across src/ and
  // functions/) -- there is nothing here that legitimately needs to inject
  // untrusted HTML or script text. So this policy is a pass-through, not a
  // sanitizer: the actual security control is the CSP script-src allowlist
  // ('self' plus https://telegram.org on /telegram only, no
  // 'unsafe-inline'/'unsafe-eval' anywhere), which already constrains what
  // origins/URLs can reach these sinks in the first place. Trusted Types on
  // top of that closes the remaining sinks CSP script-src does not cover on
  // its own (eval/Function-string, document.write, Range
  // .createContextualFragment) and gives the browser a hard failure instead
  // of silent execution if some future dependency tries to assign a string
  // built from user input directly into one of these sinks.
  //
  // Do NOT turn this into an HTML sanitizer by making createHTML do
  // anything other than pass the string through -- a real sanitizer belongs
  // at the point where untrusted content is rendered, with a dedicated
  // library and its own review, not smuggled into this policy.
  try {
    window.trustedTypes.createPolicy("default", {
      createHTML: (s) => s,
      createScript: (s) => s,
      createScriptURL: (s) => s,
    });
  } catch (e) {
    // A 'default' policy can only be created once per document. If
    // something else already registered it, do nothing rather than throw
    // and break page load.
  }
})();
