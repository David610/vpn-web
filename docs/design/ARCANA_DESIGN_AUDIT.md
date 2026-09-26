# Arcana Design Audit

Audit date: 2026-09-27

Repositories reviewed:
- David610/tamara-next at main 7032b401d4
- David610/vpn-web at main 9475308bb2

Design references used:
- the Arcana UI Implementation Package from this design conversation
- PRODUCT_UI_SPEC.md
- VISUAL_MANIFEST.md
- the five canonical app boards
- the four canonical website/admin boards

## Executive Summary

The current Arcana redesign is real and mostly moving in the right direction. The managed Flutter client has a coherent consumer information architecture, a restrained monochrome component system, strong connection-state handling, and unusually explicit fail-closed behavior for a VPN client. The customer-facing web account area has also moved away from generic SaaS card grids toward a ruled editorial layout that fits Arcana.

The next step should not be another redesign.

The weaknesses are concentrated at the edges:

1. the public website is much more text-dense than the final sparse reference, especially on phones;
2. the mobile web account navigation is a wrapped seven-link desktop menu rather than a deliberate mobile pattern;
3. important account actions still use browser-native prompt/confirm dialogs;
4. the web and app disagree on customer-facing 2-server configuration: the app keeps entry Automatic, while the web exposes a selectable entry location;
5. the Flutter desktop experience is still a phone shell stretched onto a desktop window;
6. terminology drifts between Route, Connections and Configurations, and one app screen explains short-lived credentials to ordinary users;
7. the admin frontend still uses a separate generic Tailwind dashboard visual language;
8. legal/support production surfaces still contain explicit placeholders or draft notices.

There are no verified P0 visual usability defects in the daily Connect flow. The genuine production blocker found in source is legal/public trust readiness: Terms and Privacy explicitly call themselves drafts requiring legal review, Impressum contains placeholder legal entity/address content, and the help page still exposes support@arcana.example.

A separate deployment gate is to verify that ARCANA_WEBSITE_ORIGIN is set in release builds because the application code defaults to https://arcana.example.

## Audit Method

The audit did not rely on previous agents' statements.

Website:
- real Chromium rendering through the repository visual/a11y harness;
- public home, login and signup added to an audit-only branch;
- rendered at 360, 375, 390, 430, 768, 1024 and 1440 px;
- major account and admin/fleet pages also rendered;
- current visual-check automation reported no horizontal overflow, missing accessible name on checked icon-only controls, sub-24px checked targets, console errors or complete keyboard-focus failure.

Flutter:
- current main CI verified;
- flutter analyze: no issues;
- flutter test: 209 tests passed;
- CI uses the repository-pinned Flutter 3.38.5;
- managed-flow widget tests exercise real TamaraApp flows at phone width, including login, setup, connection, 2-server availability, saved configurations, subscriptions, device packs and deletion;
- an audit-only screenshot harness was added on a separate branch to inspect current phone and desktop rendering without changing production UI.

Limitation:
A physical/native application runtime could not be inspected because the connected machine was offline during this audit. Native compositor details and OS dialogs therefore remain an explicit limitation. Test-font artifacts are not treated as real UI bugs unless reproduced in a native build.

## Design Direction

The implementation is trying to be:
- monochrome;
- editorial and technical rather than decorative;
- based on thin rules instead of shadows;
- low in icon density;
- compact but not cramped;
- explicit about state and failure;
- simple in customer terminology;
- technically deep only behind advanced/admin surfaces.

That direction is correct.

The implementation contradicts it mainly in:
- marketing content density;
- mobile account navigation;
- browser-native account dialogs;
- admin visual primitives;
- cross-surface 2-server semantics;
- inconsistent customer terminology.

## Current Design System

### Flutter

Primary source: lib/presentation/theme/arcana_theme.dart.

Colors:
- primary ink #0A0A0A
- secondary ink #5F5F5A
- tertiary ink #8A8A84
- paper #FFFFFF
- panel #F5F5F3
- ring #F0F0EE
- rule #E6E6E3
- danger #B91C1C

Assessment: GOOD.
This is a small semantic palette. Danger red is an appropriate semantic exception to monochrome branding.

