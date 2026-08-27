import React, { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { format, addBusinessDays, formatDistanceToNow } from "date-fns";
import { motion, AnimatePresence } from "framer-motion";
import {
  Search, Download, DollarSign, ShoppingCart, Clock, PackageCheck, BadgeCheck,
  ChevronDown, Package, CreditCard, Truck, XCircle, CheckCircle2, RotateCcw,
  User, Copy, ExternalLink, MapPin, Info, AlertTriangle, CalendarDays,
  Pencil, Printer, Ban,
  Phone,
} from "lucide-react";
import { base44 } from "@/api/base44Client";
import { downloadCsv } from "@/lib/csv";
import { useAuth } from "@/lib/AuthContext";
import { toast } from "@/components/ui/use-toast";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import AdminConfirmSheet from "./shared/AdminConfirmSheet";
import OrderLabelSheet from "./OrderLabelSheet";
import CollectionRedeem from "./CollectionRedeem";

const statuses = ["pending", "paid", "packing", "shipped", "completed", "cancelled", "refunded", "partially_refunded"];
// Statuses an admin sets by hand via the dropdown. Cancel/refund states are
// driven by the dedicated Cancel/Refund actions (which move money + stock), so
// they're intentionally excluded here to prevent a "fake" status flip.
const MANUAL_STATUSES = ["pending", "paid", "packing", "shipped", "completed"];
const paidLike = ["paid", "packing", "shipped", "completed"];
// 'cancelled' is refundable: cancelling never auto-refunds, so the money is
// still owed and must be returnable afterwards.
const refundable = ["paid", "packing", "shipped", "completed", "partially_refunded", "cancelled"];
const toFulfil = ["paid", "packing"];
const allowedTransitions = {
  pending: [],
  paid: ["packing", "shipped"],
  packing: ["shipped"],
  shipped: ["completed"],
  completed: [],
};

const statusConfig = {
  pending:   { label: "Pending",   icon: Clock,         color: "border-amber-500/30 text-amber-400 bg-amber-500/5",      dot: "bg-amber-400" },
  paid:      { label: "Paid",      icon: CreditCard,    color: "border-emerald-500/30 text-emerald-400 bg-emerald-500/5",  dot: "bg-emerald-400" },
  packing:   { label: "Packing",   icon: Package,       color: "border-sky-500/30 text-sky-400 bg-sky-500/5",              dot: "bg-sky-400" },
  shipped:   { label: "Shipped",   icon: Truck,         color: "border-blue-500/30 text-blue-400 bg-blue-500/5",           dot: "bg-blue-400" },
  completed: { label: "Delivered", icon: CheckCircle2,  color: "border-emerald-500/30 text-emerald-400 bg-emerald-500/5",  dot: "bg-emerald-400" },
  cancelled: { label: "Cancelled", icon: XCircle,       color: "border-destructive/30 text-destructive bg-destructive/5",  dot: "bg-destructive" },
  refunded:  { label: "Refunded",  icon: RotateCcw,     color: "border-destructive/30 text-destructive bg-destructive/5",  dot: "bg-destructive" },
  partially_refunded: { label: "Part. Refunded", icon: RotateCcw, color: "border-amber-500/30 text-amber-400 bg-amber-500/5", dot: "bg-amber-400" },
};

const getStatusConfig = (s) => statusConfig[s] || statusConfig.pending;

/* Shipping method config */
const SHIPPING_METHODS = {
  standard: { label: "Standard (7–10 business days)", days: 10 },
  express:  { label: "Express (3–5 business days)",   days: 5 },
  priority: { label: "Priority (1–2 business days)",  days: 2 },
};

/* Pipeline tabs */
const PIPELINE_TABS = [
  { key: "all",       label: "All" },
  { key: "unfulfilled", label: "Unfulfilled", statuses: ["paid"] },
  { key: "packing",   label: "Packing",   statuses: ["packing"] },
  { key: "shipped",   label: "Shipped",   statuses: ["shipped"] },
  { key: "completed", label: "Delivered", statuses: ["completed"] },
  { key: "other",     label: "Other",     statuses: ["pending", "cancelled", "refunded"] },
];

/* Carrier presets */
const CARRIERS = ["Australia Post", "DHL", "FedEx", "UPS", "USPS", "StarTrack", "Aramex", "Other"];

/* Helper: build a timeline entry */
function makeTimelineEntry(action, actor, note) {
  return { action, timestamp: new Date().toISOString(), actor: actor || "system", ...(note ? { note } : {}) };
}

/* Prefer the structured destination fields captured by paid Stripe Checkout. */
function structuredAddressLines(order) {
  const line2Parts = [order.shipping_suburb, order.shipping_state, order.shipping_postcode].filter(Boolean).join(" ");
  const lines = [
    order.shipping_name || order.customer_name,
    order.shipping_address_line1,
    order.shipping_address_line2,
    line2Parts,
    order.shipping_country,
  ].filter(Boolean);
  return lines;
}
function hasStructuredAddress(order) {
  return Boolean(
    String(order.shipping_address_line1 || "").trim()
    && String(order.shipping_suburb || "").trim()
    && String(order.shipping_state || "").trim()
    && /^\d{4}$/.test(String(order.shipping_postcode || "").trim())
    && String(order.shipping_country || "").trim().toUpperCase() === "AU"
  );
}
function orderAddressText(order) {
  const lines = structuredAddressLines(order);
  if (lines.length > 1) return lines.join("\n");
  return order.shipping_address || "";
}
/* The contact number for this order — captured from Stripe Checkout at payment
   time (migration 0037). Orders paid before that column existed are backfilled
   server-side (from the Stripe session, or from the customer's travel enquiry /
   profile where they gave us one), so this stays a single field read. */
function orderPhone(order) {
  return String(order.customer_phone || "").trim();
}

function safeTrackingUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

/* ── Prominent customer address block (with copy) ── */
function AddressBlock({ order }) {
  const structured = hasStructuredAddress(order);
  const text = orderAddressText(order);

  // A pickup order is collected in person, so it has no delivery address.
  if (order.fulfilment_method === "pickup") {
    return (
      <div className="border border-emerald-500/30 bg-emerald-500/[0.06] p-3">
        <p className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-[0.2em] text-emerald-400">
          <MapPin className="h-3 w-3" /> Collect in Las Vegas
        </p>
        <p className="mt-1.5 text-sm text-foreground">No delivery — customer collects at the event.</p>
        {text && <p className="mt-1 whitespace-pre-line text-[11px] leading-relaxed text-slate-300">{text}</p>}
      </div>
    );
  }
  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(text || "");
      toast({ title: "Address copied" });
    } catch (err) {
      toast({ title: "Copy failed", description: err.message, variant: "destructive" });
    }
  };
  return (
    <div className={`border p-3 ${structured ? "border-primary/25 bg-primary/[0.04]" : "border-amber-500/30 bg-amber-500/[0.05]"}`}>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-[0.2em] text-muted-foreground/60">
          <MapPin className="h-3 w-3 text-primary" /> Ship To
        </p>
        {text && (
          <button type="button" onClick={copyAddress} className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-muted-foreground/50 hover:text-foreground">
            <Copy className="h-2.5 w-2.5" /> Copy
          </button>
        )}
      </div>
      {text ? (
        <address className="not-italic whitespace-pre-line text-sm leading-relaxed text-foreground">{text}</address>
      ) : (
        <p className="text-[11px] italic text-amber-400/80">No shipping address on file for this order.</p>
      )}
      {!structured && text && (
        <p className="mt-2 flex items-center gap-1 text-[10px] text-amber-400/80">
          <AlertTriangle className="h-2.5 w-2.5" /> Complete the structured address fields before printing or marking this order shipped.
        </p>
      )}
    </div>
  );
}

