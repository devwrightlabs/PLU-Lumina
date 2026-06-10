import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import React, { useCallback, useState } from "react";
import {
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
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
import type { MultiSigTransaction, MultiSigTxStatus } from "@/types/lumina";

const STATUS_CONFIG: Record<
  MultiSigTxStatus,
  { label: string; color: string; icon: string }
> = {
  pending_owner: {
    label: "Your Signature Needed",
    color: "#fbbf24",
    icon: "pencil-outline",
  },
  pending_agent: {
    label: "Agent Signing…",
    color: "#60a5fa",
    icon: "sync-outline",
  },
  broadcasting: {
    label: "Broadcasting",
    color: "#a78bfa",
    icon: "radio-outline",
  },
  confirmed: {
    label: "Confirmed",
    color: "#4ade80",
    icon: "checkmark-circle-outline",
  },
  failed: {
    label: "Failed",
    color: "#f87171",
    icon: "close-circle-outline",
  },
};

const ACTIVE_STATUSES: MultiSigTxStatus[] = [
  "pending_owner",
  "pending_agent",
  "broadcasting",
];

function AnimatedStatusDot({ color, active }: { color: string; active: boolean }) {
  const opacity = useSharedValue(1);

  React.useEffect(() => {
    if (active) {
      opacity.value = withRepeat(
        withSequence(
          withTiming(0.2, { duration: 600 }),
          withTiming(1, { duration: 600 }),
        ),
        -1,
      );
    } else {
      opacity.value = 1;
    }
  }, [active, opacity]);

  const animStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      style={[{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }, animStyle]}
    />
  );
}

