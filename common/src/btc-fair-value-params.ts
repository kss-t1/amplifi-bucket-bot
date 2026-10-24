/** Fitted BTC daily fair-value parameters; regenerate with scripts/fair-value-calibrate.ts --write-params. */
import raw from "./btc-fair-value-params.json" with { type: "json" };
import { normalizeProfile, type TailMix, type VolProfile } from "./fair-value.ts";

export const BTC_FAIR_VALUE_PARAMS: {
  windowHours: number;
  volScale: number;
  tails: TailMix;
  profile: VolProfile;
} = {
  windowHours: raw.windowHours,
  volScale: raw.volScale,
  tails: raw.tails,
  profile: normalizeProfile(raw.profile),
};
