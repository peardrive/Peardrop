import React, { useMemo, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import QRCode from "react-native-qrcode-svg";
import { useAppTheme } from "../state/ThemeContext";
import type { AppTheme } from "./themes";
import { formatBytes, formatRelativeOrDate } from "../lib/format";
import ConfirmModal from "./ConfirmModal";

export type ShareQrModalInfoFile = {
  name: string;
  size?: number;
};

export type ShareQrModalProps = {
  visible: boolean;
  link: string;
  onClose: () => void;
  onCopy?: () => void;
  onShare?: () => void;
  onStop?: () => void;
  /** when set + drive is inactive, the modal shows a primary
   *  "Share it" button instead of QR/Copy/Send (which don't work when the
   *  drive isn't seeding). Tapping it activates the drive. */
  onActivate?: () => void;
  stopMode?: "stop" | "remove";
  info?: {
    /** "live" → green dot + "Active". "dormant" → muted + "Inactive".
     * "failed" → danger + "Couldn't restore". */
    status?: "live" | "dormant" | "failed";
    /** ms since epoch. Rendered as a short relative-then-absolute label. */
    createdAt?: number;
    /** still accepted for back-compat / file-count derivation,
     *  but the per-file list is no longer rendered inside the modal —
     *  bundle expansion on the main page surfaces those rows now. */
    files?: ShareQrModalInfoFile[];
    /** Sum of file sizes. Passed in (not recomputed) to match what the
     * card shows. */
    totalBytes?: number;
    /** Hidden when 0 so we don't add a row for the common empty case. */
    peerCount?: number;
    /** "hosted" → Source: "Created by me". "received" →
     *  Source: "Received". Decides whether the time row reads
     *  "Created" or "Received". */
    origin?: "hosted" | "received";
  };
};

function formatStatus(s?: "live" | "dormant" | "failed") {
  if (s === "live") return "Active";
  if (s === "dormant") return "Inactive";
  if (s === "failed") return "Couldn't restore";
  return null;
}

export default function ShareQrModal({
  visible,
  link,
  onClose,
  onCopy,
  onShare,
  onStop,
  onActivate,
  stopMode = "stop",
  info,
}: ShareQrModalProps) {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [stopping, setStopping] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const isRemoveMode = stopMode === "remove";
  const stopLabel = isRemoveMode ? "Remove" : "Stop sharing";

  const statusLabel = formatStatus(info?.status);
  const statusColor =
    info?.status === "live"
      ? theme.primary
      : info?.status === "failed"
        ? theme.danger
        : theme.muted;
  const createdLabel = formatRelativeOrDate(info?.createdAt);
  const files = info?.files ?? [];
  const fileCount = files.length;
  const sizeLabel =
    info?.totalBytes != null && info.totalBytes > 0
      ? formatBytes(info.totalBytes)
      : null;
  const peerCount = info?.peerCount ?? 0;
  const origin = info?.origin;
  const sourceLabel =
    origin === "received" ? "Received" : origin === "hosted" ? "Created by me" : null;
  // "Created" reads odd on a drive the user received from
  // someone else. Swap the leading label when origin tells us this is
  // a received drive.
  const timeRowLabel = origin === "received" ? "Received" : "Created";

  const hasInfoRows = !!(
    statusLabel ||
    sourceLabel ||
    createdLabel ||
    sizeLabel ||
    peerCount > 0 ||
    fileCount > 0
  );
  const showInfoSection = !!info && hasInfoRows;

  const onPressStop = () => {
    if (!onStop) return;
    setConfirming(true);
  };

  const onConfirmStop = () => {
    setConfirming(false);
    if (!onStop) return;
    setStopping(true);
    onStop();
    // Parent unmounts modal as part of teardown; close defensively.
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close QR code">
        <Pressable style={styles.card} onPress={() => {}}>
          <View style={styles.header}>
            <Text style={styles.title}>{link ? "Send via QR" : "Drive info"}</Text>
            <Pressable onPress={onClose} hitSlop={8} accessibilityRole="button" accessibilityLabel="Close">
              <Ionicons name="close" size={22} color={theme.muted} />
            </Pressable>
          </View>

          {link ? (
            <>
              <View style={styles.qrWrap}>
                <QRCode
                  value={link}
                  size={220}
                  backgroundColor="#ffffff"
                  color="#000000"
                  ecl="M"
                />
              </View>

              <Text style={styles.link} numberOfLines={2} selectable>
                {link}
              </Text>

              <View style={styles.actions}>
                {onCopy && (
                  <Pressable style={styles.btn} onPress={onCopy} accessibilityRole="button" accessibilityLabel="Copy link">
                    <Ionicons name="copy-outline" size={16} color={theme.text} />
                    <Text style={styles.btnText}>Copy</Text>
                  </Pressable>
                )}
                {onShare && (
                  <Pressable style={styles.btn} onPress={onShare} accessibilityRole="button" accessibilityLabel="Send link">
                    <Ionicons name="share-outline" size={16} color={theme.text} />
                    <Text style={styles.btnText}>Send to…</Text>
                  </Pressable>
                )}
              </View>
            </>
          ) : null}

          {onActivate && !link ? (
            <Pressable
              style={[styles.btn, styles.activateBtn]}
              onPress={onActivate}
              accessibilityRole="button"
              accessibilityLabel="Share it"
            >
              <Ionicons name="share-outline" size={16} color={theme.onPrimary} />
              <Text style={[styles.btnText, styles.activateBtnText]}>Share it</Text>
            </Pressable>
          ) : null}

          {showInfoSection ? (
            <View style={styles.infoSection}>
              <Text style={styles.infoLabel}>SHARE INFO</Text>
              {statusLabel ? (
                <View style={styles.infoRow}>
                  <Text style={styles.infoRowLabel}>Status</Text>
                  <View style={styles.infoStatusValue}>
                    <View
                      style={[styles.statusDot, { backgroundColor: statusColor }]}
                    />
                    <Text style={[styles.infoRowValue, { color: statusColor }]}>
                      {statusLabel}
                    </Text>
                  </View>
                </View>
              ) : null}
              {sourceLabel ? (
                <View style={styles.infoRow}>
                  <Text style={styles.infoRowLabel}>Source</Text>
                  <Text style={styles.infoRowValue}>{sourceLabel}</Text>
                </View>
              ) : null}
              {createdLabel ? (
                <View style={styles.infoRow}>
                  <Text style={styles.infoRowLabel}>{timeRowLabel}</Text>
                  <Text style={styles.infoRowValue}>{createdLabel}</Text>
                </View>
              ) : null}
              {fileCount > 0 ? (
                <View style={styles.infoRow}>
                  <Text style={styles.infoRowLabel}>Files</Text>
                  <Text style={styles.infoRowValue}>
                    {fileCount === 1 ? "1 file" : `${fileCount} files`}
                  </Text>
                </View>
              ) : null}
              {sizeLabel ? (
                <View style={styles.infoRow}>
                  <Text style={styles.infoRowLabel}>Size</Text>
                  <Text style={styles.infoRowValue}>{sizeLabel}</Text>
                </View>
              ) : null}
              {peerCount > 0 ? (
                <View style={styles.infoRow}>
                  <Text style={styles.infoRowLabel}>Connected</Text>
                  <Text style={styles.infoRowValue}>
                    {peerCount === 1 ? "1 pear" : `${peerCount} pears`}
                  </Text>
                </View>
              ) : null}
              {/* per-file list intentionally removed —
               *  bundle expansion on the main page is the new home for
               *  per-file rows. */}
            </View>
          ) : null}

          {onStop && (
            <Pressable
              style={[styles.btn, styles.stopBtn]}
              onPress={onPressStop}
              disabled={stopping}
              accessibilityRole="button"
              accessibilityLabel={stopLabel}
            >
              <Ionicons name="stop-circle-outline" size={16} color={theme.danger} />
              <Text style={[styles.btnText, styles.stopBtnText]}>{stopLabel}</Text>
            </Pressable>
          )}
        </Pressable>
      </Pressable>
      <ConfirmModal
        visible={confirming}
        title={isRemoveMode ? "Remove this share?" : "Stop sharing?"}
        body={
          isRemoveMode
            ? "Removes the data from your device. Can't undo."
            : "Other pears won't be able to grab it anymore."
        }
        confirmLabel={isRemoveMode ? "Remove" : "Stop sharing"}
        cancelLabel="Keep"
        tone="destructive"
        onCancel={() => setConfirming(false)}
        onConfirm={onConfirmStop}
      />
    </Modal>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      // standardized at 0.5 across modal scrims.
      backgroundColor: "rgba(0,0,0,0.5)",
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
    },
    card: {
      width: "100%",
      maxWidth: 360,
      borderRadius: 16,
      // theme.bg (opaque) instead of theme.card (5–8% alpha) — see
      // SharePreviewModal for full context.
      backgroundColor: theme.bg,
      borderWidth: 1,
      borderColor: theme.border,
      padding: 16,
      gap: 12,
    },
    header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    title: { color: theme.text, fontSize: 16, fontWeight: "700" },
    qrWrap: {
      alignSelf: "center",
      padding: 12,
      borderRadius: 12,
      backgroundColor: "#ffffff",
    },
    link: { color: theme.muted, fontSize: 12, textAlign: "center" },
    actions: { flexDirection: "row", justifyContent: "center", gap: 8, marginTop: 4 },
    btn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.surfaceSubtle,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    btnText: { color: theme.text, fontWeight: "600", fontSize: 13 },
    stopBtn: {
      borderColor: theme.danger,
      backgroundColor: "transparent",
    },
    stopBtnText: { color: theme.danger },
    activateBtn: {
      borderColor: theme.primary,
      backgroundColor: theme.primary,
      alignSelf: "stretch",
      justifyContent: "center",
      paddingVertical: 12,
    },
    activateBtnText: { color: theme.onPrimary },
    infoSection: {
      marginTop: 4,
      paddingTop: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
      gap: 6,
    },
    infoLabel: {
      fontSize: 11,
      fontWeight: "700",
      letterSpacing: 0.6,
      color: theme.muted,
      marginBottom: 4,
    },
    infoRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      gap: 12,
    },
    infoRowLabel: {
      color: theme.muted,
      fontSize: 13,
    },
    infoRowValue: {
      color: theme.text,
      fontSize: 13,
      fontWeight: "500",
      flexShrink: 1,
      textAlign: "right",
    },
    infoStatusValue: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    statusDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    fileList: {
      marginTop: 6,
      gap: 4,
    },
    fileRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      gap: 12,
      paddingVertical: 2,
    },
    fileName: {
      color: theme.text,
      fontSize: 13,
      flex: 1,
    },
    fileSize: {
      color: theme.muted,
      fontSize: 12,
    },
    fileMore: {
      color: theme.muted,
      fontSize: 12,
      fontStyle: "italic",
      marginTop: 2,
    },
  });
}
