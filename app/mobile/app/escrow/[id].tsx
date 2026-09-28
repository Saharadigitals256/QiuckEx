import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { useTheme } from "../../src/theme/ThemeContext";
import { fetchEscrowSummary, type EscrowSummary } from "../../services/escrow";

export default function EscrowDetailScreen() {
  const { theme } = useTheme();
  const params = useLocalSearchParams<{ id: string; status?: string }>();
  const [escrow, setEscrow] = useState<EscrowSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadEscrow = useCallback(async (isRefresh = false) => {
    if (!params.id) return;
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);

    try {
      setEscrow(await fetchEscrowSummary(params.id));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load escrow.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [params.id]);

  useEffect(() => {
    void loadEscrow();
  }, [loadEscrow]);

  const status = escrow
    ? escrow.released
      ? "Released"
      : escrow.refunded
        ? "Refunded"
        : escrow.expired
          ? "Expired"
          : "Pending"
    : params.status ?? "Unknown";

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void loadEscrow(true)} />}
      >
        <View
          style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}
        >
          <Text style={[styles.title, { color: theme.textPrimary }]}>Escrow Detail</Text>
          <Text style={[styles.id, { color: theme.textSecondary }]}>{escrow?.id ?? params.id}</Text>
          {loading ? <ActivityIndicator color={theme.textPrimary} /> : null}
          {error ? <Text style={[styles.error, { color: "#DC2626" }]}>{error}</Text> : null}
          {escrow ? (
            <>
              <View style={[styles.status, { borderColor: theme.border }]}>
                <Text style={[styles.label, { color: theme.textSecondary }]}>Status</Text>
                <Text style={[styles.statusValue, { color: theme.textPrimary }]}>{status}</Text>
              </View>
              <DetailRow label="Amount" value={`${escrow.amount} ${escrow.assetCode}`} theme={theme} />
              <DetailRow label="Depositor" value={escrow.depositor} theme={theme} />
              <DetailRow label="Beneficiary" value={escrow.beneficiary} theme={theme} />
              <DetailRow label="Expiry ledger" value={String(escrow.expiryLedger)} theme={theme} />
            </>
          ) : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function DetailRow({ label, value, theme }: { label: string; value: string; theme: { textPrimary: string; textSecondary: string } }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.label, { color: theme.textSecondary }]}>{label}</Text>
      <Text style={[styles.value, { color: theme.textPrimary }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 24 },
  card: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    gap: 16,
  },
  title: {
    fontSize: 22,
    fontWeight: "700",
  },
  id: { fontSize: 13 },
  status: { borderTopWidth: 1, borderBottomWidth: 1, paddingVertical: 12, gap: 4 },
  label: { fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5 },
  statusValue: { fontSize: 18, fontWeight: "700" },
  row: { gap: 4 },
  value: { fontSize: 15 },
  error: { fontSize: 15 },
});
