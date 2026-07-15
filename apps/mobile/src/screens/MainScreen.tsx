import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Image,
  KeyboardAvoidingView,
  LayoutAnimation,
  Linking,
  ListRenderItem,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  UIManager,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import * as FileSystemLegacy from "expo-file-system/legacy";
import * as IntentLauncher from "expo-intent-launcher";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useVideoPlayer, VideoView } from "expo-video";
import RNFS from "react-native-fs";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { pickFolder, enumerateFolder, FolderTooLargeError } from "../lib/folderShare";
import { useAppTheme } from "../state/ThemeContext";
import { useBackend } from "../state/backend";
import { useShareLinkFlow } from "../state/ShareLinkFlowContext";
import type { DriveLocalFile, DriveRecord } from "../state/types";
import type { AppTheme } from "../ui/themes";
import {
  baseName,
  bundleIconName,
  fileIconName,
  mimeFromName,
  previewModeFor,
  truncateMiddle,
  type IconName,
  type PreviewMode,
} from "../lib/files";
import {
  loadSharedFilePaths,
  removeSharedFilePaths,
  saveSharedFilePathsEntry,
  subscribeSharedFilePaths,
  type SharedFilePath,
  type SharedFilePathsEntry,
} from "../state/sharedFilePathsStorage";
import {
  deleteShare,
  loadShares,
  setShareFavorite,
  setSharePinned,
  subscribeShares,
  type ReceivedShare,
} from "../state/receivedSharesStorage";
import {
  clearHostedShareFlags,
  loadHostedFlags,
  setHostedShareFavorite,
  setHostedSharePinned,
  subscribeHostedFlags,
  type HostedShareFlags,
} from "../state/hostedShareFlagsStorage";
import { formatBytes, formatClock, formatRelativeOrDate } from "../lib/format";
import { errorMessage } from "../lib/errorMessage";
import { haptics } from "../lib/haptics";
import { useToast } from "../ui/Toast";
import ShareQrModal from "../ui/ShareQrModal";
import ConfirmModal from "../ui/ConfirmModal";
import SwipeableRow from "../ui/SwipeableRow";
import ActiveIndicator, { type ActiveIndicatorState } from "../ui/ActiveIndicator";