/* ── Inline editor for customer + structured shipping address ── */
function OrderEditForm({ editFields, setEditFields, onSave, onCancel }) {
  const set = (k) => (e) => setEditFields((f) => ({ ...f, [k]: e.target.value }));
  const field = (k, label, placeholder, cls = "") => (
    <div className={`space-y-1 ${cls}`}>
      <label className="text-[9px] font-bold uppercase tracking-[0.2em] text-muted-foreground/50">{label}</label>
      <Input value={editFields[k] || ""} onChange={set(k)} placeholder={placeholder} className="h-10 rounded-none border-border/40 text-sm" />
    </div>
  );
  return (
    <div className="border border-primary/25 bg-primary/[0.03] p-3 space-y-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {field("customer_name", "Customer name", "Full name")}
        {field("customer_email", "Email", "name@example.com")}
      </div>
      <div className="grid grid-cols-1 gap-2 border-t border-border/20 pt-3 sm:grid-cols-2">
        {field("shipping_name", "Ship-to name", "Recipient", "sm:col-span-2")}
        {field("shipping_address_line1", "Address line 1", "Street address", "sm:col-span-2")}
        {field("shipping_address_line2", "Address line 2", "Unit / apt (optional)", "sm:col-span-2")}
        {field("shipping_suburb", "Suburb / City", "Suburb")}
        {field("shipping_state", "State", "e.g. NSW")}
        {field("shipping_postcode", "Postcode", "e.g. 2000")}
        {field("shipping_country", "Country", "AU")}
      </div>
      <div className="flex items-center gap-2">
        <Button onClick={onSave} className="h-10 rounded-none bg-primary hover:bg-primary/90 text-[9px] font-bold uppercase tracking-wider">
          <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" /> Save details
        </Button>
        <Button variant="outline" onClick={onCancel} className="h-10 rounded-none border-border/30 text-[9px] font-bold uppercase tracking-wider">Cancel</Button>
      </div>
    </div>
  );
}

/* Guard before opening the label preview. The label itself is rendered in-page
   by OrderLabelSheet — the old pop-up printer opened a blank about:blank tab in
   Android WebViews with no way to print. */
function canPrintPackingSlip(order) {
  if (order.fulfilment_method === "shipping" && !hasStructuredAddress(order)) {
    toast({ title: "Complete address required", description: "Add the full structured Australian delivery address before printing.", variant: "destructive" });
    return false;
  }
  return true;
}

/* Helper: calculate estimated delivery */
function calcEstimatedDelivery(shippedAt, shippingMethod) {
  if (!shippedAt) return null;
  const method = SHIPPING_METHODS[shippingMethod] || SHIPPING_METHODS.standard;
  return format(addBusinessDays(new Date(shippedAt), method.days), "yyyy-MM-dd");
}

/* ── Stat Card ── */
function StatCard({ icon: Icon, label, value, accent }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="border border-border/40 bg-card/30 cmd-glass p-4"
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-muted-foreground/50">{label}</p>
          <p className={`mt-1 font-display text-2xl tabular-nums ${accent || "text-foreground"}`}>{value}</p>
        </div>
        <div className="p-2 bg-muted/10 border border-border/20">
          <Icon className="h-4 w-4 text-primary/50" />
        </div>
      </div>
    </motion.div>
  );
}

/* ── Order Status Progress Stepper ── */
const STEPPER_STEPS = [
  { key: "pending",   label: "Pending",   icon: Clock,        matchStatuses: ["pending"] },
  { key: "paid",      label: "Confirmed", icon: CheckCircle2, matchStatuses: ["paid", "packing"] },
  { key: "shipped",   label: "Shipped",   icon: Truck,        matchStatuses: ["shipped"] },
  { key: "completed", label: "Delivered", icon: PackageCheck,  matchStatuses: ["completed"] },
];

function getStepperIndex(status) {
  const idx = STEPPER_STEPS.findIndex((s) => s.matchStatuses.includes(status));
  return idx >= 0 ? idx : -1;
}