function TxCard({ tx, onSign, onDismiss }: {
  tx: MultiSigTransaction;
  onSign: (txId: string) => void;
  onDismiss: (txId: string) => void;
}) {
  const colors = useColors();
  const config = STATUS_CONFIG[tx.status];
  const isActive = ACTIVE_STATUSES.includes(tx.status);
  const shortId = tx.txId.length > 16 ? `${tx.txId.slice(0, 8)}…${tx.txId.slice(-6)}` : tx.txId;

  return (
    <View style={[styles.txCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={styles.txHeader}>
        <View style={styles.txHeaderLeft}>
          <AnimatedStatusDot color={config.color} active={isActive} />
          <Text style={[styles.txId, { color: colors.mutedForeground }]}>{shortId}</Text>
        </View>
        <TouchableOpacity onPress={() => onDismiss(tx.txId)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="close" size={16} color={colors.textDim} />
        </TouchableOpacity>
      </View>

      <View style={styles.txStatusRow}>
        <Ionicons name={config.icon as any} size={14} color={config.color} style={{ marginRight: 4 }} />
        <Text style={[styles.txStatus, { color: config.color }]}>{config.label}</Text>
      </View>

      {tx.xdrEnvelope && (
        <Text style={[styles.xdr, { color: colors.textDim }]} numberOfLines={1}>
          XDR: {tx.xdrEnvelope.slice(0, 24)}…
        </Text>
      )}

      <Text style={[styles.txTime, { color: colors.textDim }]}>
        {new Date(tx.updatedAt).toLocaleTimeString()}
      </Text>

      {tx.status === "pending_owner" && (
        <Pressable
          onPress={() => onSign(tx.txId)}
          style={({ pressed }) => [
            styles.signBtn,
            { backgroundColor: pressed ? "#D4A030" : colors.gold },
          ]}
        >
          <MaterialCommunityIcons name="pen" size={14} color={colors.primaryForeground} style={{ marginRight: 6 }} />
          <Text style={[styles.signBtnText, { color: colors.primaryForeground }]}>Sign Transaction</Text>
        </Pressable>
      )}
    </View>
  );
}

type SimStatus = MultiSigTxStatus;
const SIM_STATUSES: SimStatus[] = ["pending_owner", "pending_agent", "broadcasting", "confirmed", "failed"];

export default function MultiSigScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { multiSigTxs, upsertMultiSigTx, removeMultiSigTx } = useLumina();

  const [addMode, setAddMode] = useState(false);
  const [simStatusIdx, setSimStatusIdx] = useState(0);

  const topPad = Platform.OS === "web" ? 67 : insets.top;
  const bottomPad = Platform.OS === "web" ? 34 : 0;

  const txList = Object.values(multiSigTxs)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 20);

  const handleSign = useCallback(
    async (txId: string) => {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const tx = multiSigTxs[txId];
      if (tx && tx.status === "pending_owner") {
        upsertMultiSigTx({ ...tx, status: "pending_agent", updatedAt: new Date().toISOString() });
      }
    },
    [multiSigTxs, upsertMultiSigTx],
  );

  const handleDismiss = useCallback(
    async (txId: string) => {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      removeMultiSigTx(txId);
    },
    [removeMultiSigTx],
  );

  const handleAddDemoTx = useCallback(async () => {
    const txId = Date.now().toString() + Math.random().toString(36).substr(2, 6);
    const status = SIM_STATUSES[simStatusIdx % SIM_STATUSES.length];
    const newTx: MultiSigTransaction = {
      txId,
      status,
      updatedAt: new Date().toISOString(),
      xdrEnvelope: simStatusIdx % 2 === 0 ? `AAAA${txId.slice(0, 12)}...` : null,
    };
    upsertMultiSigTx(newTx);
    setSimStatusIdx((i) => i + 1);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setAddMode(false);
  }, [simStatusIdx, upsertMultiSigTx]);

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View style={[styles.headerArea, { paddingTop: topPad + 16 }]}>
        <View style={styles.headerRow}>
          <View>
            <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>VAULT</Text>
            <Text style={[styles.pageTitle, { color: colors.gold }]}>Multi-Sig</Text>
          </View>
          <Pressable
            onPress={() => setAddMode((v) => !v)}
            style={({ pressed }) => [
              styles.addBtn,
              { backgroundColor: pressed ? "#D4A030" : colors.gold, opacity: pressed ? 0.85 : 1 },
            ]}
          >
            <Ionicons name={addMode ? "close" : "add"} size={20} color={colors.primaryForeground} />
          </Pressable>
        </View>

        {addMode && (
          <View style={[styles.addCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.addCardTitle, { color: colors.gold }]}>SIMULATE TRANSACTION</Text>
            <Text style={[styles.addCardDesc, { color: colors.mutedForeground }]}>
              Add a demo multi-sig transaction to test the tracker. Status cycles through all states.
            </Text>
            <Pressable
              onPress={handleAddDemoTx}
              style={({ pressed }) => [
                styles.simBtn,
                { backgroundColor: pressed ? colors.goldDim : colors.goldDim, borderColor: colors.gold },
              ]}
            >
              <MaterialCommunityIcons name="plus-circle-outline" size={16} color={colors.gold} style={{ marginRight: 6 }} />
              <Text style={[styles.simBtnText, { color: colors.gold }]}>
                Add Demo — {SIM_STATUSES[simStatusIdx % SIM_STATUSES.length].replace("_", " ")}
              </Text>
            </Pressable>
          </View>
        )}

        <View style={styles.statsRow}>
          {[
            { label: "In-Flight", value: txList.filter((t) => ACTIVE_STATUSES.includes(t.status)).length },
            { label: "Confirmed", value: txList.filter((t) => t.status === "confirmed").length },
            { label: "Failed", value: txList.filter((t) => t.status === "failed").length },
          ].map(({ label, value }) => (
            <View key={label} style={[styles.statPill, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.statValue, { color: colors.gold }]}>{value}</Text>
              <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>{label}</Text>
            </View>
          ))}
        </View>
      </View>

      <FlatList
        data={txList}
        keyExtractor={(item) => item.txId}
        renderItem={({ item }) => (
          <TxCard tx={item} onSign={handleSign} onDismiss={handleDismiss} />
        )}
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: bottomPad + 100 },
        ]}
        scrollEnabled={!!txList.length}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <MaterialCommunityIcons name="shield-check-outline" size={40} color={colors.textDim} />
            <Text style={[styles.emptyTitle, { color: colors.mutedForeground }]}>No active transactions</Text>
            <Text style={[styles.emptyDesc, { color: colors.textDim }]}>
              In-flight vault transactions will appear here in real time
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },

  headerArea: {
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
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
  addBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },

  addCard: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    marginBottom: 12,
  },
  addCardTitle: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    letterSpacing: 2.5,
    marginBottom: 6,
  },
  addCardDesc: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
    marginBottom: 12,
  },
  simBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 10,
  },
  simBtnText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    textTransform: "capitalize",
  },

  statsRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 4,
  },
  statPill: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 8,
    alignItems: "center",
  },
  statValue: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
  },
  statLabel: {
    fontSize: 9,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1,
    marginTop: 2,
  },

  listContent: {
    paddingHorizontal: 16,
    paddingTop: 8,
  },

  txCard: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    marginBottom: 10,
  },
  txHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  txHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
  },
  txId: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    letterSpacing: 0.5,
    flex: 1,
  },
  txStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 6,
  },
  txStatus: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
  xdr: {
    fontSize: 10,
    fontFamily: "Inter_400Regular",
    letterSpacing: 0.3,
    marginBottom: 4,
  },
  txTime: {
    fontSize: 10,
    fontFamily: "Inter_400Regular",
    marginBottom: 10,
  },
  signBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
    paddingVertical: 10,
  },
  signBtnText: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.5,
  },

  emptyState: {
    alignItems: "center",
    paddingTop: 48,
    paddingHorizontal: 40,
  },
  emptyTitle: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    marginTop: 12,
    marginBottom: 6,
  },
  emptyDesc: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 20,
  },
});
