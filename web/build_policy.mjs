// iPad Safari can use the desktop Mac user agent.
export function buildPolicy(device = navigator, media = globalThis.matchMedia) {
  const touch = device.maxTouchPoints || 0;
  const handheld = !!device.userAgentData?.mobile || /iPhone|iPad|iPod|Android/i.test(device.userAgent || '') ||
    device.platform === 'MacIntel' && touch > 1 || touch > 0 && !!media?.('(max-width: 900px)').matches;
  const lowMemory = handheld || device.deviceMemory > 0 && device.deviceMemory <= 4;
  // WebKit may offer only three fast Wasm memory reservations. Two retained
  // compiler instances keep both comparison lanes on the same execution path.
  const webkit = /AppleWebKit\//.test(device.userAgent || '') && !/(?:Chrome|Chromium|Edg|OPR)\//.test(device.userAgent || '');
  const maximum = lowMemory ? 4 : 8, cores = Math.max(1, Number(device.hardwareConcurrency) || 1);
  return {handheld, lowMemory, maximum,
    defaultWorkers: [8, 4, 2, 1].find(n => n <= Math.min(lowMemory || webkit ? 2 : maximum, cores)),
    recycleEvery: lowMemory ? 1 : 0};
}
