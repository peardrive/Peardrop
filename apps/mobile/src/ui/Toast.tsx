import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppTheme } from "../state/ThemeContext";
import type { AppTheme } from "./themes";
import { useMainDockBottomInset } from "../navigation/dockLayout";

export type ToastKind = "info" | "success" | "error";

type ToastOptions = {
  kind?: ToastKind;
  durationMs?: number;
};

type ToastApi = {
  show: (message: string, opts?: ToastOptions) => void;
  dismiss: () => void;
};

const ToastContext = createContext<ToastApi | null>(null);

const DEFAULT_DURATION = 2600;

/**
 * Single-toast provider. We intentionally keep only one live toast at a time:
 * consecutive calls replace the current message rather than stacking. This
 * matches the old ad-hoc implementations in screens, and feels right on a
 * transfer app where background updates would otherwise form a parade.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const { theme } = useAppTheme();
  const insets = useSafeAreaInsets();
  const dockBottom = useMainDockBottomInset();
  const [visible, setVisible] = useState(false);
  const [message, setMessage] = useState("");
  const [kind, setKind] = useState<ToastKind>("info");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(10)).current;

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const dismiss = useCallback(() => {
    clearTimer();
    Animated.parallel([
      Animated.timing(opacity, { toValue: 0, duration: 180, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: 10, duration: 180, useNativeDriver: true }),
    ]).start(() => setVisible(false));
  }, [clearTimer, opacity, translateY]);

  const show = useCallback(
    (msg: string, opts?: ToastOptions) => {
      if (!msg) return;
      clearTimer();
      setMessage(msg);
      setKind(opts?.kind ?? "info");
      setVisible(true);
      opacity.setValue(0);
      translateY.setValue(10);
      Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }),
        Animated.timing(translateY, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start();
      const duration = opts?.durationMs ?? DEFAULT_DURATION;
      timerRef.current = setTimeout(dismiss, duration);
    },
    [clearTimer, dismiss, opacity, translateY]
  );

  useEffect(() => {
    return () => clearTimer();
  }, [clearTimer]);

  const api = useMemo<ToastApi>(() => ({ show, dismiss }), [show, dismiss]);

  const styles = useMemo(() => createStyles(theme), [theme]);

  const iconName: keyof typeof Ionicons.glyphMap =
    kind === "success" ? "checkmark-circle" : kind === "error" ? "alert-circle" : "information-circle";
  const accent =
    kind === "success" ? theme.primary : kind === "error" ? theme.danger : theme.text;

  // extra clearance so the toast floats just above the
  // Receive tab's link-input shell. dockBottom already covers the tab
  // bar + safe area (75 + insets.bottom), and +12 adds a base gap, so
  // this clearance only needs to cover the input row's height to land
  // the toast immediately above it — not far above. Tuned down twice on
  // user feedback (96 → 48 → 24). Approach A from the prompt:
  // one global offset, simpler than per-screen height registration.
  // Other screens (Share / Account / Settings) just float a touch
  // higher above the tab bar than they used to.
  const RECEIVE_INPUT_CLEARANCE = 24;
  const offsetBottom =
    Math.max(dockBottom, insets.bottom + 12) + 12 + RECEIVE_INPUT_CLEARANCE;

  return (
    <ToastContext.Provider value={api}>
      {children}
      {visible && (
        <View pointerEvents="box-none" style={[styles.root, { bottom: offsetBottom }]}>
          <Animated.View
            style={[styles.toast, { opacity, transform: [{ translateY }] }]}
            accessibilityLiveRegion="polite"
            accessibilityRole="alert"
          >
            <Ionicons name={iconName} size={18} color={accent} style={{ marginRight: 10 }} />
            <Text style={styles.text} numberOfLines={3}>
              {message}
            </Text>
            <Pressable
              onPress={dismiss}
              hitSlop={8}
              style={styles.dismiss}
              accessibilityRole="button"
              accessibilityLabel="Dismiss notification"
            >
              <Ionicons name="close" size={16} color={theme.muted} />
            </Pressable>
          </Animated.View>
        </View>
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside ToastProvider");
  return ctx;
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    root: {
      position: "absolute",
      left: 16,
      right: 16,
      alignItems: "center",
    },
    toast: {
      flexDirection: "row",
      alignItems: "center",
      // theme.bg (opaque in every theme) instead of theme.card
      // (alpha 0.05–0.08 in 8 of 10 themes). With a translucent card
      // background, even a correctly-positioned toast still felt "smeared"
      // because UI behind it bled through. Same pattern as for
      // the modal cards. The shadow + border give the floating-pill look.
      backgroundColor: theme.bg,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: theme.border,
      paddingHorizontal: 14,
      paddingVertical: 12,
      maxWidth: 520,
      width: "100%",
      shadowColor: "#000",
      shadowOpacity: 0.18,
      shadowOffset: { width: 0, height: 4 },
      shadowRadius: 10,
      elevation: 4,
    },
    text: { flex: 1, color: theme.text, fontSize: 14, fontWeight: "500" },
    dismiss: {
      marginLeft: 8,
      width: 24,
      height: 24,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 12,
    },
  });
}
