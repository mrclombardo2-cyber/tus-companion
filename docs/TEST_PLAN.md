# Release test plan — v5

## Desktop/local
- Start server and select a known course.
- Confirm Today and Week load from the saved snapshot.
- Confirm the currently active class receives NOW/highlight.
- Toggle 24-hour ↔ AM/PM and reload; preference must persist.
- Open Terms and Privacy from Settings.
- Use install guidance and verify no repeated prompt after dismiss/install.

## Live sync/diff
- Run two unchanged syncs: second sync must produce `changes: 0`.
- Change a fixture/live test value and verify room/time/lecturer/type/weeks change detection.
- Confirm a failed fetch leaves the previous snapshot visible.

## Push
- Enable notifications on one desktop/Android device.
- Tap Send test and verify exactly one notification.
- Hide one module and update notifications; synthetic/live changes for that module must not be pushed.
- Turn notifications off and verify the server subscription is deactivated and browser subscription removed.
- On iPhone/iPad, install to Home Screen first, then enable and test push.

## Routing
- During an active class, tap Directions for the next class; departure should use the active room code.
- Between classes, verify previous room is used when available.
- With no mapped start, deny geolocation and confirm Mappedin opens destination-only with a friendly fallback.
- Enable Accessible routes and verify `accessible=true` is present in the Mappedin route URL.

## Public launch
- Use HTTPS.
- Populate real operator/contact data in `config.ps1`.
- Set a strong admin token.
- Do not expose `.tus-session`, `.tus-browser-profile`, `data`, `secrets` or `config.ps1` from the web root.
- Verify backup/restart behavior for SQLite and source session.
- Review TUS usage/terms and obtain appropriate legal/privacy review for the intended public deployment.
