export { record, recordEnv, appNameProp } from "./run.ts";
export { placeWindows, checkPlacement, systemX11 } from "./place.ts";
export type { X11, PlacementHandle, PlacementCheck } from "./place.ts";
export { obsMirror, obsMirrorEnv, obsMirrorArgs, DEFAULT_GLCAPTURE_LIB } from "./obs.ts";
export { buildProfile, healRealProfile, BACKGROUND_RECORD, AUDIO_BACKENDS, NULL_AUDIO_BACKEND } from "./profile.ts";
export { dolphinStatus, dolphinConfigured } from "./status.ts";
export { lastFrameOf } from "./slp.ts";
export { pidTree, killTree } from "./kill.ts";
export { resolveRealProfile, realProfileRoot, profileAt, realProfileExists, appDataPath } from "./paths.ts";
export { buildComm, writeComm, buildMirrorComm, writeMirrorComm } from "./comm.ts";
export type { CommFile, MirrorCommFile } from "./comm.ts";
export { parseFrameLine, reachedEnd, foldEnd } from "./frames.ts";
export type { FrameLine } from "./frames.ts";
export { setInSection, setEverywhere, getInSection } from "./ini.ts";
export type {
  DolphinPaths,
  RealProfile,
  ProfileMode,
  DumpCodec,
  AudioBackend,
  PlacementOptions,
  PlacementReport,
  PlacedWindow,
  RunnerWarning,
  ProfileOptions,
  RenderWindow,
  RunOptions,
  RecordOptions,
  RecordResult,
  StallDiagnostic,
  ObsMirrorOptions,
  ObsMirrorHandle,
} from "./types.ts";
