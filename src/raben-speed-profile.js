export const Raben_SPEED_PROFILE_IDS = Object.freeze(['safe', 'fast', 'ultra']);

export function normalizeRabenSpeedProfile(value) {
  return Raben_SPEED_PROFILE_IDS.includes(value) ? value : 'safe';
}
