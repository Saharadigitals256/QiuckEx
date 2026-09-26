# Mobile Release Checklist

This checklist supports the internal testing build pipeline for QuickEx Mobile.

For the cross-app (backend/frontend/mobile/contracts) release gate, see the root [RELEASE_READINESS_CHECKLIST.md](../../RELEASE_READINESS_CHECKLIST.md).

## Release Pipeline
- [ ] Verify `.github/workflows/mobile-release.yml` exists and triggers on release tags `v*`
- [ ] Ensure `EAS_TOKEN` is configured in GitHub repository secrets
- [ ] Confirm `app/mobile/eas.json` contains `dev`, `staging`, and `production` internal build profiles
- [ ] Confirm build job does not print secrets or credentials in logs

## Build Metadata
- [ ] Confirm the app shows version and build metadata in Settings
- [ ] Confirm the app displays the selected build environment (`dev`, `staging`, `production`)
- [ ] Confirm the app displays the target network (`testnet` or `mainnet`)
- [ ] On release tags, make sure production builds are generated for both Android and iOS

## Permissions
- [ ] Camera permission only for QR scanning
- [ ] Local authentication permission only for wallet protection and unlocking secure data
- [ ] Notifications permission only for push and badge updates
- [ ] Background fetch permission only for sync activity and not for unnecessary telemetry

## Privacy Review
- [ ] No sensitive keys or secrets are embedded in mobile builds
- [ ] Supabase anonymous keys are used only for public requests and not for private data
- [ ] Wallet keys remain on-device and are never transmitted to backend services
- [ ] Data transmitted over the network is encrypted and sent only to approved endpoints
- [ ] User transaction history is treated as private and not shared with third parties without consent

## Security & Deep Linking
- [ ] Confirm deep-link route resolution rejects homoglyphs, open-redirects, and expired links
- [ ] Confirm one-time nonces cannot be replayed across sessions
- [ ] Confirm native receipt verification passes against backend `/v1/receipts/*` with degraded offline fallback

## Accessibility (A11y)
- [ ] Confirm all payment and wallet action buttons declare `accessibilityRole="button"`, `accessibilityLabel`, and `accessibilityHint`
- [ ] Run automated accessibility suite (`__tests__/accessibility-automation.test.tsx` and Maestro `core-accessibility.yml`)

## Environment & Network Parity
- [ ] Confirm iOS `bundleIdentifier` and Android `package` match for each profile
- [ ] Confirm production release builds target `mainnet` and `https://api.quickex.to`
- [ ] Confirm staging/dev release builds never use production secrets or mainnet contracts
- [ ] Run release parity test suite (`__tests__/release-build-parity.test.ts`)

## QA Verification
- [ ] Install internal build on Android and verify the correct environment shows in-app
- [ ] Install internal build on iOS and verify the correct environment and network display
- [ ] Verify the release tag or build metadata is visible if present
- [ ] Confirm the app behaves normally in the selected network environment

