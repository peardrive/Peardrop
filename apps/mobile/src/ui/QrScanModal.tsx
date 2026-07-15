import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Linking,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Ionicons } from "@expo/vector-icons";
import { useAppTheme } from "../state/ThemeContext";
import { useShareLinkFlow } from "../state/ShareLinkFlowContext";
import { haptics } from "../lib/haptics";
import type { AppTheme } from "./themes";

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.88)", justifyContent: "center", padding: 16 },
    card: {
      borderRadius: 16,
      overflow: "hidden",
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.card,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      padding: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    title: { color: theme.text, fontWeight: "700", fontSize: 16 },
    camWrap: { width: "100%", height: 320, backgroundColor: "#000", overflow: "hidden" },
    cam: { ...StyleSheet.absoluteFillObject },
    overlay: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
    overlayShade: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.35)" },
    finder: {
      width: 224,
      height: 224,
      borderRadius: 18,
      borderWidth: 3,
      borderColor: "rgba(255,255,255,0.85)",
      backgroundColor: "transparent",
    },
    hint: { padding: 12, color: theme.muted, fontSize: 13, lineHeight: 18, textAlign: "center" },
    permissionBlock: { padding: 16, gap: 10, alignItems: "center" },
    permissionTitle: {
      color: theme.text,
      fontSize: 15,
      fontWeight: "700",
      textAlign: "center",
    },
    permissionBody: {
      color: theme.muted,
      fontSize: 13,
      lineHeight: 18,
      textAlign: "center",
    },
    permissionBtnRow: { flexDirection: "row", gap: 10, marginTop: 6 },
    primaryBtn: {
      backgroundColor: theme.primary,
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderRadius: 999,
    },
    primaryBtnText: { color: theme.onPrimary, fontWeight: "700", fontSize: 13 },
    ghostBtn: {
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.surfaceSubtle,
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderRadius: 999,
    },
    ghostBtnText: { color: theme.text, fontWeight: "600", fontSize: 13 },
    fallbackRow: {
      paddingVertical: 12,
      paddingHorizontal: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
      alignItems: "center",
    },
    fallbackText: { color: theme.primary, fontSize: 13, fontWeight: "600" },
  });
}

export default function QrScanModal() {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { qrVisible, setQrVisible, resolveFromScan } = useShareLinkFlow();
  const [permission, requestPermission] = useCameraPermissions();
  const scannedRef = useRef(false);
  const [scanned, setScanned] = useState(false);
  // Border-color flash on success — animates from the default white to the
  // theme's primary accent, then snaps back if the modal somehow stays open
  // (it shouldn't — resolveFromScan closes it).
  const flash = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (qrVisible) {
      scannedRef.current = false;
      setScanned(false);
      flash.setValue(0);
    }
  }, [qrVisible, flash]);

  const canScan = permission?.granted === true;
  const canRequest = permission?.canAskAgain !== false;

  const onScan = (data: string) => {
    if (!data || scannedRef.current) return;
    scannedRef.current = true;
    setScanned(true);
    haptics.actionDone();
    Animated.sequence([
      Animated.timing(flash, { toValue: 1, duration: 120, useNativeDriver: false }),
      Animated.timing(flash, { toValue: 0, duration: 220, useNativeDriver: false }),
    ]).start();
    // Hand off to the link-flow context. It closes the QR modal as part of
    // resolveFromScan, so by the time the user re-opens the modal we'll be
    // back in a fresh state via the qrVisible effect above.
    void resolveFromScan(data);
  };

  const finderBorderColor = flash.interpolate({
    inputRange: [0, 1],
    outputRange: ["rgba(255,255,255,0.85)", theme.primary],
  });

  return (
    <Modal visible={qrVisible} animationType="fade" onRequestClose={() => setQrVisible(false)}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>Scan a QR</Text>
            <Pressable
              onPress={() => setQrVisible(false)}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Ionicons name="close" size={24} color={theme.text} />
            </Pressable>
          </View>

          {Platform.OS === "web" ? (
            <Text style={styles.hint}>Scanning doesn&apos;t work on web — use a pear.</Text>
          ) : !permission ? (
            <Text style={styles.hint}>Just a sec — checking camera access…</Text>
          ) : !canScan ? (
            <View style={styles.permissionBlock}>
              <Ionicons name="camera-outline" size={36} color={theme.primary} />
              <Text style={styles.permissionTitle}>
                I need your camera to scan codes
              </Text>
              <Text style={styles.permissionBody}>
                {canRequest
                  ? "Tap allow on the prompt and we'll get going."
                  : "You can turn it on in Settings."}
              </Text>
              <View style={styles.permissionBtnRow}>
                {canRequest ? (
                  <Pressable
                    style={styles.primaryBtn}
                    onPress={() => void requestPermission()}
                    accessibilityRole="button"
                    accessibilityLabel="Allow camera access"
                  >
                    <Text style={styles.primaryBtnText}>Allow camera</Text>
                  </Pressable>
                ) : (
                  <Pressable
                    style={styles.primaryBtn}
                    onPress={() => void Linking.openSettings()}
                    accessibilityRole="button"
                    accessibilityLabel="Open system settings"
                    accessibilityHint="Opens your device settings so you can turn camera access on"
                  >
                    <Text style={styles.primaryBtnText}>Open settings</Text>
                  </Pressable>
                )}
                <Pressable
                  style={styles.ghostBtn}
                  onPress={() => setQrVisible(false)}
                  accessibilityRole="button"
                  accessibilityLabel="Paste a link instead"
                  accessibilityHint="Closes the camera and goes back to the link input"
                >
                  <Text style={styles.ghostBtnText}>Or paste a link instead</Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <>
              <View style={styles.camWrap}>
                <CameraView
                  style={styles.cam}
                  facing="back"
                  barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                  onBarcodeScanned={({ data }) => onScan(data)}
                />
                <View style={styles.overlayShade} pointerEvents="none" />
                <View style={styles.overlay} pointerEvents="none">
                  <Animated.View
                    style={[styles.finder, { borderColor: finderBorderColor }]}
                  />
                </View>
              </View>
              <Text style={styles.hint}>
                {scanned ? "Got it — opening…" : "Hold steady — I'll grab it automatically."}
              </Text>
              <Pressable
                style={styles.fallbackRow}
                onPress={() => setQrVisible(false)}
                accessibilityRole="button"
                accessibilityLabel="Type it in instead"
                accessibilityHint="Closes the camera so you can paste or type a link"
              >
                <Text style={styles.fallbackText}>Type it in instead</Text>
              </Pressable>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}
