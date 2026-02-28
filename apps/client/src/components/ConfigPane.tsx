import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import type { DashboardTheme } from "./dashboardTypes";
import {
  fetchRuntimeConfig,
  type RuntimeConfigMutation,
  updateRuntimeConfig,
} from "../lib/pushpalsApi";

interface ConfigPaneProps {
  baseUrl: string;
  authToken?: string;
  theme: DashboardTheme;
}

interface FlatConfigEntry {
  key: string;
  value: unknown;
}

function flattenConfig(value: unknown, prefix = ""): FlatConfigEntry[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return prefix ? [{ key: prefix, value }] : [];
  }

  const out: FlatConfigEntry[] = [];
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${rawKey}` : rawKey;
    if (rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)) {
      out.push(...flattenConfig(rawValue, key));
      continue;
    }
    out.push({ key, value: rawValue });
  }
  return out;
}

function displayValue(value: unknown): string {
  if (typeof value === "string") return value;
  const json = JSON.stringify(value);
  return json === undefined ? String(value) : json;
}

function parseMutationValue(raw: string, parseAsJson: boolean): unknown {
  if (!parseAsJson) return raw;
  const text = raw.trim();
  if (!text) return "";
  return JSON.parse(text);
}

export function ConfigPane({ baseUrl, authToken, theme }: ConfigPaneProps) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [files, setFiles] = useState<{ envPath?: string; localTomlPath?: string }>({});
  const [scope, setScope] = useState<"env" | "toml">("toml");
  const [key, setKey] = useState("");
  const [valueText, setValueText] = useState("");
  const [filter, setFilter] = useState("");
  const [parseAsJson, setParseAsJson] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotice(null);
    const snapshot = await fetchRuntimeConfig(baseUrl, authToken);
    if (!snapshot) {
      setError("Failed to load runtime config. Check auth token/server.");
      setLoading(false);
      return;
    }
    setConfig(snapshot.config);
    setFiles(snapshot.files ?? {});
    setLoading(false);
  }, [authToken, baseUrl]);

  const apply = useCallback(async () => {
    const trimmedKey = key.trim();
    if (!trimmedKey) {
      setError("Key is required.");
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const parsedValue = scope === "env" ? valueText : parseMutationValue(valueText, parseAsJson);
      const mutation: RuntimeConfigMutation = {
        scope,
        key: trimmedKey,
        value: parsedValue,
      };
      const result = await updateRuntimeConfig(baseUrl, [mutation], authToken);
      if (!result) {
        setError("Failed to update runtime config.");
        setSaving(false);
        return;
      }
      setConfig(result.config);
      setFiles(result.files ?? {});
      const warningText = result.warnings.length > 0 ? ` Warnings: ${result.warnings.join(" | ")}` : "";
      const restartText = result.restartRequired ? " Restart required for some keys." : "";
      setNotice(`Applied ${result.applied.length} update(s).${restartText}${warningText}`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setError(`Invalid value format: ${detail}`);
    } finally {
      setSaving(false);
    }
  }, [authToken, baseUrl, key, parseAsJson, scope, valueText]);

  const entries = useMemo(() => {
    const all = flattenConfig(config ?? {});
    const needle = filter.trim().toLowerCase();
    if (!needle) return all.sort((a, b) => a.key.localeCompare(b.key));
    return all
      .filter((entry) => entry.key.toLowerCase().includes(needle))
      .sort((a, b) => a.key.localeCompare(b.key));
  }, [config, filter]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <View style={styles.container}>
      <View
        style={[
          styles.headerCard,
          {
            backgroundColor: theme.panel,
            borderColor: theme.border,
          },
        ]}
      >
        <Text style={[styles.title, { color: theme.text, fontFamily: theme.fontSans }]}>
          Runtime Config
        </Text>
        <Text style={[styles.meta, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
          env: {files.envPath ?? "--"} | local.toml: {files.localTomlPath ?? "--"}
        </Text>
        <View style={styles.row}>
          <Pressable
            onPress={load}
            style={[
              styles.button,
              { backgroundColor: theme.panelAlt, borderColor: theme.border },
              loading && styles.buttonDisabled,
            ]}
            disabled={loading}
          >
            <Text style={[styles.buttonText, { color: theme.text, fontFamily: theme.fontSans }]}>
              {loading ? "Loading..." : "Reload"}
            </Text>
          </Pressable>
        </View>
        {notice ? (
          <Text style={[styles.notice, { color: theme.positive, fontFamily: theme.fontSans }]}>
            {notice}
          </Text>
        ) : null}
        {error ? (
          <Text style={[styles.notice, { color: theme.danger, fontFamily: theme.fontSans }]}>
            {error}
          </Text>
        ) : null}
      </View>

      <View
        style={[
          styles.editorCard,
          {
            backgroundColor: theme.panel,
            borderColor: theme.border,
          },
        ]}
      >
        <Text style={[styles.label, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
          Update
        </Text>
        <View style={styles.row}>
          <Pressable
            onPress={() => setScope("toml")}
            style={[
              styles.scopeButton,
              {
                backgroundColor: scope === "toml" ? theme.accentSoft : theme.panelAlt,
                borderColor: scope === "toml" ? theme.accent : theme.border,
              },
            ]}
          >
            <Text
              style={[
                styles.scopeText,
                { color: scope === "toml" ? theme.accentText : theme.textMuted, fontFamily: theme.fontSans },
              ]}
            >
              TOML
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setScope("env")}
            style={[
              styles.scopeButton,
              {
                backgroundColor: scope === "env" ? theme.accentSoft : theme.panelAlt,
                borderColor: scope === "env" ? theme.accent : theme.border,
              },
            ]}
          >
            <Text
              style={[
                styles.scopeText,
                { color: scope === "env" ? theme.accentText : theme.textMuted, fontFamily: theme.fontSans },
              ]}
            >
              ENV
            </Text>
          </Pressable>
          <View style={styles.switchWrap}>
            <Text style={[styles.switchLabel, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
              JSON parse
            </Text>
            <Switch value={parseAsJson} onValueChange={setParseAsJson} />
          </View>
        </View>
        <TextInput
          value={key}
          onChangeText={setKey}
          placeholder={scope === "env" ? "PUSHPALS_SERVER_URL" : "remotebuddy.autonomy.tick_interval_ms"}
          placeholderTextColor={theme.textMuted}
          style={[
            styles.input,
            {
              color: theme.text,
              backgroundColor: theme.panelAlt,
              borderColor: theme.border,
              fontFamily: theme.fontMono,
            },
          ]}
          autoCapitalize="none"
        />
        <TextInput
          value={valueText}
          onChangeText={setValueText}
          placeholder={parseAsJson ? "\"string\" | 120000 | true | [1,2]" : "raw string"}
          placeholderTextColor={theme.textMuted}
          style={[
            styles.input,
            styles.valueInput,
            {
              color: theme.text,
              backgroundColor: theme.panelAlt,
              borderColor: theme.border,
              fontFamily: theme.fontMono,
            },
          ]}
          autoCapitalize="none"
          multiline
        />
        <View style={styles.row}>
          <Pressable
            onPress={apply}
            style={[
              styles.button,
              {
                backgroundColor: theme.accentSoft,
                borderColor: theme.accent,
              },
              saving && styles.buttonDisabled,
            ]}
            disabled={saving}
          >
            <Text style={[styles.buttonText, { color: theme.accentText, fontFamily: theme.fontSans }]}>
              {saving ? "Applying..." : "Apply"}
            </Text>
          </Pressable>
        </View>
      </View>

      <View
        style={[
          styles.listCard,
          {
            backgroundColor: theme.panel,
            borderColor: theme.border,
          },
        ]}
      >
        <TextInput
          value={filter}
          onChangeText={setFilter}
          placeholder="Filter keys..."
          placeholderTextColor={theme.textMuted}
          style={[
            styles.input,
            {
              color: theme.text,
              backgroundColor: theme.panelAlt,
              borderColor: theme.border,
              fontFamily: theme.fontSans,
            },
          ]}
          autoCapitalize="none"
        />
        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {entries.slice(0, 300).map((entry) => (
            <Pressable
              key={entry.key}
              onPress={() => {
                setScope("toml");
                setKey(entry.key);
                setValueText(displayValue(entry.value));
              }}
              style={[
                styles.entryRow,
                {
                  borderColor: theme.border,
                },
              ]}
            >
              <Text style={[styles.entryKey, { color: theme.text, fontFamily: theme.fontMono }]}>
                {entry.key}
              </Text>
              <Text style={[styles.entryValue, { color: theme.textMuted, fontFamily: theme.fontMono }]}>
                {displayValue(entry.value)}
              </Text>
            </Pressable>
          ))}
          {entries.length > 300 ? (
            <Text style={[styles.meta, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
              Showing first 300 keys. Use filter to narrow further.
            </Text>
          ) : null}
          {entries.length === 0 ? (
            <Text style={[styles.meta, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
              No keys matched.
            </Text>
          ) : null}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, minHeight: 0, paddingHorizontal: 20, paddingBottom: 20, gap: 10 },
  headerCard: { borderWidth: 1, borderRadius: 14, padding: 12, gap: 6 },
  editorCard: { borderWidth: 1, borderRadius: 14, padding: 12, gap: 8 },
  listCard: { borderWidth: 1, borderRadius: 14, padding: 12, flex: 1, minHeight: 0, gap: 8 },
  title: { fontSize: 18, fontWeight: "700" },
  meta: { fontSize: 12 },
  label: { fontSize: 12, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.8 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  scopeButton: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  scopeText: { fontSize: 12, fontWeight: "700" },
  switchWrap: { flexDirection: "row", alignItems: "center", marginLeft: "auto", gap: 6 },
  switchLabel: { fontSize: 12 },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 12,
  },
  valueInput: { minHeight: 72, textAlignVertical: "top" },
  button: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  buttonDisabled: { opacity: 0.65 },
  buttonText: { fontSize: 12, fontWeight: "700" },
  notice: { fontSize: 12, lineHeight: 18 },
  list: { flex: 1, minHeight: 0 },
  listContent: { gap: 6, paddingBottom: 6 },
  entryRow: { borderWidth: 1, borderRadius: 8, padding: 8, gap: 4 },
  entryKey: { fontSize: 11 },
  entryValue: { fontSize: 11 },
});
