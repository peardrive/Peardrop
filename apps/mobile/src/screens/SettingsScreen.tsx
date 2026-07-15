import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import { useAppTheme } from "../state/ThemeContext";
import { THEME_ORDER, themes } from "../ui/themes";
import { loadStats, subscribeStats, type Stats } from "../state/statsStorage";
import { formatBytes } from "../lib/format";

// continuation (Sprint 2D, 2026-05-14): the "Demo & testing" card
// was removed entirely for release. With it: useNavigation (was only used
// to jump to Receive for the demo link), useShareLinkFlow (setLinkDraft for
// the same), useToast (only fired from demo handlers), useDevMode (only
// read inside onAddDemoFiles), appendDownloadResults / addReceived /
// resetSwipeHint / resetPickerBackHint / DEMO_LINK / clearAllDownloads /
// materializeDemoFiles / ActivityIndicator. All gone now. The storage
// helpers (swipeHintStorage / pickerHintStorage / receivedFilesStorage /
// statsStorage) still exist and are imported by their primary consumers
// (HomeScreen, ReceiveScreen, AccountScreen) — only Settings stopped
// referencing them. To re-expose the demo panel for QA, lift the previous
// version out of git history; nothing here depends on it.

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const { theme, themeId, preferredThemeId, mode, setThemeId, setMode } = useAppTheme();
  const followSystem = mode === "system";
  const [stats, setStats] = useState<Stats>({ sentBytes: 0, receivedBytes: 0, updatedAt: 0 });
  useEffect(() => {
    let alive = true;
    void loadStats().then((s) => {
      if (alive) setStats(s);
    });
    const unsub = subscribeStats((s) => {
      if (alive) setStats(s);
    });
    return () => {
      alive = false;
      unsub();
    };
  }, []);
  const onBack = useCallback(() => {
    if (navigation.canGoBack()) navigation.goBack();
  }, [navigation]);
  const styles = useMemo(
    () =>
      StyleSheet.create({
        root: { flex: 1, backgroundColor: theme.bg },
        content: { paddingHorizontal: theme.pad },
        titleRow: { flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 6 },
        backBtn: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
        title: { fontSize: 26, fontWeight: "700", color: theme.text },
        statRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 6 },
        statLabel: { color: theme.muted, fontSize: 14, fontWeight: "600" },
        statValue: { color: theme.text, fontSize: 14, fontWeight: "600" },
        sub: { fontSize: 14, color: theme.muted, marginBottom: 12, lineHeight: 20 },
        card: {
          borderRadius: 16,
          borderWidth: 1,
          borderColor: theme.border,
          backgroundColor: theme.card,
          padding: 16,
        },
        cardTitle: { color: theme.text, fontWeight: "700", fontSize: 16, marginBottom: 8 },
        cardText: { color: theme.muted, fontSize: 13, lineHeight: 20 },
        themeList: {
          marginTop: 12,
          gap: 10,
        },
        themeRow: {
          borderRadius: 16,
          borderWidth: 1,
          borderColor: theme.border,
          backgroundColor: theme.card,
          paddingHorizontal: 14,
          paddingVertical: 12,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        },
        themeRowFirst: {},
        themeRowActive: {
          backgroundColor: theme.tabActiveOverlay,
          borderColor: theme.primaryMuted,
        },
        themeMain: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 2 },
        swatchRow: { flexDirection: "row", alignItems: "center", gap: 6 },
        swatch: {
          width: 18,
          height: 18,
          borderRadius: 999,
          borderWidth: 1,
          borderColor: "rgba(255,255,255,0.35)",
        },
        themeLabel: { color: theme.text, fontWeight: "700", fontSize: 15 },
        themeDesc: { color: theme.muted, fontSize: 12, marginTop: 2, lineHeight: 16 },
        check: {
          color: theme.primary,
          fontSize: 12,
          fontWeight: "700",
          borderWidth: 1,
          borderColor: theme.primaryMuted,
          borderRadius: 999,
          paddingHorizontal: 10,
          paddingVertical: 4,
          overflow: "hidden",
        },
        toggleRow: {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: 16,
          gap: 12,
        },
        toggleLabel: { color: theme.text, fontWeight: "600", fontSize: 14 },
        toggleHint: { color: theme.muted, fontSize: 12, marginTop: 2, lineHeight: 16 },
        themeListDisabled: { opacity: 0.45 },
        systemBadge: {
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          marginTop: 8,
          paddingHorizontal: 10,
          paddingVertical: 6,
          borderRadius: 999,
          backgroundColor: theme.surfaceSubtle,
          alignSelf: "flex-start",
        },
        systemBadgeText: { color: theme.muted, fontSize: 12, fontWeight: "600" },
        sectionSpacer: { height: 24 },
        demoCaption: {
          color: theme.muted,
          fontSize: 12,
          lineHeight: 16,
          marginBottom: 10,
        },
        demoBtn: {
          borderRadius: 12,
          borderWidth: 1,
          borderColor: theme.border,
          backgroundColor: theme.cardStrong,
          paddingHorizontal: 14,
          paddingVertical: 12,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          marginTop: 8,
        },
        demoBtnText: { color: theme.text, fontSize: 14, fontWeight: "600", flex: 1 },
        demoBtnHint: { color: theme.muted, fontSize: 12, marginTop: 2 },
        demoBtnColumn: { flex: 1 },
      }),
    [theme]
  );

  return (
    <ScrollView
      style={[styles.root, { paddingTop: insets.top + theme.pad }]}
      // 3I's `insets.bottom + 32` still cut the final theme on
      // long phones. Bumping to `+ 96` clears the gesture bar comfortably
      // on every device we've seen.
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 96 }]}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.titleRow}>
        <Pressable
          onPress={onBack}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.backBtn}
        >
          <Ionicons name="chevron-back" size={22} color={theme.text} />
        </Pressable>
        <Text style={styles.title}>Settings</Text>
      </View>
      <Text style={styles.sub}>Make it look how you like.</Text>
      <View style={[styles.card, { marginBottom: 12 }]}>
        <Text style={styles.cardTitle}>Lifetime stats</Text>
        <View style={styles.statRow}>
          <Text style={styles.statLabel}>Sent</Text>
          <Text style={styles.statValue}>{formatBytes(stats.sentBytes)}</Text>
        </View>
        <View style={styles.statRow}>
          <Text style={styles.statLabel}>Received</Text>
          <Text style={styles.statValue}>{formatBytes(stats.receivedBytes)}</Text>
        </View>
      </View>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Theme</Text>
        <Text style={styles.cardText}>Pick a vibe.</Text>
        <View style={styles.toggleRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.toggleLabel}>Follow system</Text>
            <Text style={styles.toggleHint}>
              Match your device&apos;s light or dark mode, automatically.
            </Text>
          </View>
          <Switch
            value={followSystem}
            onValueChange={(v) => setMode(v ? "system" : "manual")}
            accessibilityLabel="Follow system theme"
            accessibilityHint="When on, the app follows your device's light or dark mode."
          />
        </View>
        {followSystem ? (
          <View style={styles.systemBadge}>
            <Ionicons name="phone-portrait-outline" size={14} color={theme.muted} />
            <Text style={styles.systemBadgeText}>Currently: {themes[themeId].label}</Text>
          </View>
        ) : null}
      </View>
      <View style={[styles.themeList, followSystem && styles.themeListDisabled]}>
        {THEME_ORDER.map((id, index) => {
          const candidate = themes[id];
          // When following the system, highlight the user's saved preference
          // so they can see what they'd get back when they flip off "system".
          const active = followSystem ? id === preferredThemeId : id === themeId;
          return (
            <Pressable
              key={id}
              onPress={() => setThemeId(id)}
              disabled={false}
              style={[styles.themeRow, index === 0 && styles.themeRowFirst, active && styles.themeRowActive]}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`${candidate.label} theme`}
              accessibilityHint={followSystem ? "Pick this one and we'll stop following your device's mode." : candidate.description}
            >
              <View style={{ flex: 1 }}>
                <View style={styles.themeMain}>
                  <View style={styles.swatchRow}>
                    <View style={[styles.swatch, { backgroundColor: candidate.primary }]} />
                    <View style={[styles.swatch, { backgroundColor: candidate.secondary }]} />
                    <View style={[styles.swatch, { backgroundColor: candidate.cardStrong }]} />
                  </View>
                  <Text style={styles.themeLabel}>{candidate.label}</Text>
                </View>
                <Text style={styles.themeDesc}>{candidate.description}</Text>
              </View>
              {active ? <Text style={styles.check}>{followSystem ? "Preferred" : "Selected"}</Text> : null}
            </Pressable>
          );
        })}
      </View>

      {/* continuation (Sprint 2D, 2026-05-14): "Developer info"
       * card AND "Demo & testing" card both removed for release. Settings
       * is now just Theme + Follow system. The hint-replay buttons live
       * with their consumers' storage if they ever need to be re-exposed. */}
    </ScrollView>
  );
}