// enable LayoutAnimation on Android. Standard one-shot init; the
// flag is no-op on iOS where LayoutAnimation works out of the box. Must
// run after the import block so `import/first` doesn't flag it.
if (
  Platform.OS === "android" &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

type DriveRow = DriveRecord & {
  /** Computed: the file used when tapping a single-file row opens a preview.
   *  Undefined for multi-file bundles (which expand instead). */
  primaryFile?: DriveLocalFile;
  /** True when files.length > 1. Bundles expand on tap; single files preview. */
  isBundle?: boolean;
  /** present for synthesized received-share rows. When set, the
   *  list-flattening logic reads child file states from here (with isDownloaded
   *  flags) instead of from the engine's `files` + `localFiles` join. */
  share?: ReceivedShare;
  /** organizational flags. Sourced from the share's own record
   *  (received) or from hostedShareFlagsStorage (hosted). */
  isPinned?: boolean;
  isFavorite?: boolean;
};

/** Flattened list item — drives the FlatList. Bundles emit one bundle item;
 *  expanded bundles emit child items for each file directly after. */
type ListItem =
  | { kind: "drive"; drive: DriveRow; expanded: boolean }
  | {
      kind: "child";
      parentId: string;
      indexInBundle: number;
      name: string;
      size?: number;
      /** Resolved local path if the file is locally accessible (preview /
       *  open-in-another-app available). Undefined → child shows name/size
       *  but no preview/open affordance. */
      localPath?: string;
      /** file exists in the share's manifest but the user hasn't
       *  downloaded it yet — tap to initiate a smart re-grab. Only set on
       *  child rows derived from a received-share record. */
      isMissing?: boolean;
      /** the parent's shareKey, propagated to children so a
       *  missing-child tap can fill the link + preselect the file. */
      shareKey?: string;
      shareLink?: string;
    };

type PreviewState = {
  file: DriveLocalFile;
  mode: PreviewMode;
  /** parent drive id (or share synth id) so the preview's
   *  three-dots menu can route "Show QR" back to the right drive record. */
  parentDriveId?: string;
};

type PickerSheet = "share-files" | null;
type KebabSheet = { drive: DriveRow } | null;

function selectFiles(res: DocumentPicker.DocumentPickerResult): { name: string; size?: number; uri: string }[] {
  if (res.canceled) return [];
  const assets = "assets" in res ? res.assets : undefined;
  if (!assets?.length) return [];
  return assets
    .filter((a) => !!a.uri)
    .map((a) => ({
      name: a.name || a.uri.split("/").pop() || "file",
      size: a.size ?? undefined,
      uri: a.uri,
    }));
}

function rowPrimaryFile(d: DriveRecord): DriveLocalFile | undefined {
  if (Array.isArray(d.localFiles) && d.localFiles.length === 1) return d.localFiles[0];
  // For multi-file drives there is no single "primary" file — expansion
  // surfaces each one as its own child row.
  return undefined;
}

// Folder-share materialization uses the user's original filename (potentially
// with spaces or unicode) inside the cache filename. The URI returned by
// expo-file-system is URL-encoded — RNFS / bare-fs need the decoded form.
// Picker URIs don't trip this because their cache names are auto-generated.
function normalizeLocalPath(uri: string): string {
  let p = String(uri || "");
  if (p.startsWith("file://")) {
    p = p.slice(7);
    if (p.startsWith("//")) p = p.slice(1);
  }
  try {
    return decodeURI(p);
  } catch {
    return p;
  }
}

function rowDisplayName(d: DriveRecord): string {
  const files = d.files ?? [];
  if (files.length === 1) {
    const n = files[0]?.name?.trim();
    if (n) return truncateMiddle(baseName(n), 32);
  }
  if (d.name && d.name.trim().length > 0) {
    return truncateMiddle(d.name, 32);
  }
  return files.length > 0 ? `${files.length} files` : "Share";
}

function totalBytesOf(d: DriveRecord): number {
  if (typeof d.totalBytes === "number" && d.totalBytes > 0) return d.totalBytes;
  return (d.files ?? []).reduce((sum, f) => sum + (f.size ?? 0), 0);
}

function isOpenableInOtherApp(d: DriveRecord): boolean {
  return Array.isArray(d.localFiles) && d.localFiles.length > 0;
}

function driveIconName(d: DriveRecord): IconName {
  if ((d.files?.length ?? 0) > 1) return bundleIconName();
  const single = d.files?.[0]?.name ?? d.localFiles?.[0]?.name ?? d.name ?? "";
  return fileIconName(single);
}

// derive a low-alpha tint from a hex color. Used for the
// segmented control's active background — `theme.text` at ~7% alpha gives
// a quiet but visible lift on dark themes and a quiet but visible
// darkening on light themes, without competing with primary-colored
// affordances. Falls through to the input string if parsing fails.
function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: theme.bg },
    headerRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: theme.pad,
      paddingTop: 4,
      paddingBottom: 10,
      minHeight: 50,
    },
    wordmark: { fontSize: 20, fontWeight: "700", color: theme.text, letterSpacing: 0.2 },
    gearBtn: {
      width: 38,
      height: 38,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.border,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.cardStrong,
    },
    actionRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: theme.pad,
      paddingBottom: 12,
    },
    shareBtn: {
      flex: 4,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      paddingVertical: 12,
      borderRadius: 14,
      backgroundColor: theme.primary,
    },
    shareBtnText: { color: theme.onPrimary, fontWeight: "700", fontSize: 14 },
    linkInputWrap: {
      flex: 6,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.surfaceSubtle,
      paddingLeft: 12,
      paddingRight: 4,
      minHeight: 46,
    },
    linkInput: { flex: 1, color: theme.text, fontSize: 13, paddingVertical: 10 },
    qrScanBtn: {
      width: 34,
      height: 34,
      borderRadius: 10,
      alignItems: "center",
      justifyContent: "center",
    },
    // All / Favorites segmented control.
    viewToggleRow: {
      flexDirection: "row",
      marginHorizontal: theme.pad,
      marginTop: 4,
      marginBottom: 10,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.surfaceSubtle,
      padding: 2,
      gap: 2,
    },
    viewToggleSegment: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: 8,
      borderRadius: 8,
    },
    viewToggleSegmentActive: {
      // subtle, theme-agnostic fill — no longer competes with
      // the primary-colored "Share files" button. See withAlpha note above.
      backgroundColor: withAlpha(theme.text, 0.07),
    },
    viewToggleText: {
      color: theme.muted,
      fontWeight: "600",
      fontSize: 13,
    },
    viewToggleTextActive: {
      color: theme.text,
    },
    listFlex: { flex: 1, minHeight: 0 },
    list: { flex: 1 },
    listContent: { paddingBottom: 12 },
    listContentEmpty: { flexGrow: 1, justifyContent: "center", alignItems: "center" },
    emptyText: { color: theme.muted, fontSize: 14, textAlign: "center", paddingHorizontal: 32 },
    fileRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 14,
      paddingHorizontal: theme.pad,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
      position: "relative",
    },
    fileRowFirst: { borderTopWidth: 0 },
    fileRowDim: { opacity: 0.85 },
    iconWrap: { width: 28, alignItems: "center", justifyContent: "center", position: "relative" },
    iconText: { fontSize: 20, textAlign: "center" },
    stateDot: {
      position: "absolute",
      bottom: -2,
      right: -2,
      width: 9,
      height: 9,
      borderRadius: 5,
      backgroundColor: theme.primary,
      borderWidth: 1.5,
      borderColor: theme.bg,
    },
    rowMain: { flex: 1, minWidth: 0 },
    // name + optional pin marker side-by-side. Text shrinks
    // (numberOfLines={1}) and the pin icon stays anchored at the end.
    rowNameLine: { flexDirection: "row", alignItems: "center", minWidth: 0 },
    rowName: { color: theme.text, fontSize: 14, fontWeight: "500", flexShrink: 1 },
    rowPinMark: { marginLeft: 6 },
    rowMeta: { color: theme.muted, fontSize: 12, marginTop: 3 },
    kebabBtn: { paddingHorizontal: 6, paddingVertical: 8 },
    chevronBtn: {
      paddingHorizontal: 2,
      paddingVertical: 4,
      alignItems: "center",
      justifyContent: "center",
    },
    // Child row (file inside an expanded bundle).
    childRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 10,
      paddingHorizontal: theme.pad,
      paddingLeft: theme.pad + 28, // indent: aligns child icon under bundle name
      backgroundColor: theme.surfaceSubtle,
      position: "relative",
    },
    // Subtle vertical line on the left edge of the children block, linking
    // them visually to the parent bundle row.
    childAccent: {
      position: "absolute",
      left: theme.pad + 12,
      top: 0,
      bottom: 0,
      width: StyleSheet.hairlineWidth,
      backgroundColor: theme.border,
    },
    childIconWrap: { width: 22, alignItems: "center", justifyContent: "center" },
    childMain: { flex: 1, minWidth: 0 },
    childName: { color: theme.text, fontSize: 13, fontWeight: "500" },
    childMeta: { color: theme.muted, fontSize: 11, marginTop: 2 },
    childOpenBtn: {
      width: 44,
      height: 44,
      alignItems: "center",
      justifyContent: "center",
    },
    transferBar: {
      position: "absolute",
      bottom: 0,
      left: 0,
      right: 0,
      height: 2,
      backgroundColor: theme.primary,
    },
    error: { color: theme.danger, fontSize: 12, flex: 1 },
    errorRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: theme.pad,
      marginTop: 4,
    },
    retryBtn: {
      width: 32,
      height: 32,
      borderRadius: 8,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.surfaceSubtle,
      borderWidth: 1,
      borderColor: theme.border,
    },
    menuBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
    menuSheet: {
      backgroundColor: theme.bg,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      paddingTop: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
    },
    menuHandle: {
      alignSelf: "center",
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: theme.border,
      marginTop: 8,
      marginBottom: 4,
    },
    menuRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
      paddingHorizontal: 20,
      paddingVertical: 18,
      minHeight: 56,
    },
    menuRowText: { fontSize: 15, color: theme.text, fontWeight: "500" },
    menuRowDestructive: { color: theme.danger },
    menuDivider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.border,
      marginHorizontal: 20,
    },
    previewBackdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.5)",
      justifyContent: "center",
      padding: 12,
    },
    previewCard: {
      maxHeight: "92%",
      borderRadius: 16,
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.bg,
      padding: 14,
      gap: 10,
    },
    previewTitleRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
    },
    previewTitle: { color: theme.text, fontWeight: "700", fontSize: 16, flex: 1 },
    previewImage: { width: "100%", height: 360, borderRadius: 12, backgroundColor: theme.surfaceSubtle },
    previewVideo: { width: "100%", height: 360, borderRadius: 12, backgroundColor: "#000" },
    previewText: { color: theme.text, fontSize: 13, lineHeight: 20 },
    previewBtn: {
      backgroundColor: "transparent",
      borderWidth: 1,
      borderColor: theme.border,
      minWidth: 88,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      alignItems: "center",
      justifyContent: "center",
    },
    previewBtnText: { color: theme.text, fontWeight: "700", fontSize: 12 },
    previewFooter: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
    audioShell: {
      gap: 10,
      paddingTop: 4,
    },
    // Square cover placeholder keeps the audio modal's shape consistent
    // with image/video previews even when there's no album art to show.
    audioCover: {
      width: "100%",
      height: 220,
      borderRadius: 12,
      backgroundColor: theme.surfaceSubtle,
      borderWidth: 1,
      borderColor: theme.border,
      alignItems: "center",
      justifyContent: "center",
    },
    audioMeta: { color: theme.text, fontSize: 14, fontWeight: "600", textAlign: "center" },
    audioControlsRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 28,
      marginTop: 4,
    },
    audioCtrlBtn: {
      width: 48,
      height: 48,
      borderRadius: 24,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.surfaceSubtle,
      borderWidth: 1,
      borderColor: theme.border,
    },
    audioPlayBtn: {
      width: 60,
      height: 60,
      borderRadius: 30,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.primary,
    },
    audioScrubber: { height: 28, justifyContent: "center" },
    audioScrubberTrack: {
      height: 6,
      borderRadius: 999,
      backgroundColor: theme.surfaceSubtle,
      overflow: "hidden",
    },
    audioScrubberFill: { height: "100%", backgroundColor: theme.primary },
    audioTimeRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
    audioTimeText: { color: theme.muted, fontSize: 11, fontVariant: ["tabular-nums"] },
    // fullscreen takeover styles. Pure black background,
    // chrome floats over the media via absolute positioning.
    fsRoot: { flex: 1, backgroundColor: "#000" },
    fsMediaWrap: { flex: 1, alignItems: "center", justifyContent: "center" },
    fsVideo: { width: "100%", height: "100%" },
    fsImage: { width: "100%", height: "100%" },
    // Tap-surface that toggles play/pause + chrome. Sits over the video,
    // below the chrome icons (z-order: video → tap layer → chrome).
    fsTapLayer: { ...StyleSheet.absoluteFillObject as object },
    fsTopBar: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      // extra horizontal padding so the back arrow sits inboard,
      // not flush with the screen edge. Top inset added at render-time
      // via useSafeAreaInsets so the icon clears the status bar.
      paddingHorizontal: 12,
      paddingBottom: 16,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "flex-start",
      backgroundColor: "rgba(0,0,0,0.45)",
      // Make sure the chrome paints above the tap-layer regardless of any
      // child elevation quirks.
      zIndex: 10,
    },
    fsTopBtn: {
      // bigger touch target — was 44; bumped to 48 with extra
      // visual padding so the icon doesn't sit hard against the edge.
      width: 48,
      height: 48,
      alignItems: "center",
      justifyContent: "center",
    },
    fsShareBtnRow: {
      flexDirection: "row",
      justifyContent: "center",
      marginTop: 12,
    },
    fsShareBtn: {
      // fix: fixed width so "Share it" and "Stop sharing" don't
      // visually shift in size when toggled. Width chosen to comfortably
      // fit the longer label ("Stop sharing") with breathing room.
      width: 200,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      paddingVertical: 11,
      borderRadius: 999,
      backgroundColor: "rgba(255,255,255,0.10)",
      borderWidth: 1,
      borderColor: "rgba(255,255,255,0.20)",
    },
    fsShareBtnText: { color: "#fff", fontSize: 13, fontWeight: "600" },
    fsBottomBar: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      paddingHorizontal: 16,
      paddingTop: 14,
      paddingBottom: 18,
      backgroundColor: "rgba(0,0,0,0.45)",
    },
    fsScrubber: { height: 28, justifyContent: "center" },
    fsScrubberTrack: {
      height: 4,
      borderRadius: 999,
      backgroundColor: "rgba(255,255,255,0.25)",
      overflow: "hidden",
    },
    fsScrubberFill: { height: "100%", backgroundColor: "#fff" },
    fsTimeRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      marginTop: 6,
    },
    fsTimeText: {
      color: "rgba(255,255,255,0.85)",
      fontSize: 11,
      fontVariant: ["tabular-nums"],
    },
    fsCenterPlay: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      alignItems: "center",
      justifyContent: "center",
    },
    fsCenterPlayBtn: {
      width: 76,
      height: 76,
      borderRadius: 38,
      backgroundColor: "rgba(0,0,0,0.45)",
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: "rgba(255,255,255,0.35)",
    },
    // Audio takeover: centered cover + controls below. No auto-hide.
    fsAudioShell: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 24,
      gap: 18,
    },
    fsAudioCover: {
      width: "60%",
      aspectRatio: 1,
      maxWidth: 320,
      borderRadius: 16,
      backgroundColor: "rgba(255,255,255,0.05)",
      borderWidth: 1,
      borderColor: "rgba(255,255,255,0.12)",
      alignItems: "center",
      justifyContent: "center",
    },
    fsAudioMeta: { color: "rgba(255,255,255,0.92)", fontSize: 15, fontWeight: "600" },
    fsAudioControlsRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 28,
      marginTop: 4,
    },
    fsAudioCtrlBtn: {
      width: 48,
      height: 48,
      borderRadius: 24,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "rgba(255,255,255,0.08)",
      borderWidth: 1,
      borderColor: "rgba(255,255,255,0.18)",
    },
    fsAudioPlayBtn: {
      width: 64,
      height: 64,
      borderRadius: 32,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "#fff",
    },
    fsAudioScrubberRow: { alignSelf: "stretch", marginTop: 12 },
    // Text takeover uses theme.bg for readability rather than pure black.
    fsTextRoot: { flex: 1, backgroundColor: theme.bg },
    fsTextScroll: { flex: 1, paddingHorizontal: 20, paddingTop: 64 },
    fsTextBody: { color: theme.text, fontSize: 14, lineHeight: 22 },
    // Three-dots action sheet — reuses the bottom-sheet pattern.
    fsMenuBackdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.5)",
      justifyContent: "flex-end",
    },
    fsMenuSheet: {
      backgroundColor: theme.bg,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      paddingTop: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
    },
  });
}

// child row with the per-file completion blink. Lives as a
// sibling component so each row owns its own Animated.Value lifecycle.
type ChildRowProps = {
  theme: AppTheme;
  styles: ReturnType<typeof createStyles>;
  iconName: IconName;
  displayName: string;
  metaText: string;
  dim: boolean;
  /** when this transitions true the row runs a one-shot ~700 ms
   *  soft flash. Used for the per-file completion blink (Highlight B). */
  blink: boolean;
  onTap: () => void;
  rightIcon: IconName | "arrow-down-circle-outline" | "open-outline" | null;
  onRightIconPress?: () => void;
};