Typography:
- wordmark 20 / 700
- display 34 / 700
- title 24 / 600
- heading 17 / 600
- body 15
- secondary 14
- caption/meta 12
- monospace only for meta

Assessment: GOOD.
The hierarchy is compact and product-like. It does not rely on oversized marketing type inside the app.

Spacing:
ArcanaSpace explicitly defines gutter 24, radius 8, group radius 10 and max content width 520. Screens still use many direct 6/8/12/16/24/28 values.

Assessment: MOSTLY GOOD, WITH DEBT.
The rendered rhythm is fairly consistent, but spacing is less systematically tokenized than color/type. A small 4/8/12/16/24/32/48 scale would improve maintainability without creating a large design-system abstraction.

Shared widgets:
- ArcanaPage
- ArcanaGroup
- ArcanaRow
- ArcanaNotice
- ArcanaStatusLine
- ArcanaConnectButton
- ArcanaRadioDot
- ArcanaBottomNav
- confirmation/message helpers

Assessment: GOOD.
The app has actual shared visual primitives rather than independent styling per screen.

### Website customer/public

Primary source: src/app/globals.css.

The CSS token layer is coherent:
- white/off-white/panel surfaces;
- black primary ink;
- muted neutrals;
- black accent;
- red danger;
- 6/8/12 radii;
- 4px-based spacing;
- system sans and mono;
- focus-visible styles;
- reduced motion;
- increased-contrast handling.

The account product UI uses:
- ruled side navigation;
- stats separated by rules;
- row lists;
- block headings;
- restrained notices;
- small text actions.

Assessment: GOOD.
This is substantially closer to the desired Arcana language than the earlier card-heavy dashboard.

### Website admin

The admin UI remains a separate direct-Tailwind system with patterns such as:
- bg-gray-50
- rounded border bg-white p-4
- rounded/shadowed auth containers
- repeated text-gray classes
- metric cards
- one-off form/button styling

Assessment: WEAK BUT NOT A CUSTOMER BLOCKER.
Admin should remain dense and technical, but the semantic colors, borders, fields, buttons and metric layout should eventually reuse Arcana primitives.

## What Is Working

### 1. Connect / Locations / Account is the right primary IA

Implementation:
Managed TamaraShell exposes Connect, Locations and Account; Settings is nested under Account; Custom servers sits under Settings -> Advanced.

Assessment: GOOD.

Why:
These are the three recurring user jobs:
- use the VPN;
- choose where traffic exits;
- manage the account/device.

This structure should stay.

### 2. The Connect screen answers the four essential questions

The current screen clearly communicates:
- Protected / Not connected / Connecting / Reconnecting / Updating / Internet blocked;
- selected/current location or route;
- one dominant Connect/Disconnect control;
- explicit notices when a subscription, network or route is unavailable.

Assessment: GOOD.

The state is communicated in text as well as dots/color. This is important accessibility and VPN trust behavior.

### 3. Fail-closed 2-server behavior is unusually well represented

ManagedConnectionService keeps the requested mode. A 2-server request never silently turns into 1 server. No-route text explicitly explains that Arcana did not switch modes.

Assessment: VERY GOOD.

This is both technically correct and understandable.

### 4. Locations does not fake metrics

Current Locations puts Automatic first and lists valid regions for the selected connection type. It intentionally does not display fake latency or load data.

Assessment: GOOD.

Do not add latency until it is measured reliably.

### 5. Account -> Settings -> Advanced -> Custom servers is sensible

Assessment: GOOD.

Custom/self-hosted server configuration is a specialist workflow. The current depth communicates that it is optional without hiding it completely. Do not flatten this just to reduce taps.

### 6. Customer web account layout is strong

Rendered mobile/desktop account pages show clear section hierarchy, ruled rows, visible device/subscription counts and limited chrome.

Assessment: GOOD.

The content architecture is stronger than the mobile navigation around it.

### 7. Diagnostics respects the privacy model

The app diagnostic report explicitly allowlists coarse app/service/OS/capability state and excludes domains, DNS queries, IP addresses, credentials, provisioning URLs, config and packet data.

Assessment: VERY GOOD.

Nothing should be changed here merely for visual polish.

## What Is Not Working

