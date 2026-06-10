import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import React, { useCallback, useRef } from "react";
import {
  ActivityIndicator,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useLumina } from "@/context/LuminaContext";
import { useColors } from "@/hooks/useColors";

const VAULT_STATS = [
  { label: "Vault Status", key: "vault_status" },
  { label: "Multi-Sig", key: "multisig" },
  { label: "Network", key: "network" },
] as const;

const NETWORK_LISTENERS = [
  { chain: "Pi Network", status: "active" },
  { chain: "Bitcoin", status: "pending" },
  { chain: "Ethereum", status: "pending" },
  { chain: "Soroban RPC", status: "pending" },
] as const;

const BALANCE_ITEMS = [
  { label: "π  Pi", key: "pi" as const },
  { label: "piBTC", key: "piBTC" as const },
  { label: "piETH", key: "piETH" as const },
  { label: "piUSDT", key: "piUSDT" as const },
] as const;

function PulsingDot({ color }: { color: string }) {
  const opacity = useSharedValue(1);

  React.useEffect(() => {
    opacity.value = withRepeat(
      withSequence(
        withTiming(0.3, { duration: 800 }),
        withTiming(1, { duration: 800 }),
      ),
      -1,
    );
  }, [opacity]);

  const animStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      style={[{ width: 7, height: 7, borderRadius: 4, backgroundColor: color }, animStyle]}
    />
  );
}

function StaticDot({ color }: { color: string }) {
  return <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color }} />;
}

function BalanceCard({ label, value }: { label: string; value: string }) {
  const colors = useColors();
  return (
    <View style={[styles.balanceCard, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
      <Text style={[styles.balanceLabel, { color: colors.mutedForeground }]}>{label}</Text>
      <Text style={[styles.balanceValue, { color: colors.gold }]}>{value}</Text>
    </View>
  );
}

export default function DashboardScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { piSession, balances, isHydrated } = useLumina();
  const [refreshing, setRefreshing] = React.useState(false);

  const topPad = Platform.OS === "web" ? 67 : insets.top;
  const bottomPad = Platform.OS === "web" ? 34 : 0;

  const getVaultValue = useCallback(
    (key: string) => {
      if (key === "vault_status") {
        return piSession.status === "connected" ? "Active" : "Awaiting Auth";
      }
      if (key === "multisig") return "2-of-2";
      if (key === "network") return "Pi Mainnet";
      return "—";
    },
    [piSession.status],
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setTimeout(() => setRefreshing(false), 1200);
  }, []);

  if (!isHydrated) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.gold} size="large" />
      </View>
    );
  }

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: colors.background }]}
      contentContainerStyle={[
        styles.content,
        { paddingTop: topPad + 16, paddingBottom: bottomPad + 100 },
      ]}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.gold}
          colors={[colors.gold]}
        />
      }
    >
      <View style={styles.headerRow}>
        <View>
          <Text style={[styles.greeting, { color: colors.mutedForeground }]}>
            LUMINA VAULT
          </Text>
          <Text style={[styles.pageTitle, { color: colors.gold }]}>Dashboard</Text>
        </View>
        <View style={[styles.statusBadge, { backgroundColor: colors.goldDim, borderColor: colors.border }]}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: piSession.status === "connected" ? colors.success : colors.textDim, marginRight: 6 }} />
          <Text style={[styles.statusText, { color: piSession.status === "connected" ? colors.success : colors.mutedForeground }]}>
            {piSession.status === "connected" ? piSession.user?.username ?? "Connected" : "Not connected"}
          </Text>
        </View>
      </View>

      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.cardTitle, { color: colors.gold }]}>VAULT OVERVIEW</Text>
        <View style={styles.statsGrid}>
          {VAULT_STATS.map(({ label, key }) => (
            <View key={key} style={[styles.statCell, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
              <Text style={[styles.statLabel, { color: colors.textDim }]}>{label.toUpperCase()}</Text>
              <Text style={[styles.statValue, { color: colors.gold }]}>{getVaultValue(key)}</Text>
            </View>
          ))}
        </View>
      </View>

      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.cardHeaderRow}>
          <Text style={[styles.cardTitle, { color: colors.gold }]}>BALANCES</Text>
          <MaterialCommunityIcons name="wallet-outline" size={16} color={colors.mutedForeground} />
        </View>
        <View style={styles.balancesGrid}>
          {BALANCE_ITEMS.map(({ label, key }) => (
            <BalanceCard key={key} label={label} value={balances[key]} />
          ))}
        </View>
      </View>

      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.cardTitle, { color: colors.gold }]}>NETWORK LISTENERS</Text>
        <View style={styles.networkList}>
          {NETWORK_LISTENERS.map(({ chain, status }) => (
            <View key={chain} style={styles.networkRow}>
              {status === "active" ? (
                <PulsingDot color={colors.success} />
              ) : (
                <StaticDot color={colors.textDim} />
              )}
              <Text style={[styles.networkChain, { color: status === "active" ? colors.foreground : colors.mutedForeground }]}>
                {chain}
              </Text>
              <Text style={[styles.networkStatus, { color: status === "active" ? colors.success : colors.textDim }]}>
                {status}
              </Text>
            </View>
          ))}
        </View>
      </View>

      <View style={[styles.infoCard, { backgroundColor: colors.goldDim, borderColor: colors.border }]}>
        <Ionicons name="shield-checkmark-outline" size={18} color={colors.gold} style={{ marginBottom: 6 }} />
        <Text style={[styles.infoText, { color: colors.mutedForeground }]}>
          Zero-trust · Omnichain · 2-of-2 Multi-Sig
        </Text>
        <Text style={[styles.infoSubText, { color: colors.textDim }]}>
          All vault operations require dual authorization
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: 16 },
  loadingContainer: { flex: 1, alignItems: "center", justifyContent: "center" },

  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 20,
  },
  greeting: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 3,
    marginBottom: 2,
  },
  pageTitle: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.5,
  },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
  },
  statusText: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    letterSpacing: 0.5,
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
    marginBottom: 12,
  },
  cardHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },

  statsGrid: {
    flexDirection: "row",
    gap: 8,
  },
  statCell: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    padding: 10,
    alignItems: "flex-start",
  },
  statLabel: {
    fontSize: 9,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1.5,
    marginBottom: 4,
  },
  statValue: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
  },

  balancesGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  balanceCard: {
    width: "48%",
    borderRadius: 10,
    borderWidth: 1,
    padding: 12,
    alignItems: "center",
  },
  balanceLabel: {
    fontSize: 9,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1.5,
    marginBottom: 4,
  },
  balanceValue: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
  },

  networkList: { gap: 10 },
  networkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  networkChain: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  networkStatus: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    letterSpacing: 0.5,
  },

  infoCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    alignItems: "center",
    marginTop: 4,
  },
  infoText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1,
    textAlign: "center",
  },
  infoSubText: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    marginTop: 3,
    textAlign: "center",
  },
});