function ChildRow({
  theme,
  styles,
  iconName,
  displayName,
  metaText,
  dim,
  blink,
  onTap,
  rightIcon,
  onRightIconPress,
}: ChildRowProps) {
  const highlight = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!blink) return;
    // Native driver: opacity is supported. Keeps the flash off the JS
    // thread, which matters when multiple rows blink at once.
    highlight.setValue(0);
    const seq = Animated.sequence([
      Animated.timing(highlight, { toValue: 1, duration: 180, useNativeDriver: true }),
      Animated.delay(260),
      Animated.timing(highlight, { toValue: 0, duration: 360, useNativeDriver: true }),
    ]);
    seq.start();
    return () => seq.stop();
  }, [blink, highlight]);

  // soft, rounded blink. An opacity-animated overlay sits on top
  // of the row content at ~14% peak opacity — gentle tint instead of a
  // saturated wash. pointerEvents="none" so taps pass through to the row.
  const overlayOpacity = highlight.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 0.14],
  });

  return (
    <View style={{ position: "relative" }}>
      <Pressable
        style={[styles.childRow, dim && styles.fileRowDim]}
        onPress={onTap}
        accessibilityRole="button"
        accessibilityLabel={displayName}
      >
        <View style={styles.childAccent} />
        <View style={styles.childIconWrap}>
          <Ionicons name={iconName} size={20} color={theme.muted} />
        </View>
        <View style={styles.childMain}>
          <Text style={styles.childName} numberOfLines={1}>
            {displayName}
          </Text>
          <Text style={styles.childMeta} numberOfLines={1}>
            {metaText}
          </Text>
        </View>
        {rightIcon && onRightIconPress ? (
          <Pressable
            style={styles.childOpenBtn}
            onPress={onRightIconPress}
            accessibilityRole="button"
            accessibilityLabel={
              rightIcon === "arrow-down-circle-outline"
                ? `Grab ${displayName}`
                : `Open ${displayName} in another app`
            }
          >
            <Ionicons name={rightIcon as IconName} size={20} color={theme.muted} />
          </Pressable>
        ) : null}
      </Pressable>
      <Animated.View
        pointerEvents="none"
        style={{
          position: "absolute",
          top: 4,
          left: 12,
          right: 12,
          bottom: 4,
          borderRadius: 12,
          backgroundColor: theme.primary,
          opacity: overlayOpacity,
        }}
      />
    </View>
  );
}