### P0 — Legal/public trust content is not production-ready
Difficulty: external + S code

Screens/files:
- src/app/terms/page.tsx
- src/app/privacy/page.tsx
- src/app/impressum/page.tsx
- src/app/account/help/page.tsx

Problem:
Terms and Privacy explicitly say they are structural drafts requiring legal review. Impressum contains placeholder legal entity/address data. Help uses support@arcana.example.

Why it matters:
A paid German consumer product cannot present placeholder/draft legal identity and claim production readiness.

Fix:
Complete legal review and real entity/contact data. Centralize support identity. Add a release check that prevents production deployment with placeholder domain/support data.

### P1 — Mobile account navigation is compressed desktop navigation
Difficulty: M

Evidence:
At 375px the account page shows Overview, Subscriptions, Devices, Connections, Billing, Security and Help wrapped into two lines.

File:
src/components/account/AccountShell.tsx and related CSS.

Problem:
The current breakpoint removes the desktop sidebar but simply wraps all seven links.

Why it matters:
It creates a visually dominant block before every page heading and does not scale if another account section is added.

Fix:
Use a deliberate mobile account navigator: a compact current-section control/disclosure plus Account overview/back path, or a dedicated Account index. Keep the desktop sidebar at wider widths.

### P1 — Web account actions use browser-native prompt/confirm
Difficulty: M

Examples:
src/app/account/connections/page.tsx uses window.prompt for rename and window.confirm for deletion. Similar patterns exist in account management.

Why it matters:
Browser-native dialogs break Arcana visual consistency, provide weak validation/error context and behave differently across platforms. The Flutter app already has a coherent confirmation interaction.

Fix:
Create one small shared web dialog/form primitive for rename, delete, cancel and other account actions. Do not add a modal library.

### P1 — App and web disagree on 2-server customer semantics
Difficulty: M

App:
2 servers = entry Automatic, exit user-selectable.

Web:
Connections page exposes preferredEntryLocationId and preferredExitLocationId and can show Sweden -> Germany.

Why it matters:
A customer can configure a policy on the web that the native app cannot express/edit consistently. This is not just wording; it is a product-model mismatch.

Fix:
For the current customer product, standardize on Automatic entry + Automatic/selectable exit. Keep manual entry selection admin/advanced until the client and signed route contract intentionally expose it everywhere.

### P1 — Flutter desktop uses a phone shell
Difficulty: M

Files:
- lib/presentation/shell/tamara_shell.dart
- lib/presentation/widgets/arcana_widgets.dart

Problem:
The same 64px bottom navigation and max 520px content column are used at large desktop widths.

Why it matters:
The content width is fine for readability, but bottom mobile navigation on a desktop window makes the app feel like a phone emulator.

Fix:
At a large breakpoint around 800px, move primary navigation to a compact left rail/sidebar while keeping the actual page column narrow. Do not convert the app into a dashboard.

### P1 — Public landing page is too dense for the approved direction
Difficulty: M

Rendered 375px page:
- hero;
- four feature essays;
- Locations;
- pricing explanation;
- 3/6/9 table;
- three-step getting-started section;
- footer.

Problem:
It is responsive but long and information-heavy. This contradicts the final “much much less text” direction.

Why it matters:
Minimalism is not achieved by only removing color. The current mobile site reads like compressed documentation.

Fix:
Keep the useful live Locations and transparent Pricing. Collapse or remove duplicated feature/getting-started copy. The hero should carry the product promise and one primary action; one compact proof/explanation block is enough.

Do not add decorative maps or illustrations simply to imitate the reference board.

### P1 — Customer terminology is not fully disciplined
Difficulty: S

Examples:
- app Connect row title “Route”;
- web “Connections” vs app “Saved configurations”;
- TwoServerScreen explains that each server gets its own short-lived credential.

Problem:
Arcana otherwise hides infrastructure concepts well, but these terms leak technical implementation or blur runtime connection vs saved policy.

Fix:
Use “Configuration” for saved routing choices. Reserve “Connection” for current runtime state. In normal customer UI use “2-server setup” / “Exit location” instead of “Route.” Move credential details into privacy/technical details if they need to exist at all.

### P2 — Authentication pages feel more generic than the rest of Arcana
Difficulty: S

