import React, { useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Download, Users, ShoppingCart, MessageSquare,
  FileSpreadsheet, Clock, CheckCircle2,
} from "lucide-react";

// ── CSV helper ──────────────────────────────────────────────
function convertToCSV(data, columns) {
  if (!data || data.length === 0) return "";

  const header = columns.map((c) => c.label).join(",");

  const rows = data.map((row) =>
    columns
      .map((c) => {
        const raw = typeof c.accessor === "function" ? c.accessor(row) : row[c.key];
        const value = raw == null ? "" : String(raw);
        // Escape double quotes and wrap in quotes if value contains comma, newline, or quote
        if (value.includes(",") || value.includes("\n") || value.includes('"')) {
          return `"${value.replace(/"/g, '""')}"`;
        }
        return value;
      })
      .join(",")
  );

  return [header, ...rows].join("\n");
}

// ── Download trigger ────────────────────────────────────────
function downloadCSV(csvString, filename) {
  const blob = new Blob([csvString], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

// ── Date formatter ──────────────────────────────────────────
function todayStamp() {
  const d = new Date();
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function formatTimestamp(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  return d.toLocaleString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── Column definitions ──────────────────────────────────────
const REGISTRATION_COLUMNS = [
  { key: "email", label: "Email" },
  { key: "full_name", label: "Full Name" },
  { key: "supporter_group", label: "Supporter Group" },
  { key: "created_date", label: "Created Date" },
];

const ORDER_COLUMNS = [
  { key: "id", label: "ID" },
  { key: "customer_email", label: "Customer Email" },
  { key: "customer_phone", label: "Customer Phone" },
  { key: "status", label: "Status" },
  { key: "total_aud", label: "Total (AUD)" },
  { key: "created_date", label: "Created Date" },
  {
    key: "items",
    label: "Items Summary",
    accessor: (row) => {
      if (!row.line_items || !Array.isArray(row.line_items)) return "";
      return row.line_items
        .map((item) => `${item.name || item.title || "Item"} x${item.quantity || 1}`)
        .join("; ");
    },
  },
];

const FORUM_COLUMNS = [
  { key: "id", label: "ID" },
  { key: "author_name", label: "Author Name" },
  { key: "title", label: "Title" },
  { key: "created_date", label: "Created Date" },
  { key: "is_published", label: "Published" },
  { key: "likes_count", label: "Likes" },
];

// ── localStorage keys ───────────────────────────────────────
const LS_KEYS = {
  registrations: "rlt_export_ts_registrations",
  orders: "rlt_export_ts_orders",
  forum: "rlt_export_ts_forum",
};

// ── Export card configs ─────────────────────────────────────
const EXPORT_CONFIGS = [
  {
    id: "registrations",
    title: "Interest Registrations",
    icon: Users,
    color: "text-cyan-400",
    accentBorder: "border-cyan-500/30",
    accentBg: "bg-cyan-500/10",
    columns: REGISTRATION_COLUMNS,
    filename: () => `rlt-registrations-${todayStamp()}.csv`,
    dataKey: "registrations",
  },
  {
    id: "orders",
    title: "Store Orders",
    icon: ShoppingCart,
    color: "text-emerald-400",
    accentBorder: "border-emerald-500/30",
    accentBg: "bg-emerald-500/10",
    columns: ORDER_COLUMNS,
    filename: () => `rlt-orders-${todayStamp()}.csv`,
    dataKey: "orders",
  },
  {
    id: "forum",
    title: "Forum Posts",
    icon: MessageSquare,
    color: "text-violet-400",
    accentBorder: "border-violet-500/30",
    accentBg: "bg-violet-500/10",
    columns: FORUM_COLUMNS,
    filename: () => `rlt-forum-posts-${todayStamp()}.csv`,
    dataKey: "forumPosts",
  },
];

// ── Single export card ──────────────────────────────────────
function ExportCard({ config, data, index }) {
  const [downloading, setDownloading] = useState(false);
  const [lastExport, setLastExport] = useState(() => {
    try {
      return localStorage.getItem(LS_KEYS[config.id]) || null;
    } catch {
      return null;
    }
  });

  const recordCount = Array.isArray(data) ? data.length : 0;
  const Icon = config.icon;

  const handleExport = useCallback(() => {
    if (recordCount === 0) return;

    setDownloading(true);
    const csv = convertToCSV(data, config.columns);
    downloadCSV(csv, config.filename());

    const ts = new Date().toISOString();
    try {
      localStorage.setItem(LS_KEYS[config.id], ts);
    } catch {
      // localStorage unavailable — silently ignore
    }
    setLastExport(ts);

    // Reset downloading animation after a beat
    setTimeout(() => setDownloading(false), 1200);
  }, [data, config, recordCount]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: 0.15 + index * 0.1 }}
      className="group relative border border-border/50 bg-muted/10 overflow-hidden rounded-none"
    >
      {/* Card top accent */}
      <div className="cmd-accent-bar h-[2px] w-full opacity-0 group-hover:opacity-100 transition-opacity" />

      <div className="p-5 flex flex-col h-full">
        {/* Icon + Title + Count */}
        <div className="flex items-start gap-3 mb-4">
          <div
            className={`flex h-10 w-10 shrink-0 items-center justify-center border ${config.accentBorder} ${config.accentBg} rounded-none`}
          >
            <Icon className={`h-5 w-5 ${config.color}`} />
          </div>
          <div className="min-w-0 flex-1">
            <h4 className="text-sm font-bold uppercase tracking-wide text-foreground">
              {config.title}
            </h4>
            <p className="mt-0.5 text-xs text-muted-foreground">
              <span className="font-display text-base tabular-nums text-foreground">
                {recordCount.toLocaleString()}
              </span>{" "}
              records
            </p>
          </div>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Last export timestamp */}
        <AnimatePresence>
          {lastExport && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="mb-3 flex items-center gap-1.5 text-[10px] text-muted-foreground/70"
            >
              <Clock className="h-3 w-3 shrink-0" />
              <span>
                Last export: {formatTimestamp(lastExport)}
              </span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Export button */}
        <motion.button
          type="button"
          onClick={handleExport}
          disabled={recordCount === 0 || downloading}
          whileHover={recordCount > 0 ? { scale: 1.02 } : {}}
          whileTap={recordCount > 0 ? { scale: 0.97 } : {}}
          className={`relative flex w-full items-center justify-center gap-2 border px-4 py-2.5 text-xs font-bold uppercase tracking-wider transition-all duration-300 rounded-none ${
            recordCount === 0
              ? "cursor-not-allowed border-border/30 bg-muted/5 text-muted-foreground/40"
              : downloading
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                : "border-primary/40 bg-primary/10 text-primary hover:bg-primary/20 hover:border-primary/60"
          }`}
        >
          <AnimatePresence mode="wait">
            {downloading ? (
              <motion.span
                key="check"
                initial={{ opacity: 0, scale: 0.5, rotate: -90 }}
                animate={{ opacity: 1, scale: 1, rotate: 0 }}
                exit={{ opacity: 0, scale: 0.5 }}
                transition={{ duration: 0.3 }}
                className="inline-flex"
              >
                <CheckCircle2 className="h-4 w-4" />
              </motion.span>
            ) : (
              <motion.span
                key="download"
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                transition={{ duration: 0.2 }}
                className="inline-flex"
              >
                <Download className="h-4 w-4" />
              </motion.span>
            )}
          </AnimatePresence>
          {downloading ? "Exported" : "Export CSV"}
        </motion.button>
      </div>
    </motion.div>
  );
}

// ── Main component ──────────────────────────────────────────
export default function DataExporter({ registrations = [], orders = [], forumPosts = [] }) {
  const dataMap = { registrations, orders, forumPosts };

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="border border-border bg-card/60 cmd-glass overflow-hidden rounded-none"
    >
      {/* Top accent bar */}
      <div className="h-[2px] w-full bg-gradient-to-r from-cyan-500 via-cyan-400 to-cyan-500" />

      <div className="p-5">
        {/* ── Header ── */}
        <div className="mb-5 flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center border border-cyan-500/30 bg-cyan-500/10 rounded-none">
            <FileSpreadsheet className="h-4 w-4 text-cyan-400" />
          </div>
          <div>
            <h3 className="font-display text-lg uppercase tracking-wide text-foreground leading-none">
              Data Export Centre
            </h3>
            <p className="mt-0.5 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
              Download platform data as CSV
            </p>
          </div>
          <Download className="ml-auto h-5 w-5 text-muted-foreground/40" />
        </div>

        {/* ── Export cards grid ── */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {EXPORT_CONFIGS.map((config, i) => (
            <ExportCard
              key={config.id}
              config={config}
              data={dataMap[config.dataKey]}
              index={i}
            />
          ))}
        </div>
      </div>
    </motion.div>
  );
}
