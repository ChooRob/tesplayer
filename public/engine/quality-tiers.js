// One quality ladder for every playback, from Ultra down to Low. Ultra is the
// 1080p / 60 fps tier for newer hardware and a fast connection; Auto never
// picks it, so a device only streams it when the viewer chooses it.
const MB = 1024 * 1024;
export const QUALITY_TIERS = {
  ultra: { width: 1920, height: 1080, fps: 60, maxDecodedFrames: 10, decodedBudget: 64 * MB },
  high: { width: 1280, height: 720, fps: 30, maxDecodedFrames: 6, decodedBudget: 24 * MB },
  medium: { width: 960, height: 540, fps: 30, maxDecodedFrames: 6, decodedBudget: 24 * MB },
  low: { width: 640, height: 360, fps: 30, maxDecodedFrames: 6, decodedBudget: 24 * MB },
};
export const QUALITY_LEVELS = Object.keys(QUALITY_TIERS);
// What Auto may choose between: everything below Ultra.
export const AUTO_QUALITY_LEVELS = QUALITY_LEVELS.filter(level => level !== 'ultra');
export const normalizeQuality = value => (Object.hasOwn(QUALITY_TIERS, value) ? value : 'high');

export function decodedFrameCapacity(quality, width, height) {
  const settings = QUALITY_TIERS[normalizeQuality(quality)];
  const bytes = Math.max(1, width * height * 4);
  return Math.max(2, Math.min(settings.maxDecodedFrames, Math.floor(settings.decodedBudget / bytes)));
}

// Bitrate and size to ask the media server for at each tier. The configured
// bitrate is the ceiling for High; Ultra never goes below its own 6 Mbit/s.
export function qualityTiers(configuredBitrate = 4000) {
  const high = Math.min(configuredBitrate, 2000);
  const size = level => `${QUALITY_TIERS[level].width}x${QUALITY_TIERS[level].height}`;
  return {
    ultra: { videoBitrate: Math.max(configuredBitrate, 6000), videoResolution: size('ultra') },
    high: { videoBitrate: high, videoResolution: size('high') },
    medium: { videoBitrate: Math.max(500, Math.round(high * .5)), videoResolution: size('medium') },
    low: { videoBitrate: Math.max(300, Math.round(high * .25)), videoResolution: size('low') },
  };
}

export function plexProfileConstraints(quality) {
  const { fps } = QUALITY_TIERS[normalizeQuality(quality)];
  return [
    `add-limitation(scope=videoCodec&scopeName=*&type=upperBound&name=video.frameRate&value=${fps}&replace=true)`,
    'add-limitation(scope=videoCodec&scopeName=h264&type=upperBound&name=video.bitDepth&value=8&replace=true)',
    `add-limitation(scope=videoTranscodeTarget&scopeName=h264&scopeType=videoCodec&type=upperBound&name=video.frameRate&value=${fps}&replace=true)`,
    'add-limitation(scope=audioCodec&scopeName=*&type=upperBound&name=audio.channels&value=2&replace=true)',
    'append-transcode-target-codec(type=videoProfile&context=streaming&videoCodec=h264&audioCodec=aac&protocol=hls)',
  ].join('+');
}