Evidence:
Rendered login/signup pages use a conventional rounded card container.

Why it matters:
Usable, but visually they look closer to a generic SaaS auth template than the ruled/editorial account system.

Fix:
Use a narrow open form with a strong heading and a single rule/container boundary rather than a self-contained card.

### P2 — Diagnostics appears twice
Difficulty: S

Files:
Settings and Advanced.

Problem:
Diagnostics is visible as a normal Settings item and again inside Advanced.

Fix:
Keep it in Settings and remove the duplicate from Advanced. Advanced should contain Custom servers and reset/technical controls.

### P2 — Locations needs a scaling plan, not more features now
Difficulty: future M

Current flat list is correct for a small fleet.

Structural decision:
- keep Automatic first;
- group country -> city only once multiple cities per country exist;
- add search only when the visible list becomes materially long (roughly 15–20+ locations);
- add latency only when measured;
- do not expose node IDs/capacity to ordinary users;
- do not add favorites until repeated-location behavior shows a real need.

### P2 — Admin visual system is still generic
Difficulty: M

Files:
- src/components/admin/AdminShell.tsx
- AdminNav
- MetricCard
- fleet/admin pages

Problem:
The admin UI uses card/dashboard/Tailwind patterns that visually diverge from the customer product.

Fix:
Do not simplify technical language. Instead reuse Arcana semantic tokens for background, border, danger, focus, form controls, tables and metric cells. Replace only repeated generic dashboard primitives.

### P2 — Flutter spacing values are only partially tokenized
Difficulty: S/M

Problem:
Color/type are centralized, spacing is not.

Fix:
Add a small shared spacing scale and migrate repeated values when touching related screens. Do not create a full theme-extension framework for a small UI.

### P2 — The circular Connect control is functionally strong but visually generic
Difficulty: S/M

Problem:
216px circular Connect inside a ring is recognizable but also the standard VPN-product motif and dominates vertical space.

Why it is not P1:
It clearly communicates the main action and current design references also used it.

Fix:
Do not replace it now. In polish, test a slightly smaller/less decorative circle or more typographic treatment while preserving one unmistakable main action.

## Visual Hierarchy by Major Screen

### Connect

First noticed:
status + large Connect/Disconnect control.

Correct?
Yes. This is the correct priority.

Secondary:
connection type, selected location/2-server setup, saved configuration.

Assessment:
Good. The only issue is that the circle is visually dominant enough to feel generic; it does not create usability confusion.

### Locations

First noticed:
Automatic and region list.

Correct?
Yes.

Recommendation:
No map, node metrics or load bars. Keep this simple.

### Account

First noticed:
account identity/subscriptions and device management.

Correct?
Yes.

Issue:
The web mobile account navigation visually precedes and competes with the page title.

### Subscription

Current app/web interaction exposes:
- price;
- device capacity;
- devices used;
- +3 packs;
- cancellation.

Assessment:
Good product transparency.

Do not rename devices to seats in customer copy.

### Settings

Current grouping is conceptually good:
- connection behavior;
- privacy/network behavior;
- notifications/startup;
- default config;
- diagnostics;
- advanced.

Kill switch status is read-only when it is a platform/security guarantee rather than a casual toggle. That is correct.

## Information Architecture

### Keep

App:
Connect
- state
- connect/disconnect
- 1/2 servers
- location/2-server setup
- saved configuration
- connection details

Locations
- Automatic
- available customer locations

Account
- subscriptions
- devices
- settings
- help
- logout/delete

Settings
- auto-connect
- local network access where supported
- notifications
- launch/connect on startup
- kill switch status
- default configuration
- diagnostics
- Advanced

Advanced
- Custom servers
- Reset settings

### Web account

Desktop:
- Overview
- Subscriptions
- Devices
- Configurations
- Billing
- Security
- Help

Mobile:
Do not show all seven as a wrapping strip. Use a compact account-section navigator or Account index.

### Admin

Technical terms such as node, relay, exit, lifecycle, revision, canary, drain and failure domain are appropriate here. Do not “consumerize” them.

## Connection Experience

Verified state model:
- signed out
- checking subscription
- loading routes
- ready
- connecting
- connected
- recovering
- subscription inactive
- control plane unavailable
- no route
- blocked residual protection at VPN layer

