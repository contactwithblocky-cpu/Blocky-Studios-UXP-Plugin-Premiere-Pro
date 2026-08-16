# Blocky Studios Curves: native two-key easing contract

Verified on 2026-07-31 against the public Premiere UXP 26.3.0 declarations and the newest published beta declarations available that day, `@adobe/premierepro@26.5.0-beta.73`.

## What Premiere exposes

`ComponentParam.createSetInterpolationAtKeyframeAction(time, interpolationMode, updateUI)` can change an existing keyframe's interpolation class inside a normal Premiere transaction. The public modes relevant to Blocky Studios are Linear, Hold, and Bezier. `Keyframe.getTemporalInterpolationMode()` provides readback for that class.

Neither stable nor beta exposes a temporal tangent, influence, velocity, incoming-ease, or outgoing-ease field. The legacy ExtendScript surface likewise exposes `setInterpolationTypeAtKey()` but no supported custom temporal-tangent setter.

Adobe Hybrid addons do not widen the Premiere DOM. They provide a generic native module boundary for computation and operating-system integration; calls back into Premiere still use the public host surface. The installed Hybrid SDK contains no Premiere keyframe-tangent suite.

Primary references:

- <https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/componentparam/>
- <https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/keyframe/>
- <https://developer.adobe.com/premiere-pro/uxp/ppro-reference/constants/>
- <https://developer.adobe.com/premiere-pro/uxp/changelog/>
- <https://developer.adobe.com/premiere-pro/uxp/plugins/hybrid-plugins/>
- <https://ppro-scripting.docsforadobe.dev/sequence/componentparam/#componentparam-setinterpolationtypeatkey>

## Shipped Blocky Studios behavior

The Curves page has one host mutation path:

1. Resolve the selected property and the exact bracketing keyframe segment.
2. Create only `createSetInterpolationAtKeyframeAction` actions.
3. Commit all selected targets in one `project.executeTransaction()` call under `project.lockedAccess()`.
4. Read both endpoints back and require their times and values to be unchanged.
5. Require the requested interpolation mode on the start endpoint.
6. Return an explicit receipt with zero keys created, removed, or moved.

The editable cubic graph and its saved presets are accurate local Blocky Studios curve definitions. For non-linear curves, the page labels Premiere Bezier as host-managed because Premiere cannot receive Blocky Studios' four cubic control values. The page does not claim those tangent values were transferred.

The previous adaptive sampled-key implementation remains isolated for migration and regression coverage, but the shipped Curves controller does not enable it and the UI exposes no Baked mode. There is no silent fallback from native Apply to a generic or sampled-key route.

## Future enablement gate

Exact two-key custom curves may be enabled only after Adobe publishes both:

- a supported action or setter for incoming and outgoing temporal tangent data; and
- readback sufficient to verify those tangent values after the transaction.

When that exists, add the tangent fields to the adapter plan integrity record, apply them inside the existing single transaction, verify them with endpoint readback, and only then change the UI from “Premiere-managed” to “Exact Blocky Studios curve.” A separate custom video effect could own its own eased parameter, but it would not be a supported way to hijack arbitrary existing Premiere properties.
