"use strict";

/**
 * Blocky Studios Overdrive rollout switches. The proven native OLE drag and current
 * replay library are invariants, not experiments. Accepted product surfaces
 * default on here; unproven native helpers stay off. Unsupported hotkeys are
 * absent rather than represented by a dormant product gate.
 */
const ORACLE_OVERDRIVE_FEATURE_FLAGS = Object.freeze({
  nativeOleDrag: true,
  legacyReplayLibrary: false,
  bridgeProtocolV2: true,
  replayStoreV3Read: true,
  replayStoreV3Write: true,
  virtualReplayGrid: true,
  nativeMediaMetadata: false,
  nativeDirectoryWatch: true,
  nativeFileOperations: true,
  nativeDiagnostics: false,
  overdriveShell: true,
  replayLifecycle: true,
  replayViewer: true,
  curvesWorkspace: true,
  quickApplyWorkspace: true,
  multiPanelSync: true,
});

function isOracleFeatureEnabled(name, overrides = null) {
  if (!Object.prototype.hasOwnProperty.call(ORACLE_OVERDRIVE_FEATURE_FLAGS, name)) {
    return false;
  }
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, name)) {
    return overrides[name] === true;
  }
  return ORACLE_OVERDRIVE_FEATURE_FLAGS[name] === true;
}

module.exports = {
  ORACLE_OVERDRIVE_FEATURE_FLAGS,
  isOracleFeatureEnabled,
};