Strengths:
- state text is explicit;
- controls lock while connection-changing operations are active;
- choices cannot change underneath a live connection;
- Automatic never changes requested mode;
- 2-server does not silently degrade;
- blocked internet recovery exposes both Connect and Restore Internet.

Potential improvement:
“Updating…” covers route loading and entitlement checking. That is acceptable because both are short-lived internal preparation states; no need to expose more technical wording.

## Locations Audit

Current implementation is correctly conservative.

Expose now:
- location name;
- selected state;
- Automatic;
- availability through presence/absence.

Do not expose now:
- node IDs;
- ASN;
- protocol;
- server ports;
- capacity;
- synthetic load percentage;
- fake latency.

Future:
Search and grouping should be introduced only when fleet scale makes the flat list slow to scan.

## Account / Settings Audit

Account is not currently a dumping ground.

The current depth of Custom servers is intentional and good:
Account -> Settings -> Advanced -> Custom servers.

Do not optimize it toward fewer taps. It is a specialist workflow.

Fix only:
- duplicate Diagnostics;
- wording consistency;
- desktop shell adaptation.

## Subscription UX Audit

Commercial model presented to users is coherent:
- €6.99/month;
- 3 devices;
- +3 devices for +€6.99;
- multiple subscriptions represented in account views.

Current major design issue is not the pricing interaction; it is consistency of language and custom dialog behavior on web.

Pricing table 3/6/9 is useful and transparent. It can remain even if the landing page is shortened.

Do not alter a special 10-device business rule during a design pass if it exists elsewhere; business logic must remain separate from UI cleanup.

## Website Audit

### Landing
GOOD:
- monochrome;
- strong hero;
- real price immediately visible;
- real live Locations section;
- no protocol marketing;
- no blue;
- no decorative stock illustration.

WEAK:
- too much copy, especially phone;
- feature explanations overlap with pricing/getting-started information;
- the long page undermines the final sparse direction.

### Login / signup
Usable and responsive, but generic card framing. P2.

### Account dashboard
Strong editorial product UI. Keep the ruled lists/stats.

Main issue: mobile nav.

### Billing / subscriptions / devices
Clear and functional. Replace browser-native dialogs and keep device terminology.

### Admin
Dense information is appropriate. Visual primitives need later unification, not feature simplification.

## App ↔ Website Consistency

Intentional/acceptable differences:
A. web account uses a desktop sidebar; app uses primary product tabs.
A. admin exposes node/relay/lifecycle details; consumer app does not.
A. web has wider data tables; app stays task-focused.

Inconsistencies to correct:
B. app “Configurations” vs web “Connections.”
B. app Automatic entry vs web selectable entry.
B. app Arcana confirmation flows vs web browser prompt/confirm.
B. app desktop phone-style bottom nav vs web responsive desktop shell.
B. admin semantic styling diverges strongly from Arcana.

## Accessibility

Verified positives:
- website global focus-visible treatment;
- reduced-motion CSS;
- increased-contrast adjustments;
- semantic labels on web forms;
- ArcanaStatusLine is a live semantic status;
- Flutter bottom navigation exposes selected/button semantics;
- connection state does not rely on color alone;
- major Flutter buttons meet comfortable touch size;
- web audit found no checked sub-24px button/link targets at phone widths.

Issues / follow-up:
- browser-native prompt/confirm prevents Arcana-controlled validation/error semantics;
- add large-text stress tests to Flutter;
- add screen-reader flow tests around connect status, destructive confirmation and subscription pack changes;
- admin horizontally scrollable tables are acceptable but need visible/keyboard usable overflow in real browsers.

No claim of blanket “WCAG compliance” is made.

## Responsive Audit

Website widths rendered:
360 / 375 / 390 / 430 / 768 / 1024 / 1440.

No horizontal overflow was found by the harness.

Real design issue:
mobile account nav wraps instead of adapting.

Flutter:
phone layout is well constrained around a 520px max column.
Desktop uses the same bottom navigation and therefore needs adaptive navigation, not a wider dashboard.

## Real Content Stress Plan