function OrderStatusStepper({ order }) {
  const currentStatus = order.status || "pending";
  const isCancelled = currentStatus === "cancelled" || currentStatus === "refunded";
  const currentIdx = getStepperIndex(currentStatus);

  // Gather timestamps for each step
  const stepTimestamps = {
    pending:   order.created_date,
    paid:      order.payment_verified_at || (["paid","packing","shipped","completed"].includes(currentStatus) ? order.created_date : null),
    shipped:   order.shipped_at,
    completed: order.delivered_at,
  };

  if (isCancelled) return null;

  return (
    <div className="flex items-start w-full gap-0">
      {STEPPER_STEPS.map((step, i) => {
        const StepIcon = step.icon;
        const isCompleted = i < currentIdx;
        const isCurrent = i === currentIdx;
        const isFuture = i > currentIdx;
        const ts = stepTimestamps[step.key];

        return (
          <React.Fragment key={step.key}>
            <div className="flex flex-col items-center min-w-0 flex-1">
              {/* Circle / icon */}
              <div
                className={`relative flex items-center justify-center h-7 w-7 rounded-full border-2 transition-all duration-500 ${
                  isCompleted
                    ? "bg-emerald-500 border-emerald-500 text-white"
                    : isCurrent
                      ? "bg-primary border-primary text-white ring-4 ring-primary/20"
                      : "bg-muted/10 border-border/40 text-muted-foreground/30"
                }`}
              >
                {isCompleted ? (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                ) : (
                  <StepIcon className="h-3.5 w-3.5" />
                )}
              </div>

              {/* Label */}
              <span
                className={`mt-1.5 text-[8px] font-bold uppercase tracking-wider whitespace-nowrap transition-colors duration-300 ${
                  isCompleted
                    ? "text-emerald-400"
                    : isCurrent
                      ? "text-primary"
                      : "text-muted-foreground/30"
                }`}
              >
                {step.label}
              </span>

              {/* Timestamp */}
              {ts && !isFuture && (
                <span className="mt-0.5 text-[7px] font-mono text-muted-foreground/30 whitespace-nowrap">
                  {format(new Date(ts), "dd MMM HH:mm")}
                </span>
              )}
            </div>

            {/* Connector line */}
            {i < STEPPER_STEPS.length - 1 && (
              <div className="flex items-center pt-3.5 flex-shrink-0" style={{ width: "24px" }}>
                <div
                  className={`h-[2px] w-full transition-colors duration-500 ${
                    i < currentIdx ? "bg-emerald-500" : "bg-border/30"
                  }`}
                />
              </div>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}


/* ── Order Timeline ── */
function OrderTimeline({ timeline }) {
  if (!timeline || timeline.length === 0) return null;
  const sorted = [...timeline].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  return (
    <div className="space-y-1">
      <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-muted-foreground/50 mb-2">Order Timeline</p>
      <div className="relative pl-4 space-y-3">
        {/* Vertical line */}
        <div className="absolute left-[5px] top-1 bottom-1 w-px bg-border/20" />
        {sorted.map((entry, i) => (
          <div key={i} className="relative flex gap-3">
            {/* Dot */}
            <div className={`absolute left-[-11px] top-1.5 h-2.5 w-2.5 rounded-full border-2 ${
              i === 0 ? "bg-primary border-primary/50" : "bg-muted-foreground/20 border-muted-foreground/10"
            }`} />
            <div className="min-w-0 flex-1">
              <p className={`text-xs font-semibold ${i === 0 ? "text-foreground" : "text-muted-foreground/60"}`}>
                {entry.action}
              </p>
              {entry.note && (
                <p className="text-[10px] text-muted-foreground/50 mt-0.5">{entry.note}</p>
              )}
              <div className="flex items-center gap-2 mt-0.5 text-[9px] text-muted-foreground/30">
                {entry.timestamp && (
                  <span>{formatDistanceToNow(new Date(entry.timestamp), { addSuffix: true })}</span>
                )}
                {entry.actor && (
                  <span className="flex items-center gap-0.5">
                    <User className="h-2 w-2" /> {entry.actor}
                  </span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Order Card ── */
function OrderCard({ order, onUpdate, index, actorEmail }) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [trackingNumber, setTrackingNumber] = useState(order.tracking_number || "");
  const [trackingUrl, setTrackingUrl] = useState(order.tracking_url || "");
  const [carrier, setCarrier] = useState(order.carrier || "");
  const [notes, setNotes] = useState(order.shipping_notes || "");
  const [customerNote, setCustomerNote] = useState(order.customer_status_note || "");
  const [confirmAction, setConfirmAction] = useState(null);
  const [showRefundForm, setShowRefundForm] = useState(false);
  const [refundAmount, setRefundAmount] = useState(Math.max(0, Number(order.total_aud || 0) - Number(order.refund_amount || 0)));
  const [refundReason, setRefundReason] = useState("");
  const [showCancelForm, setShowCancelForm] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [labelOpen, setLabelOpen] = useState(false);
  const openLabel = () => { if (canPrintPackingSlip(order)) setLabelOpen(true); };
  const [editMode, setEditMode] = useState(false);
  const [editFields, setEditFields] = useState({
    customer_name: order.customer_name || "",
    customer_email: order.customer_email || "",
    shipping_name: order.shipping_name || order.customer_name || "",
    shipping_address_line1: order.shipping_address_line1 || "",
    shipping_address_line2: order.shipping_address_line2 || "",
    shipping_suburb: order.shipping_suburb || "",
    shipping_state: order.shipping_state || "",
    shipping_postcode: order.shipping_postcode || "",
    shipping_country: order.shipping_country || "AU",
  });

  // Real Stripe refund (server-authoritative). Replaces the old data-only write.
  const refundMutation = useMutation({
    mutationFn: ({ amount, reason }) => base44.functions.invoke("stripeRefund", { orderId: order.id, amount, reason }),
    onSuccess: ({ data }) => {
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      setShowRefundForm(false);
      setRefundReason("");
      toast({
        title: data?.isFull ? "Refund issued" : "Partial refund issued",
        description: `$${Number(data?.refundedAmount || 0).toFixed(2)} AUD refunded via Stripe${data?.restocked ? " · items restocked" : ""}.`,
      });
    },
    onError: (error) => toast({ title: "Refund failed", description: error.message, variant: "destructive" }),
  });

  // Cancel (marks cancelled + restocks a paid order; no auto-refund by policy).
  const cancelMutation = useMutation({
    mutationFn: ({ reason }) => base44.functions.invoke("cancelOrder", { orderId: order.id, reason }),
    onSuccess: ({ data }) => {
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      setShowCancelForm(false);
      setCancelReason("");
      toast({
        title: "Order cancelled",
        description: `${data?.restocked ? "Items restocked. " : ""}${data?.wasPaid ? "This was a paid order — issue a refund separately if money is owed." : ""}`.trim() || "Order cancelled.",
      });
    },
    onError: (error) => toast({ title: "Cancel failed", description: error.message, variant: "destructive" }),
  });

  const saveEdit = () => {
    const line1Parts = [editFields.shipping_address_line1, editFields.shipping_address_line2].filter(Boolean).join(", ");
    const cityParts = [editFields.shipping_suburb, editFields.shipping_state, editFields.shipping_postcode].filter(Boolean).join(" ");
    const rebuilt = [editFields.shipping_name || editFields.customer_name, line1Parts, cityParts, editFields.shipping_country].filter(Boolean).join(", ");
    const existingTimeline = [...timeline];
    existingTimeline.push(makeTimelineEntry("Order details edited", actorEmail, "Customer / shipping details updated by admin"));
    onUpdate(order.id, {
      ...editFields,
      shipping_address: rebuilt || order.shipping_address || "",
      timeline: existingTimeline,
    });
    setEditMode(false);
  };

  const status = getStatusConfig(order.status || "pending");
  const StatusIcon = status.icon;
  const lineItems = order.line_items || [];
  const isFulfillable = paidLike.includes(order.status) && order.status !== "completed";
  const timeline = order.timeline || [];
  const refundedSoFar = Number(order.refund_amount || 0);
  const refundRemaining = Math.max(0, Number(order.total_aud || 0) - refundedSoFar);
  const canRefund = refundable.includes(order.status) && refundRemaining > 0 && !!order.stripe_session_id;
  const canCancel = order.status !== "cancelled" && order.status !== "refunded";
  const isDelivery = order.fulfilment_method === "shipping";
  const hasShippingAddress = !isDelivery || hasStructuredAddress(order);
  const nextStatuses = isDelivery
    ? (allowedTransitions[order.status || "pending"] || [])
    : ["paid", "packing"].includes(order.status) ? ["packing", "completed"] : allowedTransitions[order.status || "pending"] || [];
  const manualOptions = [...new Set([order.status, ...nextStatuses])].filter((value) => MANUAL_STATUSES.includes(value));

  const validateShipping = () => {
    if (!isDelivery) return true;
    if (!hasShippingAddress) {
      toast({ title: "Complete shipping address required", description: "Add street, suburb, state, four-digit postcode and AU country before shipping.", variant: "destructive" });
      setExpanded(true);
      return false;
    }
    if (!trackingNumber.trim() || !carrier) {
      toast({ title: "Tracking details required", description: "Choose a carrier and enter the tracking number before shipping.", variant: "destructive" });
      setExpanded(true);
      return false;
    }
    return true;
  };

  const handleQuickAction = (newStatus) => {
    if (newStatus === "shipped" && !validateShipping()) return;
    setConfirmAction({
      status: newStatus,
      label: `Mark as ${getStatusConfig(newStatus).label}?`,
    });
  };

  const executeAction = () => {
    // Refund/cancel confirmations carry a `run` callback (money/stock actions).
    if (confirmAction?.run) {
      confirmAction.run();
      setConfirmAction(null);
      return;
    }
    const data = { status: confirmAction.status };
    const existingTimeline = [...timeline];

    if (confirmAction.status === "shipped") {
      if (!validateShipping()) {
        setConfirmAction(null);
        return;
      }
      const verifiedUrl = safeTrackingUrl(trackingUrl);
      if (trackingUrl && !verifiedUrl) {
        toast({ title: "Invalid tracking link", description: "Tracking links must use HTTPS.", variant: "destructive" });
        return;
      }
      data.tracking_number = trackingNumber.trim().slice(0, 160);
      data.tracking_url = verifiedUrl;
      data.carrier = carrier;
      data.shipped_at = new Date().toISOString();
      // Auto-calculate estimated delivery
      const method = order.shipping_method || "standard";
      if (!order.estimated_delivery) {
        data.estimated_delivery = calcEstimatedDelivery(data.shipped_at, method);
      }
    }
    if (confirmAction.status === "completed") {
      data.delivered_at = new Date().toISOString();
    }

    // Auto-timeline entry
    existingTimeline.push(makeTimelineEntry(
      `Status changed to ${getStatusConfig(confirmAction.status).label}`,
      actorEmail
    ));
    data.timeline = existingTimeline;

    onUpdate(order.id, data);
    setConfirmAction(null);
  };

  const handleStatusChange = (value) => {
    if (!manualOptions.includes(value) || value === order.status) return;
    if (value === "shipped" && !validateShipping()) return;
    const existingTimeline = [...timeline];
    const data = { status: value };

    if (value === "shipped" && !order.shipped_at) {
      const verifiedUrl = safeTrackingUrl(trackingUrl);
      if (trackingUrl && !verifiedUrl) {
        toast({ title: "Invalid tracking link", description: "Tracking links must use HTTPS.", variant: "destructive" });
        return;
      }
      data.tracking_number = trackingNumber.trim().slice(0, 160);
      data.tracking_url = verifiedUrl;
      data.carrier = carrier;
      data.shipped_at = new Date().toISOString();
      const method = order.shipping_method || "standard";
      if (!order.estimated_delivery) {
        data.estimated_delivery = calcEstimatedDelivery(data.shipped_at, method);
      }
    }
    if (value === "completed" && !order.delivered_at) {
      data.delivered_at = new Date().toISOString();
    }

    existingTimeline.push(makeTimelineEntry(
      `Status changed to ${getStatusConfig(value).label}`,
      actorEmail
    ));
    data.timeline = existingTimeline;

    onUpdate(order.id, data);
  };

  const handleShippingMethodChange = (value) => {
    const data = { shipping_method: value };
    // If already shipped and no manual estimated_delivery override, recalculate
    if (order.shipped_at) {
      data.estimated_delivery = calcEstimatedDelivery(order.shipped_at, value);
    }
    onUpdate(order.id, data);
  };

  const handleRefundConfirm = () => {
    const amt = Number(refundAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
      toast({ title: "Enter a valid amount", description: "Refund must be greater than $0.", variant: "destructive" });
      return;
    }
    if (amt > refundRemaining + 0.005) {
      toast({ title: "Amount too high", description: `Only $${refundRemaining.toFixed(2)} AUD is left to refund on this order.`, variant: "destructive" });
      return;
    }
    // Final confirm before real money moves via Stripe.
    setConfirmAction({
      label: `Refund $${amt.toFixed(2)} AUD to ${order.customer_name || "the customer"}?`,
      run: () => refundMutation.mutate({ amount: amt, reason: refundReason }),
    });
  };

  const handleCancelConfirm = () => {
    setConfirmAction({
      label: `Cancel order #${String(order.id || "").slice(-6).toUpperCase()}?`,
      run: () => cancelMutation.mutate({ reason: cancelReason }),
    });
  };

  const copyOrderSummary = async () => {
    const items = lineItems.map((i) => `${i.quantity}x ${i.name}`).join(", ");
    const phoneLine = orderPhone(order) ? `\n${orderPhone(order)}` : "";
    const summary = `Order #${String(order.id || "").slice(-6).toUpperCase()}\n${order.customer_name || "Customer"}\n${order.customer_email || ""}${phoneLine}\n${order.shipping_address || ""}\nItems: ${items}\nTotal: $${Number(order.total_aud || 0).toFixed(2)} AUD`;
    try {
      await navigator.clipboard.writeText(summary);
      toast({ title: "Copied", description: "Order summary copied to clipboard." });
    } catch (err) {
      toast({ title: "Copy failed", description: err.message, variant: "destructive" });
    }
  };

  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: Math.min(index * 0.04, 0.25), duration: 0.3 }}
        className="group relative border border-border/60 bg-card/30 overflow-hidden"
      >
        {/* Top accent */}
        <div className={`h-[2px] w-full ${
          paidLike.includes(order.status) ? "bg-gradient-to-r from-emerald-500/60 to-emerald-500/20"
          : order.status === "cancelled" || order.status === "refunded" ? "bg-gradient-to-r from-destructive/60 to-destructive/20"
          : "bg-gradient-to-r from-amber-500/60 to-amber-500/20"
        }`} />

        {/* Summary row */}
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-muted/5 sm:gap-4"
        >
          <div className={`shrink-0 p-2 border ${status.color}`}>
            <StatusIcon className="h-4 w-4" />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 mb-0.5">
              <h4 className="text-sm font-bold text-foreground">
                {order.customer_name || "Customer"}
              </h4>
              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider border ${status.color}`}>
                <span className={`h-1 w-1 rounded-full ${status.dot}`} />
                {status.label}
              </span>
              {order.payment_verified_at && (
                <span className="inline-flex items-center gap-0.5 text-[8px] font-bold uppercase tracking-wider text-emerald-400">
                  <BadgeCheck className="h-2.5 w-2.5" /> Verified
                </span>
              )}
              {order.tracking_number && (
                <span className="inline-flex items-center gap-0.5 text-[8px] font-bold uppercase tracking-wider text-blue-400">
                  <Truck className="h-2.5 w-2.5" /> Tracked
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3 text-[9px] text-muted-foreground/40">
              <span className="font-mono tabular-nums">
                {order.created_date ? format(new Date(order.created_date), "dd MMM yyyy") : "New"}
              </span>
              <span className="flex items-center gap-1">
                <User className="h-2.5 w-2.5" />
                {order.customer_email || "—"}
              </span>
              {orderPhone(order) && (
                <a
                  href={`tel:${orderPhone(order).replace(/[^\d+]/g, "")}`}
                  className="flex items-center gap-1 hover:text-primary transition-colors"
                  title="Call this customer"
                >
                  <Phone className="h-2.5 w-2.5" />
                  {orderPhone(order)}
                </a>
              )}
              <span className="flex items-center gap-1">
                <Package className="h-2.5 w-2.5" />
                {lineItems.length} {lineItems.length === 1 ? "item" : "items"}
              </span>
            </div>
          </div>

          {/* Quick actions (desktop) — prevent button bubbling */}
          {isFulfillable && (
            <div className="hidden md:flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
              {order.status === "paid" && (
                <Button
                  size="sm"
                  onClick={() => handleQuickAction("packing")}
                  className="h-8 rounded-none bg-sky-600 hover:bg-sky-500 text-[9px] font-bold uppercase tracking-wider text-white"
                >
                  <Package className="mr-1 h-3 w-3" /> Pack
                </Button>
              )}
              {isDelivery && (order.status === "paid" || order.status === "packing") && (
                <Button
                  size="sm"
                  onClick={() => handleQuickAction("shipped")}
                  className="h-8 rounded-none bg-blue-600 hover:bg-blue-500 text-[9px] font-bold uppercase tracking-wider text-white"
                >
                  <Truck className="mr-1 h-3 w-3" /> Ship
                </Button>
              )}
              {!isDelivery && (order.status === "paid" || order.status === "packing") && (
                <Button
                  size="sm"
                  onClick={() => handleQuickAction("completed")}
                  className="h-8 rounded-none bg-emerald-600 hover:bg-emerald-500 text-[9px] font-bold uppercase tracking-wider text-white"
                >
                  <CheckCircle2 className="mr-1 h-3 w-3" /> {order.fulfilment_method === "pickup" ? "Collected" : "Complete"}
                </Button>
              )}
              {order.status === "shipped" && (
                <Button
                  size="sm"
                  onClick={() => handleQuickAction("completed")}
                  className="h-8 rounded-none bg-emerald-600 hover:bg-emerald-500 text-[9px] font-bold uppercase tracking-wider text-white"
                >
                  <CheckCircle2 className="mr-1 h-3 w-3" /> Delivered
                </Button>
              )}
            </div>
          )}

          <div className="shrink-0 text-right">
            <p className="font-display text-lg tabular-nums text-foreground">
              ${Number(order.total_aud || 0).toFixed(2)}
            </p>
            <p className="text-[8px] font-bold uppercase tracking-wider text-muted-foreground/30">AUD</p>
          </div>

          <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground/20 transition-transform ${expanded ? "rotate-180" : ""}`} />
        </button>

        {/* Expanded details */}
        <AnimatePresence>
          {expanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div className="border-t border-border/20 p-4 md:p-5 space-y-4">
                {/* Order Status Stepper */}
                {order.status !== "cancelled" && order.status !== "refunded" && (
                  <div className="border border-border/20 bg-muted/5 p-3">
                    <OrderStatusStepper order={order} />
                  </div>
                )}

                {/* Line items */}
                {lineItems.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-muted-foreground/50 mb-2">Items</p>
                    {lineItems.map((item, i) => (
                      <div key={i} className="flex items-center justify-between py-1.5 border-b border-border/10 last:border-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[9px] font-mono text-muted-foreground/30">{item.quantity}×</span>
                          <span className="text-sm text-foreground">{item.name}</span>
                        </div>
                        <span className="text-sm font-mono text-muted-foreground tabular-nums">
                          ${Number((item.price_aud || 0) * (item.quantity || 1)).toFixed(2)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Customer + shipping address (prominent, editable) */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-muted-foreground/50">Customer &amp; Shipping</p>
                    <div className="flex items-center gap-2">
                      <button type="button" onClick={openLabel} className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-muted-foreground/50 hover:text-primary">
                        <Printer className="h-2.5 w-2.5" /> Print slip
                      </button>
                      <button type="button" onClick={() => setEditMode(!editMode)} className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-muted-foreground/50 hover:text-primary">
                        <Pencil className="h-2.5 w-2.5" /> {editMode ? "Close" : "Edit"}
                      </button>
                    </div>
                  </div>
                  {editMode ? (
                    <OrderEditForm editFields={editFields} setEditFields={setEditFields} onSave={saveEdit} onCancel={() => setEditMode(false)} />
                  ) : (
                    <>
                      <div className="text-sm text-foreground">
                        {order.customer_name || "—"}
                        <span className="text-muted-foreground/50"> · {order.customer_email || "no email"}</span>
                      </div>
                      <AddressBlock order={order} />
                    </>
                  )}
                </div>

                {/* Manual fulfilment only: no carrier API is called. */}
                {isDelivery && (
                <div className="border border-border/20 bg-muted/5 p-3 space-y-2">
                  <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-muted-foreground/50 flex items-center gap-1.5">
                    <Truck className="h-3 w-3 text-primary" /> Shipping label &amp; tracking
                  </p>
                  {!hasShippingAddress ? (
                    <p className="text-[10px] text-amber-400">Complete the structured Australian address before printing or shipping.</p>
                  ) : (
                    <Button
                      size="sm"
                      type="button"
                      onClick={openLabel}
                      className="h-9 rounded-none bg-primary/90 hover:bg-primary text-[9px] font-bold uppercase tracking-wider"
                    >
                      <Printer className="mr-1.5 h-3 w-3" /> Print address / packing slip
                    </Button>
                  )}
                  <p className="text-[10px] leading-relaxed text-muted-foreground">
                    This browser printout is not paid postage. Purchase postage separately, then enter the carrier, tracking number and HTTPS tracking link below.
                  </p>
                </div>
                )}

                {/* Status + Carrier + Shipping Method */}
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <div className="space-y-3">
                    <div className="space-y-1">
                      <label htmlFor={`order-status-${order.id}`} className="text-[9px] font-bold uppercase tracking-[0.2em] text-muted-foreground/50">Status</label>
                      {MANUAL_STATUSES.includes(order.status || "pending") ? (
                        <Select
                          value={order.status || "pending"}
                          onValueChange={handleStatusChange}
                        >
                          <SelectTrigger className="h-11 rounded-none border-border/40 text-sm"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {manualOptions.map((s) => {
                              const conf = getStatusConfig(s);
                              return (
                                <SelectItem key={s} value={s}>
                                  <span className="flex items-center gap-2">
                                    <span className={`h-1.5 w-1.5 rounded-full ${conf.dot}`} />
                                    {conf.label}
                                  </span>
                                </SelectItem>
                              );
                            })}
                          </SelectContent>
                        </Select>
                      ) : (
                        // Cancelled / refunded / partially-refunded are set by the
                        // Cancel/Refund actions (which move money + stock), never by hand.
                        <div className="h-11 flex items-center gap-2 px-3 border border-border/40 bg-muted/5 text-sm">
                          <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
                          <span className="font-semibold">{status.label}</span>
                          <span className="ml-auto text-[8px] font-bold uppercase tracking-wider text-muted-foreground/40">Set via actions</span>
                        </div>
                      )}
                    </div>

                    <div className="space-y-1">
                      <label htmlFor={`order-carrier-${order.id}`} className="text-[9px] font-bold uppercase tracking-[0.2em] text-muted-foreground/50">Carrier</label>
                      <Select value={carrier} onValueChange={(v) => { setCarrier(v); onUpdate(order.id, { carrier: v }); }}>
                        <SelectTrigger className="h-11 rounded-none border-border/40 text-sm"><SelectValue placeholder="Select carrier" /></SelectTrigger>
                        <SelectContent>
                          {CARRIERS.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Shipping Method Selector */}
                    <div className="space-y-1">
                      <label htmlFor={`order-shipping-${order.id}`} className="text-[9px] font-bold uppercase tracking-[0.2em] text-muted-foreground/50">Shipping Method</label>
                      <Select
                        value={order.shipping_method || "standard"}
                        onValueChange={handleShippingMethodChange}
                      >
                        <SelectTrigger className="h-11 rounded-none border-border/40 text-sm"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {Object.entries(SHIPPING_METHODS).map(([key, { label }]) => (
                            <SelectItem key={key} value={key}>{label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <div className="space-y-1">
                      <label htmlFor={`order-tracking-${order.id}`} className="text-[9px] font-bold uppercase tracking-[0.2em] text-muted-foreground/50">Tracking Number</label>
                      <Input
                        id={`order-tracking-${order.id}`}
                        placeholder="e.g. AU123456789"
                        value={trackingNumber}
                        onChange={(e) => setTrackingNumber(e.target.value)}
                        onBlur={() => trackingNumber !== (order.tracking_number || "") && onUpdate(order.id, { tracking_number: trackingNumber })}
                        className="h-11 rounded-none border-border/40 text-sm font-mono"
                      />
                    </div>
                    <div className="space-y-1">
                      <label htmlFor={`order-tracking-url-${order.id}`} className="text-[9px] font-bold uppercase tracking-[0.2em] text-muted-foreground/50">Tracking URL</label>
                      <div className="flex gap-1.5">
                        <Input
                          id={`order-tracking-url-${order.id}`}
                          placeholder="https://carrier.example/track/..."
                          value={trackingUrl}
                          onChange={(e) => setTrackingUrl(e.target.value)}
                          onBlur={() => trackingUrl !== (order.tracking_url || "") && onUpdate(order.id, { tracking_url: trackingUrl })}
                          className="h-11 rounded-none border-border/40 text-sm font-mono flex-1"
                        />
                        {safeTrackingUrl(trackingUrl) && (
                          <a href={safeTrackingUrl(trackingUrl)} target="_blank" rel="noreferrer" className="inline-flex items-center justify-center h-11 w-11 border border-border/40 text-muted-foreground hover:text-primary transition-colors shrink-0">
                            <ExternalLink className="h-4 w-4" />
                          </a>
                        )}
                      </div>
                    </div>

                    {/* Estimated Delivery (read-only) */}
                    <div className="space-y-1">
                      <label htmlFor={`order-est-delivery-${order.id}`} className="text-[9px] font-bold uppercase tracking-[0.2em] text-muted-foreground/50">Estimated Delivery</label>
                      <div id={`order-est-delivery-${order.id}`} className="h-11 flex items-center gap-2 px-3 border border-border/40 bg-muted/5 text-sm text-muted-foreground">
                        <CalendarDays className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
                        {order.estimated_delivery
                          ? format(new Date(order.estimated_delivery), "EEE dd MMM yyyy")
                          : order.shipped_at
                            ? format(new Date(calcEstimatedDelivery(order.shipped_at, order.shipping_method || "standard")), "EEE dd MMM yyyy")
                            : "Set when shipped"}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Notes */}
                <div className="space-y-1">
                  <label htmlFor={`order-notes-${order.id}`} className="text-[9px] font-bold uppercase tracking-[0.2em] text-muted-foreground/50">Fulfilment Notes (internal)</label>
                  <Textarea
                    id={`order-notes-${order.id}`}
                    placeholder="Add internal notes…"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    onBlur={() => notes !== (order.shipping_notes || "") && onUpdate(order.id, { shipping_notes: notes })}
                    className="min-h-20 resize-none rounded-none border-border/40 text-sm"
                  />
                </div>

                {/* Customer-Visible Note */}
                <div className="space-y-1">
                  <label htmlFor={`order-customer-note-${order.id}`} className="text-[9px] font-bold uppercase tracking-[0.2em] text-muted-foreground/50 flex items-center gap-1.5">
                    <Info className="h-3 w-3 text-blue-400" />
                    Customer-Visible Note
                  </label>
                  <Textarea
                    id={`order-customer-note-${order.id}`}
                    placeholder="e.g. Your order is being packed with care!"
                    value={customerNote}
                    onChange={(e) => setCustomerNote(e.target.value)}
                    onBlur={() => customerNote !== (order.customer_status_note || "") && onUpdate(order.id, { customer_status_note: customerNote })}
                    className="min-h-16 resize-none rounded-none border-blue-500/30 bg-blue-500/[0.04] text-sm focus-visible:ring-blue-500/30"
                  />
                </div>

                {/* Refund (real Stripe) + Cancel actions */}
                {(canRefund || canCancel) && (
                  <div className="flex flex-col gap-3 border-t border-border/10 pt-4">
                    {refundedSoFar > 0 && (
                      <p className="text-[10px] text-amber-400/80">
                        Already refunded ${refundedSoFar.toFixed(2)} AUD · ${refundRemaining.toFixed(2)} remaining
                      </p>
                    )}

                    {!showRefundForm && !showCancelForm && (
                      <div className="flex flex-wrap gap-2">
                        {canRefund && (
                          <Button
                            variant="destructive"
                            onClick={() => { setRefundAmount(refundRemaining); setShowRefundForm(true); }}
                            className="rounded-none text-[9px] font-bold uppercase tracking-wider min-h-[44px]"
                          >
                            <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Issue Refund
                          </Button>
                        )}
                        {canCancel && (
                          <Button
                            variant="outline"
                            onClick={() => setShowCancelForm(true)}
                            className="rounded-none border-destructive/40 text-destructive text-[9px] font-bold uppercase tracking-wider min-h-[44px] hover:bg-destructive/10"
                          >
                            <Ban className="mr-1.5 h-3.5 w-3.5" /> Cancel Order
                          </Button>
                        )}
                      </div>
                    )}

                    {showRefundForm && (
                      <div className="border border-destructive/30 bg-destructive/5 p-4 space-y-3">
                        <div className="flex items-center gap-2 text-xs font-bold text-destructive uppercase tracking-wider">
                          <AlertTriangle className="h-3.5 w-3.5" /> Refund via Stripe
                        </div>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          <div className="space-y-1">
                            <label htmlFor={`order-refund-amount-${order.id}`} className="text-[9px] font-bold uppercase tracking-[0.2em] text-muted-foreground/50">Amount (AUD) · max ${refundRemaining.toFixed(2)}</label>
                            <Input
                              id={`order-refund-amount-${order.id}`}
                              type="number"
                              step="0.01"
                              min="0"
                              max={refundRemaining}
                              value={refundAmount}
                              onChange={(e) => setRefundAmount(e.target.value)}
                              className="h-11 rounded-none border-border/40 text-sm font-mono"
                            />
                          </div>
                          <div className="space-y-1">
                            <label htmlFor={`order-refund-reason-${order.id}`} className="text-[9px] font-bold uppercase tracking-[0.2em] text-muted-foreground/50">Reason</label>
                            <Textarea
                              id={`order-refund-reason-${order.id}`}
                              placeholder="Reason for refund…"
                              value={refundReason}
                              onChange={(e) => setRefundReason(e.target.value)}
                              className="min-h-11 resize-none rounded-none border-border/40 text-sm"
                            />
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="destructive"
                            onClick={handleRefundConfirm}
                            disabled={refundMutation.isPending}
                            className="rounded-none text-[9px] font-bold uppercase tracking-wider min-h-[44px]"
                          >
                            {refundMutation.isPending ? "Refunding…" : "Refund via Stripe"}
                          </Button>
                          <Button
                            variant="outline"
                            onClick={() => { setShowRefundForm(false); setRefundReason(""); setRefundAmount(refundRemaining); }}
                            className="rounded-none text-[9px] font-bold uppercase tracking-wider min-h-[44px] border-border/30"
                          >
                            Back
                          </Button>
                        </div>
                      </div>
                    )}

                    {showCancelForm && (
                      <div className="border border-destructive/30 bg-destructive/5 p-4 space-y-3">
                        <div className="flex items-center gap-2 text-xs font-bold text-destructive uppercase tracking-wider">
                          <Ban className="h-3.5 w-3.5" /> Cancel order
                        </div>
                        {paidLike.includes(order.status) && (
                          <p className="text-[10px] text-amber-400/80">
                            This order is paid. Cancelling does <strong>not</strong> refund the customer — issue a refund separately if money is owed (you still can after cancelling).
                            {["paid", "packing"].includes(order.status)
                              ? " Items will be returned to stock."
                              : " Items are already dispatched, so stock is left unchanged — restock manually if they come back."}
                          </p>
                        )}
                        <div className="space-y-1">
                          <label htmlFor={`order-cancel-reason-${order.id}`} className="text-[9px] font-bold uppercase tracking-[0.2em] text-muted-foreground/50">Reason (optional)</label>
                          <Textarea
                            id={`order-cancel-reason-${order.id}`}
                            placeholder="Why is this order being cancelled?"
                            value={cancelReason}
                            onChange={(e) => setCancelReason(e.target.value)}
                            className="min-h-11 resize-none rounded-none border-border/40 text-sm"
                          />
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="destructive"
                            onClick={handleCancelConfirm}
                            disabled={cancelMutation.isPending}
                            className="rounded-none text-[9px] font-bold uppercase tracking-wider min-h-[44px]"
                          >
                            {cancelMutation.isPending ? "Cancelling…" : "Confirm Cancel"}
                          </Button>
                          <Button
                            variant="outline"
                            onClick={() => { setShowCancelForm(false); setCancelReason(""); }}
                            className="rounded-none text-[9px] font-bold uppercase tracking-wider min-h-[44px] border-border/30"
                          >
                            Back
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Mobile quick actions */}
                {isFulfillable && (
                  <div className="flex flex-wrap gap-2 md:hidden">
                    {order.status === "paid" && (
                      <Button onClick={() => handleQuickAction("packing")} className="flex-1 min-h-[44px] rounded-none bg-sky-600 hover:bg-sky-500 text-xs font-bold uppercase tracking-wider">
                        <Package className="mr-1.5 h-4 w-4" /> Mark Packing
                      </Button>
                    )}
                    {isDelivery && (order.status === "paid" || order.status === "packing") && (
                      <Button onClick={() => handleQuickAction("shipped")} className="flex-1 min-h-[44px] rounded-none bg-blue-600 hover:bg-blue-500 text-xs font-bold uppercase tracking-wider">
                        <Truck className="mr-1.5 h-4 w-4" /> Mark Shipped
                      </Button>
                    )}
                    {!isDelivery && (order.status === "paid" || order.status === "packing") && (
                      <Button onClick={() => handleQuickAction("completed")} className="flex-1 min-h-[44px] rounded-none bg-emerald-600 hover:bg-emerald-500 text-xs font-bold uppercase tracking-wider">
                        <CheckCircle2 className="mr-1.5 h-4 w-4" /> {order.fulfilment_method === "pickup" ? "Mark Collected" : "Mark Complete"}
                      </Button>
                    )}
                    {order.status === "shipped" && (
                      <Button onClick={() => handleQuickAction("completed")} className="flex-1 min-h-[44px] rounded-none bg-emerald-600 hover:bg-emerald-500 text-xs font-bold uppercase tracking-wider">
                        <CheckCircle2 className="mr-1.5 h-4 w-4" /> Mark Delivered
                      </Button>
                    )}
                  </div>
                )}

                {/* Copy summary */}
                <div className="flex justify-end">
                  <Button variant="ghost" onClick={copyOrderSummary} className="h-8 rounded-none text-[9px] font-bold uppercase tracking-wider text-muted-foreground hover:text-foreground">
                    <Copy className="mr-1.5 h-3 w-3" /> Copy Summary
                  </Button>
                </div>

                {/* Order Timeline */}
                <OrderTimeline timeline={timeline} />

                {/* Timestamps */}
                <div className="border-t border-border/10 pt-3 flex flex-wrap gap-4 text-[9px] text-muted-foreground/30">
                  {order.shipped_at && <span>Shipped: {format(new Date(order.shipped_at), "dd MMM yyyy HH:mm")}</span>}
                  {order.delivered_at && <span>Delivered: {format(new Date(order.delivered_at), "dd MMM yyyy HH:mm")}</span>}
                  {order.refunded_at && <span>Refunded: {format(new Date(order.refunded_at), "dd MMM yyyy HH:mm")}</span>}
                  {order.created_date && <span>Created: {format(new Date(order.created_date), "dd MMM yyyy HH:mm")}</span>}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {/* Confirm sheet */}
      <AdminConfirmSheet
        open={!!confirmAction}
        title={confirmAction?.label}
        description={`This will update order #${String(order.id || "").slice(-6).toUpperCase()} for ${order.customer_name || "this customer"}.`}
        confirmLabel="Confirm"
        onConfirm={executeAction}
        onCancel={() => setConfirmAction(null)}
      />

      {/* Address label / packing slip — rendered in-page and printed from this
          document, so it works where the old pop-up printer opened a blank tab. */}
      <OrderLabelSheet
        open={labelOpen}
        order={order}
        addressText={orderAddressText(order)}
        onClose={() => setLabelOpen(false)}
      />
    </>
  );
}

/* ── Main Component ── */
export default function OrdersManager({ orders }) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [search, setSearch] = useState("");
  const [pipelineTab, setPipelineTab] = useState("all");

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.StoreOrder.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      toast({ title: "Order updated", description: "Changes saved successfully." });
    },
    onError: (error) => {
      toast({ title: "Update failed", description: error.message, variant: "destructive" });
    },
  });

  const handleUpdate = (id, data) => updateMutation.mutate({ id, data });

  const revenue = useMemo(() => orders.filter((o) => paidLike.includes(o.status)).reduce((s, o) => s + Number(o.total_aud || 0), 0), [orders]);
  const pendingCount = orders.filter((o) => o.status === "pending").length;
  const fulfilCount = orders.filter((o) => toFulfil.includes(o.status)).length;

  // Pipeline counts
  const pipelineCounts = useMemo(() => {
    const counts = {};
    PIPELINE_TABS.forEach((tab) => {
      if (tab.key === "all") {
        counts[tab.key] = orders.length;
      } else {
        counts[tab.key] = orders.filter((o) => tab.statuses.includes(o.status || "pending")).length;
      }
    });
    return counts;
  }, [orders]);

  const filtered = useMemo(() => {
    const term = search.toLowerCase();
    const activeTab = PIPELINE_TABS.find((t) => t.key === pipelineTab);
    return orders.filter((o) => {
      if (activeTab && activeTab.statuses && !activeTab.statuses.includes(o.status || "pending")) return false;
      const hay = `${o.customer_name || ""} ${o.customer_email || ""} ${o.tracking_number || ""} ${(o.line_items || []).map((i) => i.name).join(" ")}`.toLowerCase();
      return hay.includes(term);
    });
  }, [orders, search, pipelineTab]);

  // Stripe collected a phone at checkout long before we had a column for it, so
  // orders paid before migration 0037 have a blank Phone cell. This pulls them
  // back off the Stripe session. Read-only against Stripe and it only ever fills
  // a blank, so pressing it twice is harmless.
  const backfillPhones = useMutation({
    mutationFn: () => base44.functions.invoke("backfillOrderPhones"),
    onSuccess: (res) => {
      const d = res?.data || {};
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      const failed = (d.failures || []).length;
      toast({
        title: d.updated ? `Added ${d.updated} phone number${d.updated === 1 ? "" : "s"}` : "No new phone numbers found",
        description: [
          `${d.examined ?? 0} order${d.examined === 1 ? "" : "s"} checked`,
          d.no_phone_on_session ? `${d.no_phone_on_session} had none on file` : "",
          failed ? `${failed} could not be read` : "",
        ].filter(Boolean).join(" · "),
      });
    },
    onError: (error) => {
      toast({ title: "Could not fetch phone numbers", description: error.message, variant: "destructive" });
    },
  });

  const exportCsv = () => {
    // The delivery address is the whole point of exporting orders for a postage
    // run, but it was missing entirely — admins had to open every order by hand.
    // Split into per-field columns (so the sheet can feed a carrier upload or a
    // mail merge) plus one combined column for quick copy/paste.
    const headers = [
      "Date", "Order", "Customer", "Email", "Phone", "Account", "Status", "Total AUD", "Items",
      "Fulfilment", "Ship To Name", "Address 1", "Address 2", "Suburb", "State", "Postcode", "Country",
      "Shipping Address", "Carrier", "Tracking", "Notes",
    ];
    const rows = filtered.map((o) => [
      o.created_date ? format(new Date(o.created_date), "yyyy-MM-dd") : "",
      String(o.id || "").slice(-6).toUpperCase(),
      o.customer_name, o.customer_email, orderPhone(o), o.user_email || "guest", o.status || "pending",
      Number(o.total_aud || 0).toFixed(2),
      (o.line_items || []).map((i) => `${i.quantity}x ${i.name}${i.size ? ` (${i.size})` : ""}`).join("; "),
      o.fulfilment_method || "",
      o.shipping_name || o.customer_name || "",
      o.shipping_address_line1 || "",
      o.shipping_address_line2 || "",
      o.shipping_suburb || "",
      o.shipping_state || "",
      o.shipping_postcode || "",
      o.shipping_country || "",
      // Newlines break the row apart in some spreadsheet importers.
      orderAddressText(o).replace(/\n/g, ", "),
      o.carrier || "", o.tracking_number || "", o.shipping_notes || "",
    ]);
    downloadCsv("rugby-league-takeover-orders.csv", headers, rows);
  };

  return (
    <div className="border border-border/60 bg-card/30 cmd-glass overflow-hidden">
      <div className="h-[2px] w-full bg-gradient-to-r from-sky-500 via-sky-400 to-sky-500" />

      <div className="p-5 md:p-6">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-sky-500/10 border border-sky-500/20">
              <ShoppingCart className="h-4 w-4 text-sky-400" />
            </div>
            <div>
              <h2 className="font-display text-2xl uppercase tracking-wide">Fulfillment Pipeline</h2>
              <p className="text-[9px] font-mono text-muted-foreground/40">{orders.length} total · {filtered.length} showing</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              onClick={() => backfillPhones.mutate()}
              disabled={backfillPhones.isPending}
              size="mobile"
              title="Fetch missing customer phone numbers from Stripe"
              className="rounded-none border-border/30 text-[9px] font-bold uppercase tracking-wider"
            >
              <Phone className="mr-1.5 h-3 w-3" />
              {backfillPhones.isPending ? "Fetching…" : "Get phone numbers"}
            </Button>
            <Button
              variant="outline"
              onClick={exportCsv}
              disabled={!filtered.length}
              size="mobile"
              className="rounded-none border-border/30 text-[9px] font-bold uppercase tracking-wider"
            >
              <Download className="mr-1.5 h-3 w-3" /> Export CSV
            </Button>
          </div>
        </div>

        {/* Event-day collection desk */}
        <div className="mb-5">
          <CollectionRedeem />
        </div>

        {/* Stats */}
        <div className="grid gap-2 grid-cols-2 lg:grid-cols-4 mb-5">
          <StatCard icon={DollarSign} label="Revenue (paid)" value={`$${revenue.toFixed(2)}`} accent="text-emerald-400" />
          <StatCard icon={ShoppingCart} label="Total orders" value={orders.length} />
          <StatCard icon={Clock} label="Pending payment" value={pendingCount} accent={pendingCount > 0 ? "text-amber-400" : ""} />
          <StatCard icon={PackageCheck} label="To fulfil" value={fulfilCount} accent={fulfilCount > 0 ? "text-sky-400" : ""} />
        </div>

        {/* Pipeline Tabs */}
        <div className="flex items-center gap-1.5 mb-4 overflow-x-auto pb-1">
          {PIPELINE_TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setPipelineTab(tab.key)}
              className={`flex items-center gap-1.5 px-3 py-2 text-[10px] font-bold uppercase tracking-[0.15em] whitespace-nowrap transition-all border min-h-[36px] ${
                pipelineTab === tab.key
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border/30 bg-card/10 text-muted-foreground hover:border-border/60 hover:text-foreground"
              }`}
            >
              {tab.label}
              {pipelineCounts[tab.key] > 0 && (
                <span className={`text-[9px] font-mono ${pipelineTab === tab.key ? "text-primary" : "text-muted-foreground/40"}`}>
                  {pipelineCounts[tab.key]}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/30" />
          <Input
            placeholder="Search customer, email, tracking number or item…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-11 rounded-none border-border/40 pl-9 text-sm"
          />
        </div>

        {/* Order List */}
        <div className="space-y-2">
          {filtered.length === 0 && (
            <div className="border border-border/30 bg-muted/5 p-10 text-center">
              <ShoppingCart className="h-6 w-6 mx-auto text-muted-foreground/15 mb-2" />
              <p className="text-sm text-muted-foreground/30">No orders match your filters.</p>
            </div>
          )}
          {filtered.map((order, index) => (
            <OrderCard
              key={order.id}
              order={order}
              index={index}
              onUpdate={handleUpdate}
              actorEmail={user?.email}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
