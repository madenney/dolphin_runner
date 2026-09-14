export { record, mirror } from "./run.ts";
export { buildProfile, healRealProfile } from "./profile.ts";
export { dolphinStatus, dolphinConfigured } from "./status.ts";
export { lastFrameOf } from "./slp.ts";
export { pidTree, killTree } from "./kill.ts";
export { resolveRealProfile, realProfileRoot, profileAt, realProfileExists, appDataPath } from "./paths.ts";
export { buildComm, writeComm } from "./comm.ts";
export { parseFrameLine, reachedEnd, foldEnd } from "./frames.ts";
export type { FrameLine } from "./frames.ts";
export { setInSection, setEverywhere, getInSection } from "./ini.ts";
export type {
  DolphinPaths,
  RealProfile,
  ProfileMode,
  ProfileOptions,
  RunOptions,
  RecordOptions,
  RecordResult,
  StallDiagnostic,
} from "./types.ts";