Existing domain limits allow names up to 80 characters, so add screenshot tests with:
- United Arab Emirates;
- United States;
- long email address;
- 70–80 character subscription name;
- many devices;
- 15–25 locations;
- unavailable 2-server mode;
- past-due subscription;
- several subscriptions.

Test first. Only change layout where real failure is observed.

## Interaction Consistency

Shared patterns that are already good:
- Flutter ArcanaRow;
- ArcanaGroup;
- ArcanaNotice;
- ArcanaRadioDot;
- confirmArcanaAction;
- web row/block/stats structures.

Pattern that must become shared on web:
- modal/form/confirmation for rename/delete/cancel.

Do not add a component abstraction for every margin or one-off admin cell.

## Generic AI/SaaS Pattern Audit

Successfully avoided in customer UI:
- gradients;
- glassmorphism;
- glowing buttons;
- decorative blobs;
- fake statistics;
- illustration-heavy feature cards;
- giant colorful CTAs;
- nested customer card grids.

Still present:
- generic auth card framing;
- generic admin metric cards;
- conventional large circular VPN button.

Only the first two are clear generic-template remnants. The Connect circle is a category convention that currently solves a real hierarchy problem.

## Design System / Code Quality

Keep the current small design system.

Extract only:
- a small Flutter spacing scale;
- one web dialog/form primitive;
- a small set of admin semantic primitives;
- a written vocabulary table.

Do not:
- introduce a large UI library;
- rewrite all Tailwind;
- create dozens of theme extensions;
- make Flutter and web pixel-identical.

## Production Blockers

Verified P0:
- Terms draft;
- Privacy draft;
- Impressum placeholder entity/address;
- placeholder support identity.

Release gates requiring environment verification:
- ARCANA_WEBSITE_ORIGIN must not be arcana.example;
- support email must be real;
- canonical web domain must be set;
- legal entity must match actual operator.

Not production blockers:
- auth card styling;
- admin visual unification;
- Connect-circle distinctiveness;
- future Locations search/favorites;
- exact gray/radius parity between Flutter and web.

## Recommended Changes

### Phase 1 — Must fix before production

1. Complete legal/privacy/impressum/support identity.
2. Add a release guard against placeholder domain/support values.
3. Replace wrapped mobile account navigation.
4. Replace window.prompt/window.confirm account actions.
5. Align 2-server customer semantics: Automatic entry, selectable/Automatic exit.
6. Standardize customer terminology around Configuration and remove Route/credential copy from normal UI.
7. Add desktop-adaptive Flutter navigation while retaining the narrow content column.
8. Reduce public landing-page text and duplicated sections.

### Phase 2 — Should fix

1. Remove duplicate Diagnostics from Advanced.
2. Simplify login/signup card framing.
3. Consolidate repeated Flutter spacing values.
4. Move admin buttons/fields/borders/metrics onto Arcana semantic tokens.
5. Add content-stress screenshot tests.
6. Add large-text and screen-reader-focused Flutter tests.
7. Document shared app/web vocabulary.

### Phase 3 — Polish

1. Re-evaluate the outer ring/size of the circular Connect control.
2. Align tertiary gray/radius values where useful.
3. Add Locations search/grouping only when real fleet scale requires it.
4. Add small desktop density improvements only after user testing.
5. Remove verified-dead legacy customer CSS.

## Proposed Arcana Design Rules

Typography:
- system sans for primary UI;
- monospace only for compact metadata/technical admin IDs;
- app scale: 34 display, 24 title, 17 heading, 15 body, 14 secondary, 12 meta;
- keep normal product UI compact; public hero can scale but should not become giant.

Spacing:
- use a 4px base;
- preferred recurring steps: 4, 8, 12, 16, 24, 32, 48;
- phone gutter 24 where space permits, 20 on narrow web;
- remove low-priority content before squeezing spacing.

Color:
- ink #0A0A0A;
- paper #FFFFFF;
- panel #F5F5F3;
- secondary text around #5F5F5A;
- one tertiary neutral;
- border/rule around #E6E6E3;
- dark red only for danger/error;
- no blue brand accent.

Borders/elevation:
- 1px rules;
- no decorative customer shadows;
- platform/dialog elevation only where functionally required.

