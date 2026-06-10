import { Feather, Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useLumina } from "@/context/LuminaContext";
import { useColors } from "@/hooks/useColors";

const API_URL = process.env.EXPO_PUBLIC_LUMINA_API_URL ?? "";

const FEATURES = [
  { icon: "shield-checkmark-outline" as const, label: "Zero-trust security" },
  { icon: "git-merge-outline" as const, label: "2-of-2 multi-sig" },
  { icon: "globe-outline" as const, label: "Omnichain bridge" },
  { icon: "flash-outline" as const, label: "Real-time tracking" },
] as const;

async function authenticateWithPi(username: string, apiUrl: string): Promise<{ jwt: string; vaultId: string; uid: string }> {
  if (!apiUrl) {
    return {
      jwt: "demo_jwt_" + Date.now(),
      vaultId: "vault_" + username.toLowerCase().replace(/\s/g, "_"),
      uid: "uid_" + username.toLowerCase(),
    };
  }
  const response = await fetch(`${apiUrl}/api/auth/pi`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  });
  if (!response.ok) throw new Error(`Auth failed: ${response.status}`);
  return response.json();
}

export default function ConnectScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { piSession, setPiSession, clearPiSession, setVaultId } = useLumina();

  const [inputUsername, setInputUsername] = useState("");
  const [error, setError] = useState<string | null>(null);

  const topPad = Platform.OS === "web" ? 67 : insets.top;
  const bottomPad = Platform.OS === "web" ? 34 : 0;

  const isConnected = piSession.status === "connected";
  const isConnecting = piSession.status === "connecting";

  const handleConnect = useCallback(async () => {
    const username = inputUsername.trim();
    if (!username) {
      setError("Please enter your Pi username.");
      return;
    }
    setError(null);
    setPiSession({ status: "connecting" });
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      const result = await authenticateWithPi(username, API_URL);
      setPiSession({
        status: "connected",
        user: { uid: result.uid, username },
        luminaJwt: result.jwt,
      });
      setVaultId(result.vaultId);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Connection failed";
      setError(msg);
      setPiSession({ status: "error" });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  }, [inputUsername, setPiSession, setVaultId]);

  const handleDisconnect = useCallback(() => {
    Alert.alert(
      "Disconnect Wallet",
      "Are you sure you want to disconnect your Pi Wallet?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Disconnect",
          style: "destructive",
          onPress: async () => {
            clearPiSession();
            setVaultId(null);
            setInputUsername("");
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          },
        },
      ],
    );
  }, [clearPiSession, setVaultId]);

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: colors.background }]}
      contentContainerStyle={[
        styles.content,
        { paddingTop: topPad + 16, paddingBottom: bottomPad + 100 },
      ]}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.headerRow}>
        <View>
          <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
            PI NETWORK
          </Text>
          <Text style={[styles.pageTitle, { color: colors.gold }]}>Wallet</Text>
        </View>
        <View style={[styles.piIcon, { backgroundColor: colors.goldDim, borderColor: colors.border }]}>
          <Text style={[styles.piSymbol, { color: colors.gold }]}>π</Text>
        </View>
      </View>

      {isConnected ? (
        <View style={[styles.connectedCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={[styles.avatarCircle, { backgroundColor: colors.goldDim, borderColor: colors.gold }]}>
            <Text style={[styles.avatarText, { color: colors.gold }]}>
              {piSession.user?.username?.[0]?.toUpperCase() ?? "P"}
            </Text>
          </View>
          <Text style={[styles.connectedLabel, { color: colors.mutedForeground }]}>
            CONNECTED AS
          </Text>
          <Text style={[styles.username, { color: colors.gold }]}>
            {piSession.user?.username ?? "Pi User"}
          </Text>
          <Text style={[styles.uid, { color: colors.textDim }]}>
            UID: {piSession.user?.uid ?? "—"}
          </Text>

          <View style={styles.divider} />

          <View style={styles.sessionInfo}>
            <View style={[styles.sessionRow, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
              <Ionicons name="key-outline" size={14} color={colors.mutedForeground} />
              <Text style={[styles.sessionLabel, { color: colors.mutedForeground }]}>JWT Token</Text>
              <View style={[styles.tokenDot, { backgroundColor: colors.success }]} />
              <Text style={[styles.sessionValue, { color: colors.success }]}>Active</Text>
            </View>
            <View style={[styles.sessionRow, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
              <MaterialCommunityIcons name="vault" size={14} color={colors.mutedForeground} />
              <Text style={[styles.sessionLabel, { color: colors.mutedForeground }]}>Vault</Text>
              <View style={[styles.tokenDot, { backgroundColor: colors.success }]} />
              <Text style={[styles.sessionValue, { color: colors.success }]}>Provisioned</Text>
            </View>
          </View>

          <Pressable
            onPress={handleDisconnect}
            style={({ pressed }) => [
              styles.disconnectBtn,
              { borderColor: colors.destructive, backgroundColor: pressed ? "rgba(248,113,113,0.10)" : "transparent" },
            ]}
          >
            <Feather name="log-out" size={14} color={colors.destructive} style={{ marginRight: 6 }} />
            <Text style={[styles.disconnectText, { color: colors.destructive }]}>Disconnect</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.cardTitle, { color: colors.gold }]}>CONNECT PI WALLET</Text>
            <Text style={[styles.cardDesc, { color: colors.mutedForeground }]}>
              Enter your Pi username to authenticate with the Lumina vault. Your credentials never leave your device.
            </Text>

            <View style={[styles.inputWrapper, { borderColor: error ? colors.destructive : colors.input, backgroundColor: colors.surfaceAlt }]}>
              <Text style={[styles.inputPrefix, { color: colors.gold }]}>π</Text>
              <TextInput
                value={inputUsername}
                onChangeText={(v) => { setInputUsername(v); setError(null); }}
                placeholder="your_username"
                placeholderTextColor={colors.textDim}
                style={[styles.input, { color: colors.foreground, fontFamily: "Inter_400Regular" }]}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="done"
                onSubmitEditing={handleConnect}
                editable={!isConnecting}
                testID="pi-username-input"
              />
            </View>

            {error && (
              <View style={[styles.errorBox, { backgroundColor: "rgba(248,113,113,0.08)", borderColor: colors.destructive }]}>
                <Ionicons name="alert-circle-outline" size={14} color={colors.destructive} style={{ marginRight: 6 }} />
                <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text>
              </View>
            )}

            <Pressable
              onPress={handleConnect}
              disabled={isConnecting || !inputUsername.trim()}
              style={({ pressed }) => [
                styles.connectBtn,
                {
                  backgroundColor:
                    isConnecting || !inputUsername.trim()
                      ? colors.goldDim
                      : pressed
                      ? "#D4A030"
                      : colors.gold,
                },
              ]}
              testID="connect-btn"
            >
              {isConnecting ? (
                <ActivityIndicator color={colors.primaryForeground} size="small" />
              ) : (
                <>
                  <MaterialCommunityIcons
                    name="wallet-plus-outline"
                    size={16}
                    color={isConnecting || !inputUsername.trim() ? colors.mutedForeground : colors.primaryForeground}
                    style={{ marginRight: 8 }}
                  />
                  <Text
                    style={[
                      styles.connectBtnText,
                      { color: isConnecting || !inputUsername.trim() ? colors.mutedForeground : colors.primaryForeground },
                    ]}
                  >
                    {isConnecting ? "Connecting…" : "Connect Pi Wallet"}
                  </Text>
                </>
              )}
            </Pressable>
          </View>

          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.cardTitle, { color: colors.gold }]}>VAULT FEATURES</Text>
            {FEATURES.map(({ icon, label }) => (
              <View key={label} style={styles.featureRow}>
                <View style={[styles.featureIcon, { backgroundColor: colors.goldDim }]}>
                  <Ionicons name={icon} size={16} color={colors.gold} />
                </View>
                <Text style={[styles.featureLabel, { color: colors.foreground }]}>{label}</Text>
              </View>
            ))}
          </View>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: 16 },

  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 20,
  },
  sectionLabel: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 3,
    marginBottom: 2,
  },
  pageTitle: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
  },
  piIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  piSymbol: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
  },

  card: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
    marginBottom: 12,
  },
  cardTitle: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    letterSpacing: 2.5,
    marginBottom: 8,
  },
  cardDesc: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    lineHeight: 20,
    marginBottom: 16,
  },

  inputWrapper: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    height: 48,
    marginBottom: 12,
  },
  inputPrefix: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    marginRight: 8,
  },
  input: {
    flex: 1,
    fontSize: 15,
    height: "100%",
  },

  errorBox: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 12,
  },
  errorText: {
    flex: 1,
    fontSize: 12,
    fontFamily: "Inter_400Regular",
  },

  connectBtn: {
    borderRadius: 12,
    height: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  connectBtnText: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    letterSpacing: 1,
  },

  connectedCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 20,
    marginBottom: 12,
    alignItems: "center",
  },
  avatarCircle: {
    width: 68,
    height: 68,
    borderRadius: 34,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  avatarText: {
    fontSize: 26,
    fontFamily: "Inter_700Bold",
  },
  connectedLabel: {
    fontSize: 9,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 2.5,
    marginBottom: 4,
  },
  username: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    marginBottom: 4,
  },
  uid: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    letterSpacing: 0.5,
    marginBottom: 16,
  },
  divider: {
    height: 1,
    width: "100%",
    backgroundColor: "rgba(240, 192, 64, 0.10)",
    marginBottom: 16,
  },
  sessionInfo: {
    width: "100%",
    gap: 8,
    marginBottom: 16,
  },
  sessionRow: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  sessionLabel: {
    flex: 1,
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
  tokenDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  sessionValue: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },

  disconnectBtn: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  disconnectText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },

  featureRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 8,
    borderBottomWidth: 0,
  },
  featureIcon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  featureLabel: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
  },
});
