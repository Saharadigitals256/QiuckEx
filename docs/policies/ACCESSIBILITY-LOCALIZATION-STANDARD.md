# Accessibility & Localization Standard — Web and Mobile

Issue: [#308](https://github.com/Viky207/QiuckEx/issues/308) · Workstream: documentation & governance · Owning surfaces: `app/frontend` (Next.js web), `app/mobile` (Expo / React Native)

QuickEx moves money. An inaccessible payment link or an untranslated error message is not a cosmetic defect — it
is a blocked payment. This standard defines the **target, the rules, the tooling, and the ratchet** for
accessibility and localization on both client surfaces, and it is machine-checked by
`node scripts/governance/check.mjs --only a11y`.

## 1. Conformance target

| Surface | Target | Standard basis |
|---|---|---|
| Web (`app/frontend`) | **WCAG 2.2 Level AA** on every route a user can pay, receive or manage a link on | [WCAG 2.2](https://www.w3.org/TR/WCAG22/) |
| Mobile (`app/mobile`) | **WCAG 2.2 AA equivalent** (perceivable/operable/understandable/robust) plus platform guidance | WCAG 2.2 + Apple HIG Accessibility + Android Accessibility |
| Both | **Primary flows usable keyboard/screen-reader-only end to end**: create a link, view a link, pay, confirm receipt, change language | This standard, §3–§5 |

Minimum accepted per release: Level A must pass everywhere; AA must pass on the pay/receive/generator/settings
flows. Failures are tracked in the baseline (§8) — a release may not increase the baseline.

## 2. Current state (verified, not assumed)

| Item | State today | Consequence |
|---|---|---|
| `app/frontend/eslint.a11y.config.mjs` | Exists with `jsx-a11y` recommended rules + five explicit error rules | **Not wired**: `eslint.config.mjs` does not import it, and `eslint-plugin-jsx-a11y` is not a dependency, so no a11y rule runs today |
| Frontend lint in CI | `frontend-ci.yml` / `turbo lint`; the package `test` script is a no-op ("Skipping frontend checks in backend release pipeline") | No automated a11y or i18n check runs on PRs |
| `aria-*` usage | ~106 occurrences across `app/frontend/src/**/*.tsx` | Some good practice exists, but coverage is uneven and unverified |
| Locale catalogs | Inline objects inside `app/frontend/src/lib/i18n.ts` and `app/mobile/src/lib/i18n.ts`, three locales: `en`, `es`, `fr` | Not machine-checkable per locale today; measured key gaps: frontend `es` misses 3 keys, mobile `es` and `fr` miss 7 keys each — all baselined and machine-checked by the gate |
| Locale switcher | Web offers `en`, `es`, `fr` (all three backed by catalogs); mobile offers `en` only although `es`/`fr` catalogs exist | Mobile users cannot switch language; the gate reports the undiscoverable catalogs as a warning |
| Mobile a11y config | None | Screen-reader labels and roles are inconsistent |
| Automated a11y tests | None (`vitest` + Testing Library are present; no axe integration) | No regression protection |

Everything in this table is a **baseline gap**, itemised in
[data/a11y-i18n-baseline.json](./data/a11y-i18n-baseline.json), not a hidden failure.

---

## 3. Web requirements (`app/frontend`)

**Structure and semantics**

1. Every page has exactly one `<h1>`; headings nest without skipping levels.
2. Interactive elements are real elements: `<button>` for actions, `<a>`/`next/link` for navigation. A `<div onClick>` is a defect unless it also carries a role, keyboard handlers and focus management (and then it is still discouraged).
3. Landmarks (`header`, `nav`, `main`, `footer`) are used once per page and are not duplicated by wrapper components.
4. Images: informational images have `alt` text describing purpose (not filename); decorative images use `alt=""`; asset logos use the asset code in the alt text (e.g. `alt="USDC"`).

**Keyboard and focus**

5. Everything reachable by mouse is reachable by `Tab`; nothing requires a pointer.
6. Focus is always visible (never `outline: none` without a replacement) and focus order follows visual order.
7. Modals/drawers trap focus while open, move focus to the first meaningful element on open, restore focus to the trigger on close, and close on `Escape`.
8. `tabindex` values greater than 0 are forbidden (`jsx-a11y/tabindex-no-positive`).
9. Client-side route changes move focus to the new page's main heading and update the document title; the route change is announced.

**Perception**

10. Text contrast ≥ 4.5:1 (≥ 3:1 for large text); UI component and focus indicator contrast ≥ 3:1. Tailwind theme tokens are the only allowed color source so contrast can be audited centrally.
11. Information is never conveyed by color alone (e.g. link status uses text/icon plus color).
12. Text honours zoom to 200 % and browser font-size overrides without loss of content or function; layouts must not use fixed heights that clip translated text.
13. `prefers-reduced-motion: reduce` disables non-essential animation.

**Forms and money-critical feedback**

14. Every input has a programmatically associated label (`label-has-associated-control`); placeholders are not labels.
15. Validation errors are announced (`role="alert"` or `aria-live="polite"`), referenced via `aria-describedby`, and identify the field by its label, not its position.
16. Amounts/addresses: copyable text and the copy control both expose accessible names; a truncated address exposes its full value to assistive tech (e.g. `title`/`aria-label`), not only visually.
17. Status that matters for money (payment link active/expired/paid, sweep/refund progress) is exposed as text or an accessible live region — never as a spinner alone.

**Interactive sizing**

18. Pointer targets are ≥ 24×24 CSS px (WCAG 2.2 §2.5.8) and ≥ 44×44 CSS px for the primary pay/confirm actions.

---

## 4. Mobile requirements (`app/mobile`)

1. Every `Pressable`/`Touchable*` exposes `accessibilityRole` and an `accessibilityLabel` that includes the action and its subject ("Share payment link", not "Share"). Icon-only controls always need a label.
2. Money-critical groups use `accessibilityRole="header"`/`"summary"` appropriately, and composite rows expose a single meaningful label instead of per-character fragments.
3. State (selected tab, checked box, toggle) is exposed via `accessibilityState`, not colour.
4. Touch targets are ≥ 44×44 pt (iOS) / 48×48 dp (Android) including the hit area.
5. Dynamic Type / font scaling: text scales without clipping; layouts use flexible rows, and text styles avoid `allowFontScaling={false}` except for fixed-size glyphs (never for body copy).
6. Screen-reader order matches visual order; decorative icons/gradients are `accessible={false}` or `importantForAccessibility="no"`.
7. Haptics/animations respect the OS reduce-motion setting; no essential information is conveyed only by animation or haptic feedback.
8. Error and success states for a payment are announced (`AccessibilityInfo.announceForAccessibility`) and rendered as text.
9. Camera/QR flows: the scanner screen explains what to do, is operable without gestures that require sight, and offers a manual entry fallback (already present in the receive flow — keep it).
10. Device-local data (wallet session, contacts) is never required to be read aloud; secure values are excluded from screen readers and from screenshots where the platform allows (`secureTextEntry`, `excludeFromCapture` for secret-bearing views).

---

## 5. Localization requirements

**Catalogs and keys**

1. No user-visible string literal in a component. All copy comes from a translation key via `useTranslation()` / `t('…')`. Exceptions: `aria-hidden` decorative glyphs, debug-only developer screens, and log messages (which are never translated).
2. Key naming is `surface.section.element` in `camelCase` segments, e.g. `generator.amount.label`, `pay.status.expired.title`. Keys describe meaning, never the English copy (`linkGenerator.submit`, not `createPaymentButton`).
3. Interpolation uses named placeholders (`{{amount}}`, `{{asset}}`) — never positional concatenation. Sentence assembly by string concatenation is forbidden (`t('a') + ' ' + t('b')`).
4. Plurals use i18next plural keys (`key_one` / `key_other` in English; the correct plural categories per locale) — never `count === 1 ? … : …` in a component.
5. Every key added to `en` is added to every locale declared as supported, in the same PR (checked by the gate, §9).
6. Removing a key removes it from all locales at once; orphan keys are reported by the gate.

**Locale handling**

7. Supported locales are declared in exactly one place per surface (the `LocaleSwitcher` options plus the catalogs). A locale offered in the switcher **must** have a catalog — both surfaces satisfy this today. The inverse is also a defect: a catalog that no switcher entry offers hides a translated surface from users (the mobile switcher currently exposes only `en` while `es`/`fr` catalogs exist; the gate reports this as a warning until it is fixed).
8. Fallback is always `en`; a missing key renders the English string and is reported by the gate. Rendering the raw key (`generator.amount.label`) to a user is a release blocker.
9. `document.documentElement.lang` (web) reflects the active locale; mobile follows the platform locale where the OS supports it.
10. Number, currency, date and time formatting uses `Intl.NumberFormat` / `Intl.DateTimeFormat` with the active locale. **Amounts follow the asset's decimals (7 for Stellar assets), not locale currency conventions** — a locale may change grouping/decimal separators, never re-scale a monetary value.
11. RTL/localized digits: layouts must be `dir`-aware (logical CSS properties such as `margin-inline-start`, not `margin-left`). No locale is RTL today, so this is a *readiness* rule to check before adding one.
12. One pseudo-localization pass per release (`en-XA`-style: longer, bracketed strings) over the pay and generator flows catches clipping and untranslated literals.
13. Money-critical keys (`*.amount.*`, `*.fee.*`, `*.withdraw.*`, `*.balance.*`) require a speaker review before shipping a new locale; machine-only translation of those keys is not acceptable.

---

## 6. Testing requirements

| Layer | Requirement | Tooling |
|---|---|---|
| Static (both) | a11y lint runs in CI and fails on errors | `eslint-plugin-jsx-a11y` (web; config drafted at `app/frontend/eslint.a11y.config.mjs`), `eslint-plugin-react-native-a11y` (mobile) |
| Static (both) | i18n gate: key parity, declared-locale catalogs, orphan keys, baseline regressions | `node scripts/governance/check.mjs --only a11y` |
| Component (web) | Route-level axe smoke test for pay, generator, settings, dashboard; zero AA violations | `vitest` + `@testing-library/react` (already present) + axe integration |
| Manual (both) | Keyboard-only and screen-reader pass (VoiceOver, TalkBack, NVDA) over pay/receive each release, recorded by name | [../../RELEASE_READINESS_CHECKLIST.md](../../RELEASE_READINESS_CHECKLIST.md) |
| Manual (web) | 200 % zoom + 320 px width pass; contrast check of theme tokens | DevTools |
| Manual (both) | Pseudo-locale pass (§5.12) | i18next `en-XA` resources |

Automated coverage is a floor, not the goal: axe cannot detect focus traps, announcement quality, or whether a
translated label reads sensibly. Manual evidence is required for those, and the release checklist records who did it.

---

## 7. Tooling rollout (ordered, smallest-first)

1. **Gate first (no new dependencies)**: the governance gate (§9) enforces catalog parity, declared-locale catalogs, and the presence of the required sections of this standard. It can land immediately.
2. **Web a11y lint**: add `eslint-plugin-jsx-a11y` and import `eslint.a11y.config.mjs` from `eslint.config.mjs`; start with `warn` for rules the current code violates, promote each to `error` as files are fixed (ratchet, §8).
3. **Mobile a11y lint**: add `eslint-plugin-react-native-a11y` to `app/mobile` and enable the same ratchet.
4. **axe smoke tests**: add the axe integration to `app/frontend` vitest for four routes; fail on new violations.
5. **Catalog format**: move inline catalogs into per-locale files (`src/locales/<lng>.json`) so translations can be diffed and reviewed independently of code. Until then the gate parses the inline catalogs.
6. **CI wiring**: run `node scripts/governance/check.mjs` and the frontend a11y lint on pull requests.

Each step is independently shippable; no step depends on a later one.

---

## 8. Baseline, ratchet, and waivers

- **Baseline file**: [data/a11y-i18n-baseline.json](./data/a11y-i18n-baseline.json) records the *known* gaps
  (locale coverage per surface, missing keys per locale, unwired lint, missing axe tests), each with an owner.
  The gate fails when a gap that is **not** in the baseline appears.
- **Ratchet rule**: a release may not increase the baseline and must close at least one gap per release train —
  the same discipline already used for the secret-scanning baseline in `docs/security.md`.
- **Refresh**: `node scripts/governance/check.mjs --only a11y --write-baseline` regenerates the baseline; the diff is
  reviewed like code and every *new* entry needs a justification in the PR description.
- **Waivers**: an AA failure may be waived for at most one release using
  `surface / criterion / reason / owner / expiry release` in the baseline entry. Waivers never apply to keyboard
  traps, missing labels on money-critical controls, or unreadable contrast on primary actions.

---

## 9. Enforcement

```bash
node scripts/governance/check.mjs --only a11y           # catalogs, declared locales, baseline regressions
node --test scripts/governance/__tests__/i18n.test.mjs  # unit tests for the gate itself
```

The gate checks, deterministically and offline:

1. Both i18n entry points exist and their catalogs can be parsed (parsed as text; nothing is executed).
2. Every locale offered by a switcher has a catalog, and every catalog is offered by a switcher (a catalog with no switcher entry is reported as a warning — see §5.7).
3. Key parity: every key in `en` exists in each sibling locale; orphan keys are reported. Missing keys must be
   listed in the baseline to pass.
4. This document contains the required sections (target, current state, web/mobile requirements, localization,
   testing, rollout, baseline, enforcement), so the standard cannot be trimmed into a stub.
5. Money-critical key naming coverage per locale (§5.13).

## 10. References

- [data/a11y-i18n-baseline.json](./data/a11y-i18n-baseline.json) · [../../scripts/governance/README.md](../../scripts/governance/README.md)
- `app/frontend/src/lib/i18n.ts`, `app/mobile/src/lib/i18n.ts`, `app/frontend/eslint.a11y.config.mjs`, `app/frontend/src/components/LocaleSwitcher.tsx`
- [../GOVERNANCE.md](../GOVERNANCE.md), [../../RELEASE_READINESS_CHECKLIST.md](../../RELEASE_READINESS_CHECKLIST.md), [../CONTRIBUTOR-PREVIEW-GUIDE.md](../CONTRIBUTOR-PREVIEW-GUIDE.md)
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/), [WAI-ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/)
