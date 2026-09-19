export { record, mirror } from "./run.ts";
export { obsMirror, obsMirrorEnv, obsMirrorArgs, DEFAULT_GLCAPTURE_LIB } from "./obs.ts";
export { buildProfile, healRealProfile } from "./profile.ts";
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
  ProfileOptions,
  RenderWindow,
  RunOptions,
  RecordOptions,
  RecordResult,
  StallDiagnostic,
  ObsMirrorOptions,
  ObsMirrorHandle,
} from "./types.ts";