export default function MainScreen() {
  const insets = useSafeAreaInsets();
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const navigation = useNavigation<any>();

  const {
    ready,
    drives,
    transfers,
    activeDriveIds,
    failedHydrationIds,
    sharePaths,
    cancelTransfer,
    activateDrive,
    deactivateDrive,
    refreshDrives,
  } = useBackend();

  const {
    linkDraft,
    setLinkDraft,
    resolving,
    linkError,
    setQrVisible,
    retryResolve,
    setPendingPreselection,
    abortResolving,
    lastCompletedDownload,
    consumeCompletedDownload,
  } = useShareLinkFlow();

  const { show: showToastRaw } = useToast();
  const showToast = useCallback(
    (msg: string, kind: "info" | "success" | "error" = "info") =>
      showToastRaw(msg, { kind }),
    [showToastRaw],
  );

  const [pickerSheet, setPickerSheet] = useState<PickerSheet>(null);
  const [kebabSheet, setKebabSheet] = useState<KebabSheet>(null);
  const [shareBusy, setShareBusy] = useState(false);
  const [qrDriveId, setQrDriveId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewText, setPreviewText] = useState("");
  // Themed delete confirmation. Holds the drive pending deletion or null.
  // Replaces the native Alert.alert so the dialog matches the app theme.
  const [pendingDelete, setPendingDelete] = useState<DriveRow | null>(null);
  const [audioPosition, setAudioPosition] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [scrubWidth, setScrubWidth] = useState(0);
  // fullscreen takeover preview state.
  const [videoIsPlaying, setVideoIsPlaying] = useState(false);
  const [videoPosition, setVideoPosition] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoScrubWidth, setVideoScrubWidth] = useState(0);
  const [chromeVisible, setChromeVisible] = useState(true);
  const chromeOpacity = useRef(new Animated.Value(1)).current;
  const chromeHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Drive IDs hidden from the UI because the user just confirmed delete —
  // engine purge is in-flight. Removed from the set once the engine's
  // drives list no longer contains the ID (refreshDrives caught up).
  const [optimisticallyDeleted, setOptimisticallyDeleted] = useState<Set<string>>(
    () => new Set(),
  );
  // Bumps every time a swipe-then-confirm flow opens — triggers SwipeableRow
  // to snap closed whether the user confirms or cancels.
  const [swipeCloseTick, setSwipeCloseTick] = useState(0);
  // single bundle expanded at a time. Tapping the same bundle
  // again collapses it; tapping a different one switches the expansion.
  const [expandedBundleId, setExpandedBundleId] = useState<string | null>(null);
  const [sharedPaths, setSharedPaths] = useState<SharedFilePathsEntry[]>([]);
  const [receivedShares, setReceivedShares] = useState<ReceivedShare[]>([]);
  const [hostedFlags, setHostedFlags] = useState<HostedShareFlags[]>([]);
  // view-mode toggle. Always resets to "all" on mount — intentional;
  // no persistence to AsyncStorage. Favorites is a filterable subset.
  const [viewMode, setViewMode] = useState<"all" | "favorites">("all");
  // /3M: target set for the post-grab child-row blink. Populated
  // by an effect that watches `lastCompletedDownload`. If the share's
  // bundle is collapsed when the signal fires, the effect first expands
  // it (via setExpandedBundleId), waits for the layout animation to
  // settle, then sets the blink target so the user sees the rows arrive
  // AND blink in sequence.
  const [childBlinkTarget, setChildBlinkTarget] = useState<{
    shareKey: string;
    names: Set<string>;
  } | null>(null);

  // Subscribe to the RN-side cache-path side-store. Hosted drives don't
  // carry localFiles in the engine manifest (engine doesn't know about the
  // user's cache copies); this storage fills that gap.
  useEffect(() => {
    void loadSharedFilePaths().then(setSharedPaths);
    return subscribeSharedFilePaths(setSharedPaths);
  }, []);

  // subscribe to the per-share storage so received bundles re-
  // render in place when downloads complete and flip files' isDownloaded.
  useEffect(() => {
    void loadShares().then(setReceivedShares);
    return subscribeShares(setReceivedShares);
  }, []);

  // subscribe to hosted-share organizational flags so toggling
  // pin/favorite re-renders the list (and re-sorts) immediately.
  useEffect(() => {
    void loadHostedFlags().then(setHostedFlags);
    return subscribeHostedFlags(setHostedFlags);
  }, []);

  const hostedFlagsByDriveId = useMemo(() => {
    const m = new Map<string, HostedShareFlags>();
    for (const f of hostedFlags) m.set(f.driveId, f);
    return m;
  }, [hostedFlags]);

  // when a grab completes (newly-fetched or all already-on-disk),
  // expand the bundle if collapsed, then blink the selected rows. The
  // bundle row itself never blinks — the row-arrives motion plus the child
  // blink carries the acknowledgment.
  // Timer refs persist across the re-renders that `consumeCompletedDownload`
  // and `setExpandedBundleId` trigger. If the dep-driven effect returned a
  // cleanup that cancelled the timers, the very re-render caused by this
  // effect's own state mutations would clobber the schedule before the
  // blink fired. Refs let us cancel only on explicit re-trigger + unmount.
  const blinkStartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blinkClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (blinkStartTimerRef.current) clearTimeout(blinkStartTimerRef.current);
      if (blinkClearTimerRef.current) clearTimeout(blinkClearTimerRef.current);
    };
  }, []);
  useEffect(() => {
    if (!lastCompletedDownload) return;
    const synthId = `share:${lastCompletedDownload.shareKey}`;
    const names = new Set(lastCompletedDownload.names.map((n) => baseName(n)));
    const shareKey = lastCompletedDownload.shareKey;
    const alreadyExpanded = expandedBundleId === synthId;
    if (blinkStartTimerRef.current) clearTimeout(blinkStartTimerRef.current);
    if (blinkClearTimerRef.current) clearTimeout(blinkClearTimerRef.current);
    consumeCompletedDownload();
    if (!alreadyExpanded) {
      LayoutAnimation.configureNext({
        duration: 220,
        create: { type: "easeInEaseOut", property: "opacity" },
        update: { type: "easeInEaseOut" },
        delete: { type: "easeInEaseOut", property: "opacity" },
      });
      setExpandedBundleId(synthId);
    }
    // Slight delay when expanding so the child rows are mounted by the
    // time the blink animation starts. Immediate when already expanded.
    const blinkDelay = alreadyExpanded ? 0 : 240;
    blinkStartTimerRef.current = setTimeout(() => {
      setChildBlinkTarget({ shareKey, names });
    }, blinkDelay);
    blinkClearTimerRef.current = setTimeout(
      () => setChildBlinkTarget(null),
      blinkDelay + 900,
    );
  }, [lastCompletedDownload, expandedBundleId, consumeCompletedDownload]);

  const sharedPathsByDriveId = useMemo(() => {
    const m = new Map<string, SharedFilePath[]>();
    for (const e of sharedPaths) m.set(e.driveId, e.files);
    return m;
  }, [sharedPaths]);

  // Sort: most recent activity first. Active state does not affect ordering
  // items don't jump as they transition.
  // two sources merged into one list.
  // Hosted drives: engine manifest (origin === "hosted"). `localFiles`
  //     synthesized from sharedFilePathsStorage so previewing hosted files
  //     works the same way as received.
  // Received shares: receivedSharesStorage entries — one row per share
  //     key regardless of how many engine drives that share has produced.
  // The engine's received-side drives are intentionally hidden here —
  // they're a per-paste session detail, not a logical row in the list.
  const sortedDrives: DriveRow[] = useMemo(() => {
    const list: DriveRow[] = [];

    for (const d of drives ?? []) {
      if (d.origin === "received") continue;
      if (optimisticallyDeleted.has(d.id)) continue;
      let local = d.localFiles;
      const paths = sharedPathsByDriveId.get(d.id);
      if (paths && paths.length > 0) {
        local = paths.map((p) => ({
          name: p.name,
          path: p.localPath,
          size: p.size ?? 0,
        }));
      }
      const flags = hostedFlagsByDriveId.get(d.id);
      const enriched: DriveRow = {
        ...d,
        localFiles: local,
        isBundle: (d.files?.length ?? 0) > 1,
        isPinned: !!flags?.isPinned,
        isFavorite: !!flags?.isFavorite,
      };
      enriched.primaryFile = rowPrimaryFile(enriched);
      list.push(enriched);
    }

    for (const share of receivedShares) {
      const synthId = `share:${share.shareKey}`;
      if (optimisticallyDeleted.has(synthId)) continue;
      const localFiles: DriveLocalFile[] = share.files
        .filter((f) => f.isDownloaded && !!f.localPath)
        .map((f) => ({
          name: f.name,
          path: f.localPath as string,
          size: f.size,
        }));
      const fileEntries = share.files.map((f) => ({
        name: f.name,
        storagePath: f.path,
        size: f.size,
      }));
      const row: DriveRow = {
        id: synthId,
        key: share.shareKey,
        shareLink: share.shareLink,
        name: share.shareName,
        state: "inactive",
        origin: "received",
        isUpload: false,
        totalBytes: share.files.reduce((a, f) => a + (f.size ?? 0), 0),
        files: fileEntries,
        localFiles,
        createdAt: share.firstSeenAt,
        lastActivityAt: share.lastUpdatedAt,
        isBundle: share.files.length > 1,
        share,
        isPinned: !!share.isPinned,
        isFavorite: !!share.isFavorite,
      };
      row.primaryFile = rowPrimaryFile(row);
      list.push(row);
    }

    // two-level sort — pinned shares first, then recency within
    // each group. Applies in both the All and Favorites views.
    list.sort((a, b) => {
      const pa = a.isPinned ? 1 : 0;
      const pb = b.isPinned ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0);
    });
    return list;
  }, [drives, sharedPathsByDriveId, optimisticallyDeleted, receivedShares, hostedFlagsByDriveId]);

  // viewMode filter applied AFTER sort. Filtering before sort
  // would work too — order is independent — but doing it after keeps the
  // sort comparator unaware of view mode.
  const visibleDrives = useMemo<DriveRow[]>(() => {
    if (viewMode === "favorites") {
      return sortedDrives.filter((d) => d.isFavorite);
    }
    return sortedDrives;
  }, [sortedDrives, viewMode]);

  // Reconcile the optimistic-delete set: drop any ID the engine has already
  // pruned from its drives list (purge round-trip complete). Without this
  // the set would grow forever in long sessions.
  useEffect(() => {
    if (optimisticallyDeleted.size === 0) return;
    const live = new Set((drives ?? []).map((d) => d.id));
    let changed = false;
    const next = new Set<string>();
    for (const id of optimisticallyDeleted) {
      if (live.has(id)) {
        next.add(id);
      } else {
        changed = true;
      }
    }
    if (changed) setOptimisticallyDeleted(next);
  }, [drives, optimisticallyDeleted]);

  // /3J: flatten the drive list, splicing child rows directly
  // after the currently-expanded bundle.
  // Hosted bundles: derive from `files[]` joined to `localFiles[]`
  //    (index match preferred, name match as fallback).
  // Received bundles: derive from `share.files[]`, which carries per-file
  //    `isDownloaded` + `localPath`. Files not yet downloaded surface as
  //    `isMissing: true` so the tap-to-regrab affordance lights up.
  const flattenedList = useMemo<ListItem[]>(() => {
    const out: ListItem[] = [];
    for (const d of visibleDrives) {
      out.push({ kind: "drive", drive: d, expanded: expandedBundleId === d.id });
      if (expandedBundleId !== d.id || !d.isBundle) continue;
      if (d.share) {
        // Received-share children carry isDownloaded inline.
        d.share.files.forEach((f, i) => {
          out.push({
            kind: "child",
            parentId: d.id,
            indexInBundle: i,
            name: f.name,
            size: f.size,
            localPath: f.isDownloaded ? f.localPath : undefined,
            isMissing: !f.isDownloaded,
            shareKey: d.share?.shareKey,
            shareLink: d.share?.shareLink,
          });
        });
      } else {
        const localFiles = d.localFiles ?? [];
        const localByName = new Map<string, DriveLocalFile>();
        for (const lf of localFiles) localByName.set(baseName(lf.name), lf);
        (d.files ?? []).forEach((f, i) => {
          const byIndex = localFiles[i];
          const byName = localByName.get(baseName(f.name));
          const local =
            byIndex && baseName(byIndex.name) === baseName(f.name)
              ? byIndex
              : byName ?? byIndex;
          out.push({
            kind: "child",
            parentId: d.id,
            indexInBundle: i,
            name: f.name,
            size: f.size,
            localPath: local?.path,
          });
        });
      }
    }
    return out;
  }, [visibleDrives, expandedBundleId]);

  // Auto-refresh on mount + when ready flips on.
  useEffect(() => {
    if (ready) void refreshDrives();
  }, [ready, refreshDrives]);

  // Resolve which drive is highlighted in the QR/info modal.
  const qrDrive = useMemo(
    () => (qrDriveId ? sortedDrives.find((d) => d.id === qrDriveId) : undefined),
    [sortedDrives, qrDriveId],
  );

  // Preview player wiring.
  // resolve the preview's parent drive so the bottom share/
  // stop-sharing button knows the active state + identity to toggle.
  // Returns null if the parent was a received-share synth row — those
  // don't expose a clean activate path in this sprint, so we omit the
  // button for them.
  const previewParentDrive = useMemo(() => {
    if (!preview?.parentDriveId) return null;
    const found = sortedDrives.find((d) => d.id === preview.parentDriveId);
    if (!found) return null;
    if (found.share) return null; // received synth — no share-toggle
    return found;
  }, [sortedDrives, preview?.parentDriveId]);
  const previewParentIsActive = !!previewParentDrive && activeDriveIds.has(previewParentDrive.id);

  const previewUri = useMemo(() => {
    if (!preview?.file) return null;
    return preview.file.path.startsWith("file://")
      ? preview.file.path
      : `file://${preview.file.path}`;
  }, [preview]);
  const audioUri = preview?.mode === "audio" ? previewUri : null;
  const videoUri = preview?.mode === "video" ? previewUri : null;
  const audioPlayer = useAudioPlayer(audioUri);
  const audioStatus = useAudioPlayerStatus(audioPlayer);
  const videoPlayer = useVideoPlayer(videoUri, (p) => {
    p.loop = false;
  });

  // Poll audio currentTime / duration at 4 Hz while audio preview is open.
  // expo-audio exposes `playing` reactively but not currentTime; we read it
  // directly from the player at a steady cadence to drive the scrubber.
  useEffect(() => {
    if (preview?.mode !== "audio" || !audioPlayer) {
      setAudioPosition(0);
      setAudioDuration(0);
      return;
    }
    const tick = () => {
      try {
        const pos = Number(audioPlayer.currentTime || 0);
        const dur = Number(audioPlayer.duration || 0);
        if (Number.isFinite(pos)) setAudioPosition(pos);
        if (Number.isFinite(dur) && dur > 0) setAudioDuration(dur);
      } catch {
        // expo-audio can throw mid-dispose; next tick resyncs.
      }
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [preview?.mode, audioPlayer]);

  const onAudioSkip = useCallback(
    (deltaSeconds: number) => {
      if (!audioPlayer) return;
      try {
        const dur = Number(audioPlayer.duration || audioDuration || 0);
        const cur = Number(audioPlayer.currentTime || audioPosition || 0);
        const next = Math.max(0, Math.min(dur || cur + deltaSeconds, cur + deltaSeconds));
        audioPlayer.seekTo(next);
        setAudioPosition(next);
      } catch {
        // ignore — next poll tick will resync
      }
    },
    [audioPlayer, audioDuration, audioPosition],
  );

  const onAudioSeekToFraction = useCallback(
    (fraction: number) => {
      if (!audioPlayer) return;
      const dur = Number(audioPlayer.duration || audioDuration || 0);
      if (!Number.isFinite(dur) || dur <= 0) return;
      const target = Math.max(0, Math.min(dur, dur * fraction));
      try {
        audioPlayer.seekTo(target);
        setAudioPosition(target);
      } catch {
        // ignore — next poll tick will resync
      }
    },
    [audioPlayer, audioDuration],
  );

  // poll video currentTime / duration / playing at 4 Hz while
  // the takeover is open, mirroring the audio pattern. expo-video doesn't
  // expose a reactive playing flag we can subscribe to without useEvent.
  useEffect(() => {
    if (preview?.mode !== "video" || !videoPlayer) {
      setVideoIsPlaying(false);
      setVideoPosition(0);
      setVideoDuration(0);
      return;
    }
    const tick = () => {
      try {
        setVideoIsPlaying(!!videoPlayer.playing);
        const pos = Number(videoPlayer.currentTime || 0);
        const dur = Number(videoPlayer.duration || 0);
        if (Number.isFinite(pos)) setVideoPosition(pos);
        if (Number.isFinite(dur) && dur > 0) setVideoDuration(dur);
      } catch {
        // expo-video can throw mid-dispose; next tick resyncs.
      }
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [preview?.mode, videoPlayer]);

  // chrome auto-hide for the video takeover. Chrome stays
  // visible while paused (the user is engaging); when playing, fades out
  // after 3 s of no taps. Any tap on the video tap-surface fades it back
  // in and resets the timer. Other media types (audio/image/text) keep
  // chrome visible always — `scheduleChromeHide` is a no-op outside video.
  const scheduleChromeHide = useCallback(() => {
    if (chromeHideTimerRef.current) {
      clearTimeout(chromeHideTimerRef.current);
      chromeHideTimerRef.current = null;
    }
    if (preview?.mode !== "video" || !videoIsPlaying) return;
    chromeHideTimerRef.current = setTimeout(() => {
      Animated.timing(chromeOpacity, {
        toValue: 0,
        duration: 250,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setChromeVisible(false);
      });
    }, 3000);
  }, [preview?.mode, videoIsPlaying, chromeOpacity]);

  const showChrome = useCallback(() => {
    setChromeVisible(true);
    Animated.timing(chromeOpacity, {
      toValue: 1,
      duration: 150,
      useNativeDriver: true,
    }).start();
    scheduleChromeHide();
  }, [chromeOpacity, scheduleChromeHide]);

  // Reset chrome state every time the preview opens / changes mode, and
  // reschedule the hide whenever playing-state flips while in video mode.
  useEffect(() => {
    if (!preview) {
      if (chromeHideTimerRef.current) {
        clearTimeout(chromeHideTimerRef.current);
        chromeHideTimerRef.current = null;
      }
      chromeOpacity.setValue(1);
      setChromeVisible(true);
      return;
    }
    chromeOpacity.setValue(1);
    setChromeVisible(true);
    scheduleChromeHide();
  }, [preview, videoIsPlaying, scheduleChromeHide, chromeOpacity]);

  const closePreview = useCallback(() => {
    if (audioPlayer?.playing) audioPlayer.pause();
    if (videoPlayer?.playing) videoPlayer.pause();
    setPreview(null);
    setPreviewText("");
    if (chromeHideTimerRef.current) {
      clearTimeout(chromeHideTimerRef.current);
      chromeHideTimerRef.current = null;
    }
  }, [audioPlayer, videoPlayer]);

  // Tap surface on the video toggles playback AND keeps chrome visible.
  // OS-player-style: tapping the video is the primary pause/play gesture
  // once a video is going. The center play button still works for the
  // "I just opened this and it's paused" case.
  const onVideoTap = useCallback(() => {
    showChrome();
    if (!videoPlayer) return;
    try {
      if (videoPlayer.playing) videoPlayer.pause();
      else videoPlayer.play();
    } catch {
      // expo-video can throw mid-dispose; ignore.
    }
  }, [videoPlayer, showChrome]);

  const onVideoSeekToFraction = useCallback(
    (fraction: number) => {
      if (!videoPlayer) return;
      const dur = Number(videoPlayer.duration || videoDuration || 0);
      if (!Number.isFinite(dur) || dur <= 0) return;
      const target = Math.max(0, Math.min(dur, dur * fraction));
      try {
        videoPlayer.currentTime = target;
        setVideoPosition(target);
        showChrome();
      } catch {
        // ignore
      }
    },
    [videoPlayer, videoDuration, showChrome],
  );

  const onOpenFile = useCallback(
    async (path: string) => {
      try {
        const fileUri = path.startsWith("file://") ? path : `file://${path}`;
        if (Platform.OS === "android") {
          const contentUri = await FileSystemLegacy.getContentUriAsync(fileUri);
          await IntentLauncher.startActivityAsync("android.intent.action.VIEW", {
            data: contentUri,
            flags: 1,
            type: mimeFromName(baseName(path)),
          });
          return;
        }
        await Linking.openURL(fileUri);
      } catch (e: unknown) {
        showToast(`Can't open that one — ${String((e as Error)?.message || e)}`, "error");
      }
    },
    [showToast],
  );

  // accordion expansion. LayoutAnimation makes the splice/un-splice
  // of child rows feel like a slide rather than a snap. Same easing for
  // both directions; ~220 ms hit the brief's sweet spot.
  const toggleExpand = useCallback((driveId: string) => {
    LayoutAnimation.configureNext({
      duration: 220,
      create: { type: "easeInEaseOut", property: "opacity" },
      update: { type: "easeInEaseOut" },
      delete: { type: "easeInEaseOut", property: "opacity" },
    });
    setExpandedBundleId((cur) => (cur === driveId ? null : driveId));
  }, []);

  const previewFile = useCallback(
    async (file: DriveLocalFile, parentDriveId?: string) => {
      // Cache-eviction guard. If the local copy is gone we surface a clear
      // toast instead of opening an empty preview that never resolves.
      let exists = true;
      try {
        exists = await RNFS.exists(file.path);
      } catch {
        exists = false;
      }
      if (!exists) {
        showToast("This file is no longer available locally.", "error");
        return;
      }
      const mode = previewModeFor(file.name);
      if (mode === "unsupported") {
        await onOpenFile(file.path);
        return;
      }
      if (audioPlayer?.playing) audioPlayer.pause();
      if (videoPlayer?.playing) videoPlayer.pause();
      setPreview({ file, mode, parentDriveId });
      if (mode === "text") {
        try {
          const txt = await RNFS.readFile(file.path, "utf8");
          setPreviewText(txt.slice(0, 4000));
        } catch (e: unknown) {
          setPreviewText(`Can't preview this one — ${String((e as Error)?.message || e)}`);
        }
      }
    },
    [audioPlayer, videoPlayer, onOpenFile, showToast],
  );

  const onTapRow = useCallback(
    async (drive: DriveRow) => {
      // Bundles expand instead of previewing — there's no single content to
      // show. The kebab continues to surface More info / Share it / Delete.
      if (drive.isBundle) {
        toggleExpand(drive.id);
        return;
      }
      const primary = drive.primaryFile;
      if (!primary) {
        // Single-file drive with no resolvable local copy (e.g. an inactive
        // received drive that lost its file, or an active hosted drive
        // whose cache eviction beat the user to the tap). Open the info
        // modal so the user can still see status / activate / delete.
        setQrDriveId(drive.id);
        return;
      }
      await previewFile(primary, drive.id);
    },
    [previewFile, toggleExpand],
  );

  async function onPickAndShare() {
    setPickerSheet(null);
    setShareBusy(true);
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: "*/*",
        copyToCacheDirectory: true,
        multiple: true,
      });
      if (res.canceled) return;
      const files = selectFiles(res);
      if (!files.length) {
        showToast("Nothing picked.");
        return;
      }
      const out = await sharePaths(files.map((f) => f.uri));
      if (!out.ok || !out.shareLink) {
        showToast("Couldn't create that share — give it another go?", "error");
        return;
      }
      // remember the cache-dir source paths so the row
      // body and child rows can preview / open these files.
      if (out.driveId) {
        void saveSharedFilePathsEntry({
          driveId: out.driveId,
          files: files.map((f) => ({
            name: f.name,
            localPath: normalizeLocalPath(f.uri),
            size: f.size,
          })),
          savedAt: Date.now(),
        });
      }
      haptics.success();
      void refreshDrives();
      if (out.driveId) setQrDriveId(out.driveId);
    } catch (e: unknown) {
      showToast(`Couldn't share — ${String((e as Error)?.message || e)}`, "error");
    } finally {
      setShareBusy(false);
    }
  }

  async function onPickFolderAndShare() {
    setPickerSheet(null);
    setShareBusy(true);
    try {
      const dir = await pickFolder();
      if (!dir) return;
      let enumerated;
      try {
        enumerated = await enumerateFolder(dir, { maxFiles: 1000 });
      } catch (err) {
        if (err instanceof FolderTooLargeError) {
          showToast(`Folder is too big to share (limit: ${err.limit}).`, "error");
          return;
        }
        throw err;
      }
      if (!enumerated.length) {
        showToast("That folder had nothing to share.");
        return;
      }
      const paths = enumerated.map((f) => f.uri);
      const relPaths = enumerated.map((f) => f.relPath);
      const out = await sharePaths(paths, relPaths);
      if (!out.ok || !out.shareLink) {
        showToast("Couldn't share that folder.", "error");
        return;
      }
      if (out.driveId) {
        void saveSharedFilePathsEntry({
          driveId: out.driveId,
          files: enumerated.map((f) => ({
            name: f.relPath || f.name,
            localPath: normalizeLocalPath(f.uri),
            size: f.size,
          })),
          savedAt: Date.now(),
        });
      }
      haptics.success();
      void refreshDrives();
      if (out.driveId) setQrDriveId(out.driveId);
    } catch (e: unknown) {
      showToast(`Folder error: ${String((e as Error)?.message || e)}`, "error");
    } finally {
      setShareBusy(false);
    }
  }

  async function onPickPhotosAndShare() {
    setPickerSheet(null);
    setShareBusy(true);
    try {
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsMultipleSelection: true,
        quality: 1,
        allowsEditing: false,
        selectionLimit: 0,
        exif: false,
        base64: false,
      });
      if (res.canceled) return;
      const files = (res.assets ?? [])
        .filter((a) => !!a.uri)
        .map((a) => ({
          name: a.fileName || a.uri.split("/").pop() || `photo_${Date.now()}.jpg`,
          size: typeof a.fileSize === "number" ? a.fileSize : undefined,
          uri: a.uri,
        }));
      if (!files.length) {
        showToast("No photos picked.");
        return;
      }
      const out = await sharePaths(files.map((f) => f.uri));
      if (!out.ok || !out.shareLink) {
        showToast("Couldn't create that share.", "error");
        return;
      }
      if (out.driveId) {
        void saveSharedFilePathsEntry({
          driveId: out.driveId,
          files: files.map((f) => ({
            name: f.name,
            localPath: normalizeLocalPath(f.uri),
            size: f.size,
          })),
          savedAt: Date.now(),
        });
      }
      haptics.success();
      void refreshDrives();
      if (out.driveId) setQrDriveId(out.driveId);
    } catch (e: unknown) {
      showToast(`Photo share error: ${String((e as Error)?.message || e)}`, "error");
    } finally {
      setShareBusy(false);
    }
  }

  async function onShareIt(drive: DriveRow) {
    setKebabSheet(null);
    const res = await activateDrive(drive.id);
    if (!res.ok) {
      showToast(errorMessage(res.error) || "Couldn't activate that one.", "error");
      return;
    }
    haptics.success();
    setQrDriveId(drive.id);
    void refreshDrives();
  }

  async function onStopSharing(drive: DriveRow) {
    setKebabSheet(null);
    const res = await deactivateDrive(drive.id);
    if (!res.ok) {
      showToast(errorMessage(res.error) || "Couldn't stop that one.", "error");
      return;
    }
    haptics.actionDone();
    showToast("Stopped sharing.");
    void refreshDrives();
  }

  // unified pin / favorite toggles. Route to the right storage
  // based on the share's origin. Received shares carry the flags on their
  // ReceivedShare record; hosted drives go through the hostedShareFlags
  // side-store keyed by engine driveId.
  const togglePinned = useCallback((drive: DriveRow) => {
    const next = !drive.isPinned;
    if (drive.share) {
      void setSharePinned(drive.share.shareKey, next);
    } else {
      void setHostedSharePinned(drive.id, next);
    }
    haptics.actionDone();
  }, []);

  const toggleFavorite = useCallback((drive: DriveRow) => {
    const next = !drive.isFavorite;
    if (drive.share) {
      void setShareFavorite(drive.share.shareKey, next);
    } else {
      void setHostedShareFavorite(drive.id, next);
    }
    haptics.actionDone();
  }, []);

  // Actual destructive operation — no confirmation prompt. Callers must
  // confirm with the user via ConfirmModal before invoking this. The row
  // disappears from the list immediately; engine purge + manifest refresh
  // happen in the background.
  const performDelete = useCallback(
    (drive: DriveRow) => {
      const id = drive.id;
      LayoutAnimation.configureNext({
        duration: 200,
        create: { type: "easeInEaseOut", property: "opacity" },
        update: { type: "easeInEaseOut" },
        delete: { type: "easeInEaseOut", property: "opacity" },
      });
      setOptimisticallyDeleted((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      setExpandedBundleId((cur) => (cur === id ? null : cur));
      haptics.actionDone();
      showToast("Deleted.");
      if (drive.share) {
        // received share. Drop the per-share record, then purge
        // every engine drive whose key matches — the share may have produced
        // several short-lived engine drive entries across re-pastes.
        const shareKey = drive.share.shareKey;
        void deleteShare(shareKey);
        const matchingEngineIds = (drives ?? [])
          .filter((d) => d.origin === "received" && d.key === shareKey)
          .map((d) => d.id);
        for (const eid of matchingEngineIds) {
          void cancelTransfer(eid, { purge: true });
        }
        void refreshDrives();
      } else {
        // Hosted drive — the existing fire-and-forget engine purge.
        void cancelTransfer(id, { purge: true }).then(() => {
          void refreshDrives();
        });
        void removeSharedFilePaths(id);
        // drop the organizational flags too — a future fresh
        // share that happens to reuse the driveId shouldn't inherit them.
        void clearHostedShareFlags(id);
      }
    },
    [cancelTransfer, drives, refreshDrives, showToast],
  );

  const onDelete = useCallback((drive: DriveRow) => {
    setKebabSheet(null);
    setPendingDelete(drive);
    // Whatever the user picks in the confirm, the swipe should snap closed.
    // Bump the signal now so SwipeableRow runs its close animation while the
    // modal is up — by the time the modal dismisses, the row is at rest.
    setSwipeCloseTick((t) => t + 1);
  }, []);

  async function onCopyLink(link: string) {
    if (!link) return;
    await Clipboard.setStringAsync(link);
    haptics.actionDone();
    showToast("Link copied.", "success");
  }

  async function onShareLink(link: string) {
    if (!link) return;
    try {
      await Share.share({ message: link });
    } catch {
      // Sheet dismissed — nothing to recover from.
    }
  }

  const transferByDriveId = useMemo(() => {
    const m = new Map<string, (typeof transfers)[number]>();
    for (const t of transfers) m.set(t.driveId, t);
    return m;
  }, [transfers]);

  const renderRow: ListRenderItem<ListItem> = useCallback(
    ({ item, index }) => {
      if (item.kind === "child") {
        const previewable = previewModeFor(item.name) !== "unsupported";
        const hasLocal = !!item.localPath;
        const isMissing = !!item.isMissing;
        const childIconName = fileIconName(item.name);
        const childMetaText = isMissing
          ? `${formatBytes(item.size ?? 0)} · tap to grab`
          : `${formatBytes(item.size ?? 0)} · ${
              previewable && hasLocal
                ? "tap to preview"
                : hasLocal
                  ? "tap to open"
                  : "not on this device"
            }`;
        const onChildTap = () => {
          if (isMissing && item.shareLink) {
            // smart re-grab. Fill the input + pre-select this file
            // + let the existing debounced auto-resolve open the preview.
            setPendingPreselection([item.name]);
            setLinkDraft(item.shareLink);
            return;
          }
          if (!hasLocal || !item.localPath) {
            showToast("This file is no longer available locally.", "error");
            return;
          }
          void previewFile(
            {
              name: baseName(item.name),
              path: item.localPath,
              size: item.size ?? 0,
            },
            item.parentId,
          );
        };
        const blink =
          !!childBlinkTarget &&
          item.shareKey === childBlinkTarget.shareKey &&
          childBlinkTarget.names.has(baseName(item.name));
        return (
          <ChildRow
            theme={theme}
            styles={styles}
            iconName={childIconName}
            displayName={baseName(item.name)}
            metaText={childMetaText}
            dim={isMissing || !hasLocal}
            blink={blink}
            onTap={onChildTap}
            rightIcon={
              isMissing
                ? "arrow-down-circle-outline"
                : hasLocal
                  ? "open-outline"
                  : null
            }
            onRightIconPress={
              isMissing
                ? onChildTap
                : hasLocal && item.localPath
                  ? () => void onOpenFile(item.localPath as string)
                  : undefined
            }
          />
        );
      }
      // drive row
      const drive = item.drive;
      const isActive = activeDriveIds.has(drive.id);
      const isFailed = failedHydrationIds.has(drive.id);
      const name = rowDisplayName(drive);
      const bytes = totalBytesOf(drive);
      const ts = drive.lastActivityAt ?? drive.createdAt;
      const meta = `${formatBytes(bytes)} · ${formatRelativeOrDate(ts) ?? "—"}`;
      const t = transferByDriveId.get(drive.id);
      const transferring =
        !!t && !t.completed && (t.percent ?? 0) > 0 && (t.percent ?? 0) < 100;
      const iconName = driveIconName(drive);
      const isBundle = !!drive.isBundle;
      // Three-tier active-state classification. peersConnected rides on the
      // transfer summary; failed-hydration rows fall into "inactive" since
      // they don't broadcast.
      const peers = t?.peersConnected ?? 0;
      const indicatorState: ActiveIndicatorState = isActive
        ? peers > 0
          ? "active-broadcasting"
          : "active-idle"
        : "inactive";
      // revert the icon green-shift — the ActiveIndicator dot
      // (and its pulse) carries the entire "active" signal now. With the
      // icon also recoloring, the dot lost contrast against it.
      const iconColor = theme.text;
      return (
        <SwipeableRow
          onDelete={() => onDelete(drive)}
          deleteLabel="Delete"
          accessibilityLabel={`${name}, ${meta}`}
          frontBackground={theme.bg}
          closeSignal={swipeCloseTick}
        >
          <Pressable
            style={[
              styles.fileRow,
              index === 0 && styles.fileRowFirst,
              !isActive && styles.fileRowDim,
            ]}
            onPress={() => void onTapRow(drive)}
            accessibilityRole="button"
            accessibilityLabel={`${name}, ${meta}, ${isActive ? "active" : "inactive"}${isBundle ? ", bundle" : ""}`}
          >
            <View style={styles.iconWrap}>
              <Ionicons name={iconName} size={22} color={iconColor} />
              <ActiveIndicator state={indicatorState} />
            </View>
            <View style={styles.rowMain}>
              <View style={styles.rowNameLine}>
                <Text style={styles.rowName} numberOfLines={1}>
                  {name}
                </Text>
                {drive.isPinned ? (
                  <Ionicons
                    name="pin"
                    size={13}
                    color={theme.muted}
                    style={styles.rowPinMark}
                  />
                ) : null}
              </View>
              <Text style={styles.rowMeta} numberOfLines={1}>
                {isFailed ? "Couldn't restore · " : ""}{meta}
              </Text>
            </View>
            {isBundle ? (
              <View style={styles.chevronBtn} accessibilityElementsHidden importantForAccessibility="no">
                <Ionicons
                  name={item.expanded ? "chevron-up-outline" : "chevron-down-outline"}
                  size={18}
                  color={theme.muted}
                />
              </View>
            ) : null}
            <Pressable
              style={styles.kebabBtn}
              hitSlop={8}
              onPress={() => setKebabSheet({ drive })}
              accessibilityRole="button"
              accessibilityLabel={`More options for ${name}`}
            >
              <Ionicons name="ellipsis-vertical" size={20} color={theme.muted} />
            </Pressable>
            {transferring ? (
              <View
                style={[
                  styles.transferBar,
                  { width: `${Math.max(2, Math.min(100, t?.percent ?? 0))}%` },
                ]}
              />
            ) : null}
          </Pressable>
        </SwipeableRow>
      );
    },
    [
      activeDriveIds,
      childBlinkTarget,
      failedHydrationIds,
      onDelete,
      onOpenFile,
      onTapRow,
      previewFile,
      setLinkDraft,
      setPendingPreselection,
      showToast,
      styles,
      swipeCloseTick,
      theme,
      transferByDriveId,
    ],
  );

  const emptyState = useMemo(
    () => (
      <View>
        <Text style={styles.emptyText}>
          {viewMode === "favorites"
            ? "No favorites yet. Tap the heart on a share to add it."
            : "Nothing here yet. Pick files above or paste a link."}
        </Text>
      </View>
    ),
    [styles, viewMode],
  );

  const kebabDrive = kebabSheet?.drive;
  const kebabActive = kebabDrive ? activeDriveIds.has(kebabDrive.id) : false;
  const kebabOpenable = kebabDrive ? isOpenableInOtherApp(kebabDrive) : false;
  // received-share rows don't expose Share-it / Stop-sharing in
  // this sprint — the engine maps activate by driveId, not shareKey, so
  // there's no clean "this share" toggle yet. Out of scope to wire fully.
  const kebabIsReceivedShare = !!kebabDrive?.share;

  return (
    <View style={[styles.root, { paddingTop: insets.top + 4 }]}>
      <View style={styles.headerRow}>
        <Text style={styles.wordmark}>PearDrop</Text>
        <Pressable
          style={styles.gearBtn}
          onPress={() => navigation.navigate("Settings")}
          accessibilityRole="button"
          accessibilityLabel="Open settings"
        >
          <Ionicons name="settings-outline" size={20} color={theme.text} />
        </Pressable>
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}
      >
        <View style={styles.actionRow}>
          <Pressable
            style={styles.shareBtn}
            disabled={!ready || shareBusy}
            onPress={() => setPickerSheet("share-files")}
            accessibilityRole="button"
            accessibilityLabel="Share files"
          >
            {shareBusy ? (
              <ActivityIndicator color={theme.onPrimary} />
            ) : (
              <Ionicons name="share-outline" size={18} color={theme.onPrimary} />
            )}
            <Text style={styles.shareBtnText}>Share files</Text>
          </Pressable>
          <View style={styles.linkInputWrap}>
            <TextInput
              style={styles.linkInput}
              placeholder="Drop a peardrop:// link"
              placeholderTextColor={theme.muted}
              value={linkDraft}
              onChangeText={setLinkDraft}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!resolving}
              accessibilityLabel="Share link input"
            />
            {resolving ? (
              <ActivityIndicator color={theme.primary} style={{ marginRight: 4 }} />
            ) : null}
            {linkDraft.length > 0 ? (
              // the clear icon is always interactive. When a
              // resolve is in flight, it also aborts the fetch — one tap
              // gets the user out cleanly without waiting for the 30 s
              // timeout. Visually identical in both states.
              <Pressable
                style={styles.qrScanBtn}
                onPress={() => {
                  if (resolving) abortResolving();
                  setPendingPreselection(null);
                  setLinkDraft("");
                }}
                accessibilityRole="button"
                accessibilityLabel={resolving ? "Cancel and clear link" : "Clear link"}
                hitSlop={10}
              >
                <Ionicons name="close-circle" size={20} color={theme.muted} />
              </Pressable>
            ) : (
              <Pressable
                style={styles.qrScanBtn}
                onPress={() => setQrVisible(true)}
                accessibilityRole="button"
                accessibilityLabel="Scan QR code"
                hitSlop={10}
              >
                <Ionicons name="qr-code-outline" size={20} color={theme.text} />
              </Pressable>
            )}
          </View>
        </View>

        {!!linkError && (
          <View style={styles.errorRow}>
            <Text style={styles.error} numberOfLines={2}>
              {linkError}
            </Text>
            {linkDraft.trim().length > 0 ? (
              <Pressable
                onPress={() => void retryResolve()}
                style={styles.retryBtn}
                accessibilityRole="button"
                accessibilityLabel="Retry"
                accessibilityHint="Try the link again"
                hitSlop={10}
              >
                <Ionicons name="refresh-outline" size={18} color={theme.primary} />
              </Pressable>
            ) : null}
          </View>
        )}

        <View style={styles.viewToggleRow}>
          <Pressable
            style={[
              styles.viewToggleSegment,
              viewMode === "all" && styles.viewToggleSegmentActive,
            ]}
            onPress={() => setViewMode("all")}
            accessibilityRole="button"
            accessibilityState={{ selected: viewMode === "all" }}
            accessibilityLabel="Show all shares"
          >
            <Text
              style={[
                styles.viewToggleText,
                viewMode === "all" && styles.viewToggleTextActive,
              ]}
            >
              All
            </Text>
          </Pressable>
          <Pressable
            style={[
              styles.viewToggleSegment,
              viewMode === "favorites" && styles.viewToggleSegmentActive,
            ]}
            onPress={() => setViewMode("favorites")}
            accessibilityRole="button"
            accessibilityState={{ selected: viewMode === "favorites" }}
            accessibilityLabel="Show favorites"
          >
            <Text
              style={[
                styles.viewToggleText,
                viewMode === "favorites" && styles.viewToggleTextActive,
              ]}
            >
              Favorites
            </Text>
          </Pressable>
        </View>

        <View style={styles.listFlex}>
          <FlatList
            data={flattenedList}
            keyExtractor={(it) =>
              it.kind === "child"
                ? `${it.parentId}#child#${it.indexInBundle}`
                : it.drive.id
            }
            renderItem={renderRow}
            style={styles.list}
            contentContainerStyle={[
              styles.listContent,
              flattenedList.length === 0 && styles.listContentEmpty,
              { paddingBottom: 16 + insets.bottom },
            ]}
            ListEmptyComponent={emptyState}
            showsVerticalScrollIndicator={false}
          />
        </View>
      </KeyboardAvoidingView>

      {/* Share-files picker sheet */}
      <Modal
        visible={pickerSheet === "share-files"}
        transparent
        animationType="slide"
        onRequestClose={() => setPickerSheet(null)}
      >
        <Pressable
          style={styles.menuBackdrop}
          onPress={() => setPickerSheet(null)}
          accessibilityLabel="Close picker"
        >
          <View
            style={[styles.menuSheet, { paddingBottom: insets.bottom + 8 }]}
            onStartShouldSetResponder={() => true}
          >
            <View style={styles.menuHandle} />
            <Pressable style={styles.menuRow} onPress={() => void onPickAndShare()}>
              <Ionicons name="document-attach-outline" size={22} color={theme.text} />
              <Text style={styles.menuRowText}>Files</Text>
            </Pressable>
            <View style={styles.menuDivider} />
            <Pressable style={styles.menuRow} onPress={() => void onPickFolderAndShare()}>
              <Ionicons name="folder-outline" size={22} color={theme.text} />
              <Text style={styles.menuRowText}>Folder</Text>
            </Pressable>
            <View style={styles.menuDivider} />
            <Pressable style={styles.menuRow} onPress={() => void onPickPhotosAndShare()}>
              <Ionicons name="images-outline" size={22} color={theme.text} />
              <Text style={styles.menuRowText}>Photos</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      {/* Per-drive kebab menu */}
      <Modal
        visible={!!kebabSheet}
        transparent
        animationType="slide"
        onRequestClose={() => setKebabSheet(null)}
      >
        <Pressable
          style={styles.menuBackdrop}
          onPress={() => setKebabSheet(null)}
          accessibilityLabel="Close menu"
        >
          <View
            style={[styles.menuSheet, { paddingBottom: insets.bottom + 8 }]}
            onStartShouldSetResponder={() => true}
          >
            <View style={styles.menuHandle} />
            <Pressable
              style={styles.menuRow}
              onPress={() => {
                if (kebabDrive) setQrDriveId(kebabDrive.id);
                setKebabSheet(null);
              }}
              accessibilityRole="button"
              accessibilityLabel="More info"
            >
              <Ionicons name="information-circle-outline" size={22} color={theme.text} />
              <Text style={styles.menuRowText}>More info</Text>
            </Pressable>
            {kebabOpenable && kebabDrive?.primaryFile ? (
              <>
                <View style={styles.menuDivider} />
                <Pressable
                  style={styles.menuRow}
                  onPress={() => {
                    const f = kebabDrive.primaryFile;
                    setKebabSheet(null);
                    if (f) void onOpenFile(f.path);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Open in another app"
                >
                  <Ionicons name="open-outline" size={22} color={theme.text} />
                  <Text style={styles.menuRowText}>Open in another app</Text>
                </Pressable>
              </>
            ) : null}
            {/* pin + favorite items appear for every drive
              *  regardless of active/inactive state. Icon fills + theme.primary
              *  color when the flag is on. */}
            <View style={styles.menuDivider} />
            <Pressable
              style={styles.menuRow}
              onPress={() => {
                if (kebabDrive) togglePinned(kebabDrive);
                setKebabSheet(null);
              }}
              accessibilityRole="button"
              accessibilityLabel={kebabDrive?.isPinned ? "Unpin" : "Pin to top"}
            >
              <Ionicons
                name={kebabDrive?.isPinned ? "pin" : "pin-outline"}
                size={22}
                color={kebabDrive?.isPinned ? theme.primary : theme.text}
              />
              <Text style={styles.menuRowText}>
                {kebabDrive?.isPinned ? "Unpin" : "Pin to top"}
              </Text>
            </Pressable>
            <View style={styles.menuDivider} />
            <Pressable
              style={styles.menuRow}
              onPress={() => {
                if (kebabDrive) toggleFavorite(kebabDrive);
                setKebabSheet(null);
              }}
              accessibilityRole="button"
              accessibilityLabel={
                kebabDrive?.isFavorite ? "Remove from favorites" : "Add to favorites"
              }
            >
              <Ionicons
                name={kebabDrive?.isFavorite ? "heart" : "heart-outline"}
                size={22}
                color={kebabDrive?.isFavorite ? theme.primary : theme.text}
              />
              <Text style={styles.menuRowText}>
                {kebabDrive?.isFavorite ? "Remove from favorites" : "Add to favorites"}
              </Text>
            </Pressable>
            {!kebabIsReceivedShare ? <View style={styles.menuDivider} /> : null}
            {!kebabIsReceivedShare && kebabActive ? (
              <Pressable
                style={styles.menuRow}
                onPress={() => kebabDrive && void onStopSharing(kebabDrive)}
                accessibilityRole="button"
                accessibilityLabel="Stop sharing"
              >
                <Ionicons name="pause-circle-outline" size={22} color={theme.text} />
                <Text style={styles.menuRowText}>Stop sharing</Text>
              </Pressable>
            ) : null}
            {!kebabIsReceivedShare && !kebabActive ? (
              <Pressable
                style={styles.menuRow}
                onPress={() => kebabDrive && void onShareIt(kebabDrive)}
                accessibilityRole="button"
                accessibilityLabel="Share it"
              >
                <Ionicons name="share-outline" size={22} color={theme.text} />
                <Text style={styles.menuRowText}>Share it</Text>
              </Pressable>
            ) : null}
            <View style={styles.menuDivider} />
            <Pressable
              style={styles.menuRow}
              onPress={() => kebabDrive && onDelete(kebabDrive)}
              accessibilityRole="button"
              accessibilityLabel="Delete"
            >
              <Ionicons name="trash-outline" size={22} color={theme.danger} />
              <Text style={[styles.menuRowText, styles.menuRowDestructive]}>Delete</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      {/* Drive info / QR modal — handles both active and inactive states. */}
      {(() => {
        const drive = qrDrive;
        const isActive = drive ? activeDriveIds.has(drive.id) : false;
        const status: "live" | "dormant" | "failed" =
          drive && failedHydrationIds.has(drive.id)
            ? "failed"
            : isActive
              ? "live"
              : "dormant";
        const link = isActive ? drive?.shareLink ?? "" : "";
        const t = drive ? transferByDriveId.get(drive.id) : undefined;
        return (
          <ShareQrModal
            visible={!!drive}
            link={link}
            stopMode={isActive ? "stop" : "remove"}
            info={
              drive
                ? {
                    status,
                    createdAt: drive.createdAt,
                    files: (drive.files ?? []).map((f) => ({ name: f.name, size: f.size })),
                    totalBytes: totalBytesOf(drive),
                    peerCount: t?.peersConnected ?? 0,
                    origin: drive.origin,
                  }
                : undefined
            }
            onClose={() => setQrDriveId(null)}
            onCopy={link ? () => void onCopyLink(link) : undefined}
            onShare={link ? () => void onShareLink(link) : undefined}
            onStop={
              drive
                ? () => {
                    const d = drive;
                    setQrDriveId(null);
                    if (isActive) void onStopSharing(d);
                    // ShareQrModal has already confirmed via its own themed
                    // modal — go straight to the destructive call rather
                    // than triggering a second confirmation here.
                    else performDelete(d);
                  }
                : undefined
            }
            onActivate={
              // Received-share synth rows can't be activated via this path
              // (no clean shareKey → driveId map yet). Hide the affordance.
              drive && !isActive && !drive.share
                ? () => {
                    const d = drive;
                    void onShareIt(d);
                  }
                : undefined
            }
          />
        );
      })()}

      {/* fullscreen takeover preview. Pure black behind
       *  the media. Chrome floats over the video and auto-hides during
       *  playback; image/text/audio keep chrome visible. Dismiss is the
       *  back arrow (or Android back button) — no tap-outside, no swipe.
       *  Custom video controls (no `nativeControls`) — playback toggles
       *  on any tap of the video tap-surface, mirroring the OS player. */}
      <Modal
        visible={!!preview}
        transparent={false}
        animationType="fade"
        onRequestClose={closePreview}
      >
        {preview?.mode === "text" ? (
          <View style={styles.fsTextRoot}>
            <ScrollView style={styles.fsTextScroll}>
              <Text style={styles.fsTextBody}>
                {previewText || "(Empty file)"}
              </Text>
            </ScrollView>
            <View style={[styles.fsTopBar, { paddingTop: insets.top + 4 }]}>
              <Pressable
                style={styles.fsTopBtn}
                onPress={closePreview}
                accessibilityRole="button"
                accessibilityLabel="Back"
                hitSlop={16}
              >
                <Ionicons name="arrow-back" size={24} color={theme.text} />
              </Pressable>
            </View>
          </View>
        ) : (
          <View style={styles.fsRoot}>
            <View style={styles.fsMediaWrap}>
              {preview?.mode === "image" && preview?.file && (
                <Image
                  source={{ uri: previewUri ?? undefined }}
                  style={styles.fsImage}
                  resizeMode="contain"
                />
              )}
              {preview?.mode === "video" && preview?.file && (
                <VideoView
                  player={videoPlayer}
                  style={styles.fsVideo}
                  allowsFullscreen={false}
                  nativeControls={false}
                  contentFit="contain"
                />
              )}
              {preview?.mode === "audio" && preview?.file && (
                <View style={styles.fsAudioShell}>
                  <View style={styles.fsAudioCover}>
                    <Ionicons name="musical-notes-outline" size={72} color="rgba(255,255,255,0.55)" />
                  </View>
                  <Text style={styles.fsAudioMeta} numberOfLines={1}>
                    {baseName(preview.file.name)}
                  </Text>
                  <View style={styles.fsAudioControlsRow}>
                    <Pressable
                      style={styles.fsAudioCtrlBtn}
                      onPress={() => onAudioSkip(-15)}
                      accessibilityRole="button"
                      accessibilityLabel="Skip back 15 seconds"
                    >
                      <Ionicons name="play-back" size={22} color="#fff" />
                    </Pressable>
                    <Pressable
                      style={styles.fsAudioPlayBtn}
                      onPress={() => {
                        if (!audioPlayer) return;
                        if (audioPlayer.playing) audioPlayer.pause();
                        else {
                          if (
                            audioStatus.didJustFinish ||
                            audioPlayer.currentTime >= audioPlayer.duration
                          ) {
                            audioPlayer.seekTo(0);
                          }
                          audioPlayer.play();
                        }
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={audioPlayer?.playing ? "Pause" : "Play"}
                    >
                      <Ionicons
                        name={audioPlayer?.playing ? "pause" : "play"}
                        size={28}
                        color="#000"
                      />
                    </Pressable>
                    <Pressable
                      style={styles.fsAudioCtrlBtn}
                      onPress={() => onAudioSkip(15)}
                      accessibilityRole="button"
                      accessibilityLabel="Skip forward 15 seconds"
                    >
                      <Ionicons name="play-forward" size={22} color="#fff" />
                    </Pressable>
                  </View>
                  <View style={styles.fsAudioScrubberRow}>
                    <Pressable
                      style={styles.fsScrubber}
                      onLayout={(e) => setScrubWidth(e.nativeEvent.layout.width)}
                      onPress={(e) => {
                        if (scrubWidth <= 0) return;
                        const x = e.nativeEvent.locationX;
                        onAudioSeekToFraction(Math.max(0, Math.min(1, x / scrubWidth)));
                      }}
                      accessibilityRole="adjustable"
                      accessibilityLabel="Audio progress"
                    >
                      <View style={styles.fsScrubberTrack}>
                        <View
                          style={[
                            styles.fsScrubberFill,
                            {
                              width: `${
                                audioDuration > 0
                                  ? Math.max(0, Math.min(100, (audioPosition / audioDuration) * 100))
                                  : 0
                              }%`,
                            },
                          ]}
                        />
                      </View>
                    </Pressable>
                    <View style={styles.fsTimeRow}>
                      <Text style={styles.fsTimeText}>{formatClock(audioPosition)}</Text>
                      <Text style={styles.fsTimeText}>
                        {audioDuration > 0 ? formatClock(audioDuration) : "—:—"}
                      </Text>
                    </View>
                  </View>
                </View>
              )}
            </View>

            {/* Video tap surface — toggles play/pause + reveals chrome.
              *  Below the chrome icons in z-order so the icons remain
              *  tappable when visible. */}
            {preview?.mode === "video" && (
              <Pressable
                style={styles.fsTapLayer}
                onPress={onVideoTap}
                accessibilityRole="button"
                accessibilityLabel={videoIsPlaying ? "Pause video" : "Play video"}
              />
            )}

            {/* Center play overlay — only while video is paused. */}
            {preview?.mode === "video" && !videoIsPlaying && (
              <View pointerEvents="box-none" style={styles.fsCenterPlay}>
                <Pressable
                  style={styles.fsCenterPlayBtn}
                  onPress={onVideoTap}
                  accessibilityRole="button"
                  accessibilityLabel="Play"
                  hitSlop={8}
                >
                  <Ionicons name="play" size={36} color="rgba(255,255,255,0.92)" />
                </Pressable>
              </View>
            )}

            {/* top bar holds only the back arrow now. Three-dots
              *  removed in favor of an inline share button below the video.
              *  Safe-area top inset clears the status bar so the icon is
              *  fully tappable. Bigger touch target + hitSlop. */}
            <Animated.View
              pointerEvents={chromeVisible ? "box-none" : "none"}
              style={[
                styles.fsTopBar,
                { opacity: chromeOpacity, paddingTop: insets.top + 4 },
              ]}
            >
              <Pressable
                style={styles.fsTopBtn}
                onPress={closePreview}
                accessibilityRole="button"
                accessibilityLabel="Back"
                hitSlop={16}
              >
                <Ionicons name="arrow-back" size={24} color="#fff" />
              </Pressable>
            </Animated.View>

            {/* Bottom bar — scrubber + times. Video only (audio's are
              *  inline above). Auto-hides with the top bar. */}
            {preview?.mode === "video" && (
              <Animated.View
                pointerEvents={chromeVisible ? "box-none" : "none"}
                style={[
                  styles.fsBottomBar,
                  {
                    opacity: chromeOpacity,
                    // fix: clear the gesture bar so the share
                    // button isn't flush against the bottom edge.
                    paddingBottom: insets.bottom + 16,
                  },
                ]}
              >
                <Pressable
                  style={styles.fsScrubber}
                  onLayout={(e) => setVideoScrubWidth(e.nativeEvent.layout.width)}
                  onPress={(e) => {
                    if (videoScrubWidth <= 0) return;
                    const x = e.nativeEvent.locationX;
                    onVideoSeekToFraction(
                      Math.max(0, Math.min(1, x / videoScrubWidth)),
                    );
                  }}
                  accessibilityRole="adjustable"
                  accessibilityLabel="Video progress"
                >
                  <View style={styles.fsScrubberTrack}>
                    <View
                      style={[
                        styles.fsScrubberFill,
                        {
                          width: `${
                            videoDuration > 0
                              ? Math.max(
                                  0,
                                  Math.min(
                                    100,
                                    (videoPosition / videoDuration) * 100,
                                  ),
                                )
                              : 0
                          }%`,
                        },
                      ]}
                    />
                  </View>
                </Pressable>
                <View style={styles.fsTimeRow}>
                  <Text style={styles.fsTimeText}>{formatClock(videoPosition)}</Text>
                  <Text style={styles.fsTimeText}>
                    {videoDuration > 0 ? formatClock(videoDuration) : "—:—"}
                  </Text>
                </View>
                {/* share/stop-sharing toggle below the scrubber.
                  *  Only renders for hosted drives (received synth rows
                  *  can't activate via this path in this sprint).
                  * Stop sharing: deactivates inline, preview stays open
                  * Share it: closes the preview and opens the main-page
                  *    QR modal so the user can hand off the link */}
                {previewParentDrive ? (
                  <View style={styles.fsShareBtnRow}>
                    <Pressable
                      style={styles.fsShareBtn}
                      onPress={() => {
                        const d = previewParentDrive;
                        if (!d) return;
                        if (previewParentIsActive) {
                          void (async () => {
                            const res = await deactivateDrive(d.id);
                            if (!res.ok) {
                              showToast(
                                errorMessage(res.error) || "Couldn't stop that one.",
                                "error",
                              );
                              return;
                            }
                            haptics.actionDone();
                            showToast("Stopped sharing.");
                            void refreshDrives();
                          })();
                        } else {
                          closePreview();
                          void onShareIt(d);
                        }
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={
                        previewParentIsActive ? "Stop sharing" : "Share it"
                      }
                    >
                      <Ionicons
                        name={
                          previewParentIsActive
                            ? "pause-circle-outline"
                            : "share-outline"
                        }
                        size={16}
                        color="#fff"
                      />
                      <Text style={styles.fsShareBtnText}>
                        {previewParentIsActive ? "Stop sharing" : "Share it"}
                      </Text>
                    </Pressable>
                  </View>
                ) : null}
              </Animated.View>
            )}
          </View>
        )}
      </Modal>

      <ConfirmModal
        visible={!!pendingDelete}
        title="Delete this drive?"
        body="Removes the data from your device. Can't undo."
        confirmLabel="Delete"
        cancelLabel="Keep"
        tone="destructive"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const d = pendingDelete;
          setPendingDelete(null);
          if (d) performDelete(d);
        }}
      />
    </View>
  );
}