Radius:
- controls 6–8;
- groups/dialogs 8–10;
- no giant rounded cards;
- pills only for compact semantic statuses/tags.

Core components:
- page shell;
- section heading + rule;
- row/list;
- grouped rows;
- black primary button;
- outline secondary button;
- text link;
- notice/error;
- selection dot;
- confirmation dialog;
- compact status text/dot.

Icons:
Use only back, chevron, overflow and platform-required symbols unless an icon clearly reduces cognitive load. Do not add an icon library for decoration.

Layout:
- app mobile: Connect / Locations / Account bottom nav; max readable width around 520; 24 gutter;
- app desktop: compact left navigation at large width; retain narrow content;
- web public: editorial max width around 1040;
- web account: wider two-column desktop shell, deliberate compact mobile section navigation.

Interaction:
Every async action needs idle, progress, success/state update and safe failure.
VPN state must always be textual, not color-only.
Destructive actions require Arcana confirmation, not browser-native dialogs.

Customer vocabulary:
Use Connect, Disconnect, Protected, Not connected, Connecting, Reconnecting, Internet blocked, Location, Automatic, 1 server, 2 servers, Entry/Exit location when necessary, Configuration, Device, Subscription.

Avoid in ordinary customer UI:
node, relay, route, profile, failure domain, UUID, credential, VLESS, REALITY, Hysteria2, seat, link.

Admin may use precise infrastructure terminology.

## Recommendations Deliberately Rejected

The audit does not recommend:
- replacing Connect / Locations / Account;
- moving Custom servers out of Advanced;
- adding a world map;
- adding load bars;
- adding fake/unmeasured latency;
- adding favorites now;
- adding per-user traffic charts without trustworthy attribution;
- turning the app into a desktop dashboard;
- hiding fail-closed states;
- exposing protocols for “technical credibility”;
- forcing pixel-identical web/Flutter UI;
- removing danger red;
- adding decorative iconography.

## Screenshot Evidence

Website screenshot audit:
- public home/login/signup;
- account overview/subscriptions/devices/configurations/billing/security/help;
- major admin/fleet surfaces;
- widths 360/375/390/430/768/1024/1440.

Audit-only branch: feat/arcana-design-audit in vpn-web.

Flutter evidence:
- current main 209 widget tests on Flutter 3.38.5;
- audit-only screenshot harness on feat/arcana-design-audit in tamara-next;
- no product UI changes are part of that harness.

Earlier black rectangles reported from widget-test fonts are not considered defects unless reproduced outside test rendering.

## Files / Components Most Affected

Flutter:
- lib/presentation/shell/tamara_shell.dart
- lib/presentation/widgets/arcana_widgets.dart
- lib/presentation/theme/arcana_theme.dart
- lib/presentation/connect/connect_screen.dart
- lib/presentation/connect/two_server_screen.dart
- lib/presentation/connect/saved_configurations_screen.dart
- lib/presentation/settings/settings_screen.dart
- lib/presentation/settings/advanced_screen.dart

Web customer:
- src/app/page.tsx
- src/app/globals.css
- src/components/account/AccountShell.tsx
- src/app/account/connections/page.tsx
- src/app/account/subscriptions/page.tsx
- src/app/account/devices/page.tsx
- login/signup pages

Web admin:
- src/components/admin/AdminShell.tsx
- src/components/admin/AdminNav.tsx
- src/components/admin/MetricCard.tsx
- repeated admin form/button/status styling

Production trust:
- src/app/terms/page.tsx
- src/app/privacy/page.tsx
- src/app/impressum/page.tsx
- src/app/account/help/page.tsx
- tamara-next/lib/app/tamara_app.dart

## Final Judgment

Keep the redesign.

The managed app's core product structure is stronger than the older Tamara profile/settings model, and the customer web account area already has the correct Arcana visual grammar.

The next agent should do a focused correction pass, in this order:
1. legal/release placeholders;
2. 2-server and vocabulary consistency;
3. mobile account navigation;
4. web account dialogs;
5. Flutter desktop shell;
6. public landing density;
7. duplicate/small design-system debt;
8. admin visual primitives.

That makes Arcana materially more coherent without adding features or rebuilding screens that already work.
