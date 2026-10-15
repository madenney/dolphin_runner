export {
  record,
  recordArgs,
  play,
  playArgs,
  recordEnv,
  appNameProp,
  stripAppImageEnv,
  APPIMAGE_RUNTIME_VARS,
  statusContext,
  noVideoError,
} from "./run.ts";
export { placeWindows, checkPlacement, systemX11 } from "./place.ts";
export type { X11, PlacementHandle, PlacementCheck, Rect, Monitor } from "./place.ts";
export { createHideController } from "./run.ts";
export {
  planHide,
  normalizeHide,
  detectSession,
  hideDolphinIniDirectives,
  compositorMoveArgs,
} from "./hide.ts";
export type { HideTarget, HideReport, HidePlan, SessionInfo, IniDirective } from "./hide.ts";
export { loadWinNative, unavailableNative } from "./win-native.ts";
export type { NativeHideResult, WinNativeBackend } from "./win-native.ts";
export {
  prepareMacRecorderApp,
  macRecorderBuildSteps,
  macHideByPidArgs,
  macRecorderCacheKey,
  macRecorderAppPath,
  macDumpEntitlementsArgs,
  DEFAULT_MAC_IDENTITY,
} from "./mac-hide.ts";
export type { MacRecorderIdentity, MacRecorderResult } from "./mac-hide.ts";
export { obsMirror, obsMirrorEnv, obsMirrorArgs, DEFAULT_GLCAPTURE_LIB } from "./obs.ts";
export {
  buildProfile,
  healRealProfile,
  sameLinkTarget,
  BACKGROUND_RECORD,
  HIDDEN_RECORD,
  AUDIO_BACKENDS,
  NULL_AUDIO_BACKEND,
} from "./profile.ts";
export { dolphinStatus, dolphinConfigured, isAppImage, hasLibfuse2, LIBFUSE2_PATHS } from "./status.ts";
export type { StatusOptions } from "./status.ts";
export { lastFrameOf, lastFrameFromFooter, lastFrameFromEvents } from "./slp.ts";
export { pidTree, killTree, taskkillArgs } from "./kill.ts";
export type { KillDeps } from "./kill.ts";
export {
  resolveRealProfile,
  realProfileRoot,
  profileAt,
  realProfileExists,
  appDataPath,
  appBundleOf,
  resolveDolphinExecutable,
} from "./paths.ts";
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
  TexturePack,
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
  PlayOptions,
  PlayResult,
  StallDiagnostic,
  ExitInfo,
  DolphinRunError,
  ObsMirrorOptions,
  ObsMirrorHandle,
} from "./types.ts";
