import React, { useState, useRef, useEffect, useMemo, useCallback, useDeferredValue, memo, lazy, Suspense } from "react";
import AdSlot from "@/components/ads/AdSlot";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { motion, AnimatePresence, useInView, useMotionValue, useTransform, useSpring } from "framer-motion";
import {
  MessageSquare, Send, Pin, Search, MessageCircle, Heart,
  TrendingUp, Users, Flame, Sparkles, Clock, Eye,
  X, Radio, ChevronDown, ChevronUp, Trash2,
  Trophy, Activity, Reply, Shield, Pencil, Flag, Plane, ShoppingBag, CalendarDays, ArrowRight, Bookmark
} from "lucide-react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FORUM_CATEGORIES, buildForumThreads, buildPendingForumPost } from "@/lib/public-forms";
import { appParams } from "@/lib/app-params";
import { useAuth } from "@/lib/AuthContext";
import { toast } from "@/components/ui/use-toast";
import ReplyTree from "@/components/forum/ReplyTree";
import ReactionPicker from "@/components/forum/ReactionPicker";
import ForumMedia from "@/components/forum/ForumMedia";
import MentionTextarea, { toHandle } from "@/components/forum/MentionTextarea";
import { MarkdownBody } from "@/lib/markdown";
import { isActiveMember } from "@/lib/membership";
import MediaAttach from "@/components/forum/MediaAttach";
import { topBadge, parseBadgeIds, SPIN_COOLDOWN_MS, SLOT_LAST_SPIN_KEY } from "@/lib/slot-badges";

import { getCategoryMeta, timeAgo, getRecencyScore, parseForumDate } from "@/components/forum/feed/forumHelpers";
import { ShareButton, SaveButton } from "@/components/forum/feed/ShareSaveButtons";
import AnimatedNumber from "@/components/forum/feed/AnimatedNumber";
import FloatingParticles from "@/components/forum/feed/FloatingParticles";
import UserAvatar from "@/components/forum/feed/UserAvatar";
import UserProfileHoverCard from "@/components/forum/feed/UserProfileHoverCard";
import AuthorBadge from "@/components/forum/feed/AuthorBadge";
import AuthorMeta from "@/components/forum/feed/AuthorMeta";
import LiveActivityTicker from "@/components/forum/feed/LiveActivityTicker";
import TrendingCard from "@/components/forum/feed/TrendingCard";
import CategoryPill from "@/components/forum/feed/CategoryPill";
import EmptyState from "@/components/forum/feed/EmptyState";
import ScrollToTopButton from "@/components/forum/feed/ScrollToTopButton";
import AdminConfirmSheet from "@/components/admin/shared/AdminConfirmSheet";
import TopContributors from "@/components/forum/feed/TopContributors";
import OnlineUsersWidget from "@/components/forum/feed/OnlineUsersWidget";
import CollapsibleGuidelines from "@/components/forum/feed/CollapsibleGuidelines";
import FanRankCard from "@/components/forum/feed/FanRankCard";
import DailyMissions from "@/components/forum/feed/DailyMissions";
import { hasUnreadReplies, getUnreadReplyCount, getReadTimestamps, markThreadRead } from "@/lib/forum-read-tracker";
import { lockBodyScroll } from "@/lib/scroll-lock";
import { successImpact, errorImpact } from "@/lib/native/haptics";
import { triggerAppStoreReview } from "@/components/AppStoreReviewPrompt";

// Lazy-loaded feature islands to trim the initial bundle footprint
const StadiumSeatPlanner = lazy(() => import("@/components/forum/StadiumSeatPlanner"));
const ScorePredictor = lazy(() => import("@/components/forum/ScorePredictor"));
const SlotMachineBadgeUnlock = lazy(() => import("@/components/forum/SlotMachineBadgeUnlock"));
const ThreadDetailModal = lazy(() => import("@/components/forum/feed/ThreadDetailModal"));
const ComposeSidebar = lazy(() => import("@/components/forum/feed/ComposeSidebar"));



/* ━━━ Constants & Helpers ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
const emptyPost = { author_name: "", title: "", body: "", category: "General", media_url: "" };
const emptyReply = { author_name: "", body: "", media_url: "" };
const DRAFT_STORAGE_KEY = "rlt_forum_draft";
// Reply drafts persist too — on phones, backgrounding the app mid-reply is the
// COMMON case, and pure state lost the text every time. Capped and TTL'd so
// abandoned scraps don't accumulate forever.
const REPLY_DRAFTS_KEY = "rlt_forum_reply_drafts";
const REPLY_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const REPLY_DRAFT_MAX = 20;

function loadReplyDrafts() {
  try {
    const raw = JSON.parse(localStorage.getItem(REPLY_DRAFTS_KEY) || "{}");
    const now = Date.now();
    const fresh = {};
    for (const [id, entry] of Object.entries(raw)) {
      if (entry && entry.body && now - (entry.savedAt || 0) < REPLY_DRAFT_TTL_MS) {
        fresh[id] = { ...emptyReply, author_name: entry.author_name || "", body: entry.body, media_url: entry.media_url || "" };
      }
    }
    return fresh;
  } catch { return {}; }
}

function persistReplyDrafts(drafts) {
  try {
    const now = Date.now();
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(REPLY_DRAFTS_KEY) || "{}"); } catch { /* fresh */ }
    const entries = Object.entries(drafts)
      .filter(([, d]) => d && d.body)
      .slice(-REPLY_DRAFT_MAX)
      // Unchanged bodies keep their ORIGINAL savedAt — re-stamping on every
      // write meant merely visiting the forum renewed every TTL forever.
      .map(([id, d]) => [id, {
        author_name: d.author_name || "",
        body: d.body,
        media_url: d.media_url || "",
        savedAt: stored[id]?.body === d.body ? (stored[id].savedAt || now) : now,
      }]);
    if (entries.length === 0) localStorage.removeItem(REPLY_DRAFTS_KEY);
    else localStorage.setItem(REPLY_DRAFTS_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch { /* storage unavailable */ }
}
const SAVED_POSTS_KEY = "rlt_saved_posts";
const getSavedPostIds = () => { try { return JSON.parse(localStorage.getItem(SAVED_POSTS_KEY) || "[]"); } catch { return []; } };

const containsActiveReply = (post, activeId) => {
  if (!activeId) return false;
  if (post.id === activeId) return true;
  if (!post.replies) return false;
  const checkReplies = (replies) => {
    for (const r of replies) {
      if (r.id === activeId) return true;
      if (r.replies && checkReplies(r.replies)) return true;
    }
    return false;
  };
  return checkReplies(post.replies);
};

const categories = [
  { value: "All" },
  ...FORUM_CATEGORIES.map((value) => ({ value })),
];

const getEngagement = (post) => {
  // Clamp to 0: bad/legacy data can carry negative like_count/view_count, and a
  // negative engagement number should never render to fans. Fallback behaviour
  // (liked_by length, missing → 0) is preserved.
  const likes = Math.max(0, Number(post.like_count ?? (Array.isArray(post.liked_by) ? post.liked_by.length : 0)) || 0);
  const views = Math.max(0, Number(post.view_count || 0) || 0);
  return {
    likes,
    views,
    hot: post.is_pinned === true || likes >= 10,
  };
};

/* ━━━ Sort Tabs ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
const SORT_OPTIONS = [
  { id: "latest", label: "Latest", icon: Clock },
  { id: "hot", label: "Hot", icon: Flame },
  { id: "top", label: "Top", icon: Trophy },
];

function SortTabs({ active, onChange }) {
  return (
    <div className="forum-sort-tabs grid grid-cols-3 border border-border/50 bg-card/30 p-0.5 sm:flex sm:items-center">
      {SORT_OPTIONS.map((opt) => {
        const isActive = active === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onChange(opt.id)}
            className={`relative flex min-h-11 items-center justify-center gap-1.5 px-3 py-2 text-[10px] font-bold uppercase tracking-wider transition-all duration-200 ${
              isActive ? "text-foreground" : "text-slate-300 hover:text-foreground"
            }`}
          >
            <opt.icon className={`h-3 w-3 ${isActive ? "text-primary" : ""}`} />
            {opt.label}
            {isActive && (
              <motion.div
                layoutId="sortTabBg"
                className="absolute inset-0 bg-muted/30 border border-border/50"
                transition={{ type: "spring", stiffness: 500, damping: 35 }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

function ForumQuickActionRail({ onStartDiscussion, onOpenTools }) {
  const quickActions = [
    {
      icon: MessageSquare,
      label: "Ask the crowd",
      body: "Start a thread for flights, hotels, tickets, meetups, or game-day plans.",
      action: "New thread",
      onClick: onStartDiscussion,
      tone: "text-primary border-primary/25 bg-primary/[0.04]",
    },
    {
      icon: CalendarDays,
      label: "Fan tools",
      body: "Use match tips, seating plans, badges, and community planning tools.",
      action: "Open tools",
      onClick: onOpenTools,
      tone: "text-accent border-accent/25 bg-accent/[0.04]",
    },
    {
      icon: Plane,
      label: "Travel planning",
      body: "Jump back to travel interest, packages, and Vegas week details.",
      action: "View travel",
      to: "/#travel",
      tone: "text-sky-300 border-sky-400/25 bg-sky-400/[0.04]",
    },
    {
      icon: ShoppingBag,
      label: "Merch and orders",
      body: "Shop supporter gear, then track orders from your profile.",
      action: "Open store",
      to: "/store",
      tone: "text-emerald-400 border-emerald-400/25 bg-emerald-400/[0.04]",
    },
  ];

  const renderContent = ({ icon: Icon, label, body, action, tone }) => (
    <>
      <div className="flex min-w-0 items-start gap-2.5 sm:gap-3">
        <div className={`flex h-8 w-8 shrink-0 items-center justify-center border sm:h-10 sm:w-10 ${tone}`}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="font-display text-sm uppercase leading-tight tracking-wide text-foreground sm:text-lg sm:leading-none">{label}</p>
          {/* Body copy and the footer CTA row only from sm — four full-height
              cards stacked ~540px of chrome above the first post on phones. */}
          <p className="mt-1 hidden text-xs leading-5 text-muted-foreground sm:block">{body}</p>
        </div>
      </div>
      <div className="mt-3 hidden items-center justify-between border-t border-border/30 pt-3 sm:flex">
        <span className="text-[9px] font-extrabold uppercase tracking-[0.22em] text-foreground">{action}</span>
        <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" />
      </div>
    </>
  );

  return (
    <section className="mb-4 grid grid-cols-2 gap-2 sm:mb-6 sm:gap-3 xl:grid-cols-4" aria-label="Forum quick actions">
      {quickActions.map((item) => {
        const className = `group min-w-0 border p-3 text-left transition-colors hover:border-primary/45 hover:bg-card/35 sm:p-4 ${item.tone}`;
        if (item.to) {
          return (
            <Link key={item.label} to={item.to} className={className}>
              {renderContent(item)}
            </Link>
          );
        }
        return (
          <button key={item.label} type="button" onClick={item.onClick} className={className}>
            {renderContent(item)}
          </button>
        );
      })}
    </section>
  );
}

/* ━━━ Post Card (Premium with 3D tilt) ━━━━━━━━━━━━━━━━━━━ */
const ForumPostCard = memo(function ForumPostCard({
  post, isAuthenticated, user, isModerator, appReady, isSubmitting,
  replyOpen, replyDraft, onToggleReply, onUpdateReply, onReply, index,
  onOpenThread, onDeletePost, onEditPost, replyApi, activeReplyDraft, authorPostCounts, authorReplyCounts, resolveAvatar, resolveMeta, reactionProfiles,
}) {
  const engagement = getEngagement(post);
  const replies = post.replies || [];
  const meta = getCategoryMeta(post.category);
  const MetaIcon = meta.icon;
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-30px" });
  const queryClient = useQueryClient();
  const reactMutation = useMutation({
    mutationFn: (emoji) => base44.functions.invoke("forumAction", { action: "react", postId: post.id, emoji }),
    // No toast here: a pop-up for every emoji tap was reward spam. The XP
    // still banks server-side; posting/replying keeps its celebratory toast.
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["forumPosts"] }); queryClient.invalidateQueries({ queryKey: ["forumAvatars"] }); },
  });
  const onReact = (emoji) => { if (!reactMutation.isPending) reactMutation.mutate(emoji); };
  useEffect(() => {
    if (!isInView || !post.id || typeof window === "undefined") return;
    const key = `rlt_viewed_${post.id}`;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, "1");
    base44.functions.invoke("forumAction", { action: "view", postId: post.id }).catch(() => {});
  }, [isInView, post.id]);
  const [cardOpen, setCardOpen] = useState(!!post.is_pinned);
  const [expanded, setExpanded] = useState(false);
  const [showAllReplies, setShowAllReplies] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const reportRef = useRef(null);

  // Close report dropdown on outside click
  useEffect(() => {
    if (!reportOpen) return;
    const handler = (e) => { if (reportRef.current && !reportRef.current.contains(e.target)) setReportOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [reportOpen]);

  const isOwner = isAuthenticated && user?.id && String(post.user_id) === String(user.id);
  const isEdited = post.updated_date && post.updated_date !== post.created_date;

  const shouldTruncate = (post.body || "").length > 220;
  const displayBody = shouldTruncate && !expanded ? post.body.slice(0, 220) + "…" : post.body;

  const visibleReplies = showAllReplies ? replies : replies.slice(0, 2);
  const hiddenCount = replies.length - 2;

  // Recency progress bar
  const recency = getRecencyScore(post.created_date);

  // 3D hover tilt — disabled on touch devices
  const isTouch = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)")?.matches;
  const mouseX = useMotionValue(0);
  const mouseY = useMotionValue(0);
  const rotateX = useSpring(useTransform(mouseY, [-0.5, 0.5], [2, -2]), { stiffness: 300, damping: 30 });
  const rotateY = useSpring(useTransform(mouseX, [-0.5, 0.5], [-2, 2]), { stiffness: 300, damping: 30 });

  const handleMouseMove = useCallback((e) => {
    if (isTouch) return;
    const rect = e.currentTarget.getBoundingClientRect();
    mouseX.set((e.clientX - rect.left) / rect.width - 0.5);
    mouseY.set((e.clientY - rect.top) / rect.height - 0.5);
  }, [mouseX, mouseY, isTouch]);

  const handleMouseLeave = useCallback(() => {
    mouseX.set(0);
    mouseY.set(0);
  }, [mouseX, mouseY]);

  return (
    <motion.article
      ref={ref}
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.07, 0.35), duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] }}
      style={isTouch ? {} : { rotateX, rotateY, transformPerspective: 1200 }}
      onMouseMove={isTouch ? undefined : handleMouseMove}
      onMouseLeave={isTouch ? undefined : handleMouseLeave}
      className={`forum-post-card group relative overflow-hidden border transition-all duration-300 ${
        post.is_pinned
          ? "border-primary/30 bg-gradient-to-br from-primary/[0.06] via-card/80 to-card/50 shadow-[0_0_30px_hsl(var(--primary)/0.06)]"
          : "border-border/60 bg-card/30 hover:border-primary/20"
      }`}
      whileHover={isTouch ? {} : {
        boxShadow: `0 12px 40px ${meta.glow}, 0 0 0 1px ${meta.glow}`,
        y: -3,
      }}
    >
      {/* Top accent */}
      <div className={`h-[2px] w-full bg-gradient-to-r ${meta.gradient}`} />

      {/* Pinned diagonal stripes pattern */}
      {post.is_pinned && (
        <div
          className="absolute inset-0 pointer-events-none opacity-[0.03]"
          style={{
            backgroundImage: "repeating-linear-gradient(45deg, transparent, transparent 10px, currentColor 10px, currentColor 11px)",
          }}
        />
      )}

      {/* Pinned shimmer */}
      {post.is_pinned && (
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          <div className="absolute left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-primary/20 to-transparent cmd-scan-line" />
        </div>
      )}

      {/* Glass glare sweep overlay */}
      <div className="absolute inset-0 w-1/2 h-full bg-gradient-to-r from-transparent via-white/[0.03] to-transparent skew-x-[-25deg] -translate-x-[150%] transition-transform duration-1000 group-hover:translate-x-[250%] pointer-events-none" />

      {/* Hot badge */}
      {engagement.hot && !post.is_pinned && (
        <div className="absolute top-3 right-3 z-10">
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-orange-500/10 border border-orange-500/20 text-[11px] font-bold uppercase tracking-wider text-orange-400">
            <Flame className="h-2 w-2" /> Hot
          </span>
        </div>
      )}

      <div className="relative p-4 sm:p-5 md:p-6">
        {/* Header */}
        <div className="flex items-start gap-3">
          <UserProfileHoverCard name={post.author_name} meta={resolveMeta ? resolveMeta(post.user_id) : null} authorPostCounts={authorPostCounts} authorReplyCounts={authorReplyCounts}>
            <UserAvatar name={post.author_name} showStatus={index < 3} src={resolveAvatar ? resolveAvatar(post.user_id, post.author_avatar) : post.author_avatar} />
          </UserProfileHoverCard>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="min-w-0 truncate text-sm font-bold text-foreground">{post.author_name || "Anonymous"}</span>
              <AuthorBadge name={post.author_name} authorPostCounts={authorPostCounts} />
              {(post.author_role === 'moderator' || (user?.role === 'moderator' && user?.id && String(post.user_id) === String(user.id))) && (
                <span className="inline-flex items-center gap-0.5 border border-violet-500/30 bg-violet-500/10 px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-violet-400">
                  <Shield className="h-2 w-2" /> Mod
                </span>
              )}
              <AuthorMeta meta={resolveMeta ? resolveMeta(post.user_id) : null} />
              <span className="text-[11px] text-slate-400 font-bold">•</span>
              <span title={parseForumDate(post.created_date)?.toLocaleString("en-AU") || undefined} className="text-[11px] font-mono text-slate-300 font-bold tabular-nums">{timeAgo(post.created_date)}</span>
              {isEdited && <span className="text-[11px] italic text-slate-400">(edited)</span>}
            </div>
            <div className="flex flex-wrap items-center gap-1.5 mt-1">
              {post.is_pinned && (
                <span className="inline-flex items-center gap-1 bg-primary/10 border border-primary/20 px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-primary">
                  <Pin className="h-2 w-2" /> Pinned
                </span>
              )}
              <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border border-border/30 bg-gradient-to-r ${meta.gradient}`}>
                <MetaIcon className={`h-3 w-3 ${meta.accent}`} />
                <span className={meta.accent}>{meta.label}</span>
              </span>
            </div>
          </div>
          {/* Desktop stats */}
          <div className="hidden md:flex items-center gap-3 text-[10px] text-slate-300 font-semibold">
            <span className="flex items-center gap-1 font-mono font-bold tabular-nums text-slate-200">
              <Eye className="h-3 w-3 text-primary" /> {engagement.views}
            </span>
          </div>
        </div>

        {/* Title + compact stats row — always visible, expands the card. A
            real <button> (not a click-catching div): keyboard and switch
            users previously could not open, read, or reply to ANY thread. */}
        <button
          type="button"
          aria-expanded={cardOpen}
          className="mt-3 w-full cursor-pointer select-none text-left"
          onClick={() => { if (!cardOpen) markThreadRead(post.id); setCardOpen(!cardOpen); }}
        >
          <div className="flex items-start gap-2">
            <h3 className="flex-1 font-display text-lg md:text-xl uppercase tracking-wide text-foreground leading-tight group-hover:text-primary transition-colors duration-300 break-words">
              {post.title || "Discussion Thread"}
            </h3>
            <motion.div
              animate={{ rotate: cardOpen ? 180 : 0 }}
              transition={{ duration: 0.2 }}
              className="mt-1 shrink-0 text-muted-foreground"
            >
              <ChevronDown className="h-4 w-4" />
            </motion.div>
          </div>
          {/* Compact stats — visible when collapsed */}
          {!cardOpen && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] font-bold text-slate-300">
              {engagement.likes > 0 && (
                <span className="inline-flex items-center gap-1 border border-border/30 bg-muted/10 px-2 py-0.5">
                  <Heart className="h-2.5 w-2.5 text-red-400" /> {engagement.likes}
                </span>
              )}
              {replies.length > 0 && (
                <span className="inline-flex items-center gap-1 border border-border/30 bg-muted/10 px-2 py-0.5">
                  <MessageCircle className="h-2.5 w-2.5 text-accent" /> {replies.length}
                  {hasUnreadReplies(post.id, replies) && (
                    <span className="ml-0.5 text-primary font-bold">● {getUnreadReplyCount(post.id, replies, getReadTimestamps()[post.id])} new</span>
                  )}
                </span>
              )}
              <span className="inline-flex items-center gap-1 border border-border/30 bg-muted/10 px-2 py-0.5">
                <Eye className="h-2.5 w-2.5 text-primary" /> {engagement.views}
              </span>
              {(post.body || "").length > 0 && (
                <span className="line-clamp-2 w-full text-slate-300/80">
                  {(post.body || "").slice(0, 200)}{(post.body || "").length > 200 ? "…" : ""}
                </span>
              )}
            </div>
          )}
        </button>

        {/* Expandable content — body, engagement, replies */}
        <AnimatePresence>
          {cardOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.3, ease: "easeInOut" }}
              className="overflow-hidden"
            >
              {/* Body */}
              <div className="mt-3">
                <MarkdownBody text={displayBody} className="break-words" />
                <ForumMedia url={post.media_url} type={post.media_type} />
                {shouldTruncate && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
                    className="mt-2 flex items-center gap-1 py-2 min-h-[44px] text-[10px] font-bold uppercase tracking-wider text-primary hover:text-primary transition-colors"
                  >
                    {expanded ? <><ChevronUp className="h-3 w-3" /> Show less</> : <><ChevronDown className="h-3 w-3" /> Read more</>}
                  </button>
                )}
              </div>

        {/* Engagement Bar */}
        <div className="forum-engagement-bar mt-5 flex flex-wrap items-center gap-0.5 border-t border-border/20 pt-3">
          <ReactionPicker reactions={post.reactions} legacyLikes={engagement.likes} currentUserId={user?.id} isAuthenticated={isAuthenticated} onReact={onReact} isPending={reactMutation.isPending} reactionProfiles={reactionProfiles} />

          <button
            type="button"
            onClick={() => onToggleReply(post.id)}
            className={`forum-action-button flex min-h-11 items-center justify-center gap-1.5 px-3 py-2 text-xs font-bold transition-all duration-200 border ${
              replyOpen
                ? "bg-accent/10 text-accent border-accent/20"
                : "text-slate-300 hover:text-accent hover:bg-accent/5 border-transparent"
            }`}
            aria-label="Write a reply"
          >
            <Reply className="h-3.5 w-3.5" />
            <span className="text-[10px] uppercase tracking-wider">Reply</span>
            {replies.length > 0 && <span className="rounded-sm bg-muted/60 px-1.5 py-0.5 tabular-nums text-foreground font-bold">{replies.length}</span>}
          </button>

          {isOwner && (
            <button
              type="button"
              onClick={() => onEditPost(post)}
              className="forum-action-button flex min-h-11 items-center justify-center gap-1.5 px-3 py-2 text-xs text-slate-300 hover:text-primary transition-colors border border-transparent"
              title="Edit this post"
            >
              <Pencil className="h-3.5 w-3.5" />
              <span className="hidden sm:inline text-[10px] uppercase tracking-wider">Edit</span>
            </button>
          )}

          <div className="relative" ref={reportRef}>
            <button
              type="button"
              onClick={() => setReportOpen(!reportOpen)}
              className="forum-action-button flex min-h-11 items-center justify-center gap-1.5 px-3 py-2 text-xs text-slate-300 hover:text-amber-400 transition-colors border border-transparent"
              title="Report this post"
            >
              <Flag className="h-3.5 w-3.5" />
            </button>
            {reportOpen && (
              <div className="absolute bottom-full left-0 mb-1 z-20 w-40 border border-border/60 bg-card shadow-xl py-1">
                {["Spam", "Harassment", "Off-topic", "Other"].map((reason) => (
                  <button
                    key={reason}
                    type="button"
                    className="w-full text-left px-3 py-2 text-xs text-slate-200 hover:bg-muted/20 hover:text-foreground transition-colors"
                    onClick={() => {
                      setReportOpen(false);
                      base44.functions.invoke("forumAction", { action: "report", postId: post.id, reason }).then(() => {
                        queryClient.invalidateQueries({ queryKey: ["forumPosts"] });
                        toast({ title: "Report submitted", description: `Reason: ${reason}` });
                      }).catch(() => toast({ title: "Report failed", description: "Please try again." }));
                    }}
                  >
                    {reason}
                  </button>
                ))}
              </div>
            )}
          </div>

          <ShareButton post={post} />
          <SaveButton post={post} />

          {isAuthenticated && ((user?.id && String(post.user_id) === String(user.id)) || isModerator) && (
            <button
              type="button"
              onClick={() => onDeletePost(post)}
              className="forum-action-button flex min-h-11 items-center justify-center gap-1.5 px-3 py-2 text-xs text-slate-300 hover:text-destructive transition-colors border border-transparent"
              title="Remove this thread"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}

          <div className="hidden flex-1 sm:block" />

          {/* Pin/Unpin button for moderators */}
          {isModerator && (
            <button
              type="button"
              onClick={() => {
                base44.functions.invoke("forumAction", { action: "pin", postId: post.id, is_pinned: !post.is_pinned }).then(() => {
                  queryClient.invalidateQueries({ queryKey: ["forumPosts"] });
                });
              }}
              className={`flex min-h-11 items-center gap-1.5 px-3 py-2 text-[10px] font-bold uppercase tracking-wider transition-all border ${
                post.is_pinned
                  ? 'text-primary bg-primary/5 border-primary/20'
                  : 'text-slate-300 hover:text-primary border-transparent hover:border-primary/20'
              }`}
              title={post.is_pinned ? 'Unpin this thread' : 'Pin this thread'}
            >
              <Pin className="h-3 w-3" />
              <span className="hidden sm:inline">{post.is_pinned ? 'Unpin' : 'Pin'}</span>
            </button>
          )}

          {/* View Thread button */}
          <button
            type="button"
            onClick={() => onOpenThread(post)}
            className="flex min-h-11 items-center gap-1.5 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-primary hover:text-primary hover:bg-primary/5 transition-all border border-transparent hover:border-primary/20"
          >
            <Eye className="h-3 w-3" />
            <span>View Thread</span>
          </button>

          {/* Mobile stats */}
          <div className="forum-action-button flex min-h-11 items-center justify-center gap-1 text-[10px] text-slate-300 font-bold md:hidden">
            <Eye className="h-3 w-3 text-primary" />
            <span className="font-mono font-bold tabular-nums text-slate-200">{engagement.views}</span>
          </div>
        </div>

        {/* Replies */}
        <AnimatePresence>
          {replies.length > 0 && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.3, ease: "easeInOut" }}
              className="overflow-hidden"
            >
              <div className="mt-4 space-y-2 border-t border-border/20 pt-4">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[9px] font-bold uppercase tracking-[0.25em] text-slate-300 flex items-center gap-1.5">
                    <MessageCircle className="h-3 w-3 text-primary" />
                    {replies.length} {replies.length === 1 ? "Reply" : "Replies"}
                  </p>
                  {hiddenCount > 0 && !showAllReplies && (
                    <button
                      type="button"
                      onClick={() => setShowAllReplies(true)}
                      className="py-2 min-h-[44px] text-[9px] font-bold uppercase tracking-wider text-primary hover:underline transition-colors"
                    >
                      Show {hiddenCount} more
                    </button>
                  )}
                </div>
                <ReplyTree replies={visibleReplies} activeReplyDraft={activeReplyDraft} {...replyApi} />
                {showAllReplies && hiddenCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowAllReplies(false)}
                    className="py-2 min-h-[44px] text-[9px] font-bold uppercase tracking-wider text-slate-200 hover:text-primary transition-colors"
                  >
                    Collapse replies
                  </button>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Reply Form */}
        <AnimatePresence>
          {replyOpen && (
            <motion.form
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.25 }}
              onSubmit={(e) => onReply(post, e)}
              className="overflow-hidden"
            >
              <div className="mt-4 space-y-3 border-t border-border/20 pt-4">
                <p className="text-[9px] font-bold uppercase tracking-[0.25em] text-slate-300">
                  Write a Reply
                </p>
                {isAuthenticated ? (
                  <div className="flex items-center gap-2 border border-border/30 bg-muted/[0.04] px-3 py-2">
                    <UserAvatar name={user?.full_name || user?.email} size="sm" src={user?.avatar_url} />
                    <span className="text-xs text-slate-300">
                      Replying as <span className="font-bold text-foreground">{user?.full_name || user?.email}</span>
                    </span>
                  </div>
                ) : (
                  <Input
                    required placeholder="Your name"
                    value={replyDraft.author_name}
                    onChange={(e) => onUpdateReply(post.id, { author_name: e.target.value })}
                    className="h-11 rounded-none border-border bg-background text-sm"
                  />
                )}
                <MentionTextarea
                  required
                  people={replyApi?.people}
                  placeholder={`Reply to ${post.author_name || "this thread"}… use @ to mention`}
                  value={replyDraft.body}
                  onChange={(val) => onUpdateReply(post.id, { body: val })}
                  className="min-h-20 rounded-none border-border bg-background text-sm leading-relaxed resize-none"
                />
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" size="mobile" onClick={() => onToggleReply(post.id)} className="rounded-none text-[10px] font-bold uppercase tracking-wider text-slate-300 hover:text-white">
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    size="mobile"
                    disabled={!appReady || (!isAuthenticated && !replyDraft.author_name) || !replyDraft.body || isSubmitting}
                    className="rounded-none bg-primary text-[10px] font-bold uppercase tracking-wider text-white shadow-[0_0_10px_rgba(249,115,22,0.15)] transition-all hover:bg-primary/95 hover:shadow-[0_0_15px_rgba(249,115,22,0.4)]"
                  >
                    <Send className="mr-1.5 h-3.5 w-3.5" /> {isSubmitting ? "Sending…" : "Post Reply"}
                  </Button>
                </div>
              </div>
            </motion.form>
          )}
        </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Recency progress bar at bottom */}
      <div className="h-[2px] w-full bg-border/10 overflow-hidden">
        <motion.div
          className="h-full"
          initial={{ width: 0 }}
          animate={{ width: `${recency * 100}%` }}
          transition={{ duration: 1, delay: 0.3, ease: "easeOut" }}
          style={{
            background: `linear-gradient(90deg, hsl(${meta.hue}, 70%, 50%, 0.6), hsl(${meta.hue}, 70%, 50%, 0.1))`,
          }}
        />
      </div>
    </motion.article>
  );
});


/* ━━━ Mobile Floating Action Button ━━━━━━━━━━━━━━━━━━━━━━ */
function MobileFAB({ onClick }) {
  const [scrollDir, setScrollDir] = useState("up");
  // Hidden near the top of the page: the header already offers "Ask the
  // crowd" and the feed its own compose button there, and the disc otherwise
  // permanently covers a 56px circle of content (it sat over the Travel
  // planning card in the bug report). It fades in once those are off screen.
  const [pastFold, setPastFold] = useState(false);
  const lastScrollY = useRef(0);

  useEffect(() => {
    const onScroll = () => {
      const current = window.scrollY;
      setScrollDir(current > lastScrollY.current ? "down" : "up");
      setPastFold(current > 600);
      lastScrollY.current = current;
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  if (!pastFold) return null;

  return (
    <motion.button
      type="button"
      onClick={onClick}
      animate={{
        scale: scrollDir === "down" ? 0.85 : 1,
        opacity: scrollDir === "down" ? 0.7 : 1,
      }}
      whileTap={{ scale: 0.9 }}
      transition={{ duration: 0.2 }}
      className="forum-compose-fab fixed bottom-[calc(5.5rem+var(--safe-bottom))] right-5 z-40 lg:hidden"
      aria-label="Start a discussion"
    >
      <div className="relative">
        {/* Pulse ring */}
        <motion.div
          className="absolute inset-0 rounded-full bg-primary/30"
          animate={{ scale: [1, 1.5], opacity: [0.5, 0] }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeOut" }}
        />
        <div className="relative h-14 w-14 rounded-full bg-primary shadow-lg shadow-primary/30 flex items-center justify-center text-primary-foreground">
          <MessageSquare className="h-5 w-5" />
        </div>
      </div>
    </motion.button>
  );
}


/* ━━━ MAIN FORUM COMPONENT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
export default function Forum() {
  const { isAuthenticated, user, isAdmin, isModerator } = useAuth();
  const [draft, setDraft] = useState(() => {
    try {
      const saved = localStorage.getItem(DRAFT_STORAGE_KEY);
      if (saved) { const parsed = JSON.parse(saved); if (parsed.title || parsed.body) return parsed; }
    } catch {}
    return emptyPost;
  });
  const [draftRecovered, setDraftRecovered] = useState(() => {
    try {
      const saved = localStorage.getItem(DRAFT_STORAGE_KEY);
      if (saved) { const parsed = JSON.parse(saved); return !!(parsed.title || parsed.body); }
    } catch {}
    return false;
  });
  const [selectedCategory, setSelectedCategory] = useState("All");
  const [searchQuery, setSearchQuery] = useState("");
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [visibleCount, setVisibleCount] = useState(15);
  const [savedPostIds, setSavedPostIds] = useState(getSavedPostIds);

  useEffect(() => {
    setVisibleCount(15);
  }, [selectedCategory, searchQuery]);

  /* ── Collapsible tipping + slot machine position ── */
  const [tippingExpanded, setTippingExpanded] = useState(() => {
    try { return localStorage.getItem("rlt_tipping_expanded") === "true"; } catch { return false; }
  });
  const [slotSpinAvailable, setSlotSpinAvailable] = useState(() => {
    const last = Number(localStorage.getItem(SLOT_LAST_SPIN_KEY) || 0);
    return Date.now() - last >= SPIN_COOLDOWN_MS;
  });
  useEffect(() => {
    const tick = () => {
      const last = Number(localStorage.getItem(SLOT_LAST_SPIN_KEY) || 0);
      setSlotSpinAvailable(Date.now() - last >= SPIN_COOLDOWN_MS);
    };
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, []);
  const toggleTipping = useCallback(() => {
    setTippingExpanded((prev) => {
      const next = !prev;
      try { localStorage.setItem("rlt_tipping_expanded", String(next)); } catch {}
      return next;
    });
  }, []);
  const [sortBy, setSortBy] = useState("latest");
  const [mobileTab, setMobileTab] = useState("feed");
  const [userFilter, setUserFilter] = useState("all");
  useEffect(() => {
    setVisibleCount(15);
  }, [sortBy]);
  const [submittedForReview, setSubmittedForReview] = useState(false);
  const [activeReplyId, setActiveReplyId] = useState(null);
  const [replyDrafts, setReplyDrafts] = useState(loadReplyDrafts);
  const replyDraftsRef = useRef(replyDrafts);
  useEffect(() => { replyDraftsRef.current = replyDrafts; }, [replyDrafts]);
  // Debounced persist of reply drafts (see loadReplyDrafts above), with a
  // flush on pagehide/unmount — a debounce alone dropped the last 1.5s of
  // typing exactly when the app was backgrounded, the case this exists for.
  useEffect(() => {
    const timer = setTimeout(() => persistReplyDrafts(replyDrafts), 1500);
    return () => clearTimeout(timer);
  }, [replyDrafts]);
  useEffect(() => {
    const flush = () => persistReplyDrafts(replyDraftsRef.current);
    window.addEventListener("pagehide", flush);
    return () => { window.removeEventListener("pagehide", flush); flush(); };
  }, []);
  const [editTarget, setEditTarget] = useState(null);
  const [showMobileCompose, setShowMobileCompose] = useState(false);
  // The "Posted — you're live!" banner had no reset: after the first post of a
  // session, every later open of the composer showed a stale success message
  // above an empty form. Clear it whenever the sheet opens.
  useEffect(() => {
    if (showMobileCompose) setSubmittedForReview(false);
  }, [showMobileCompose]);

  // Auto-save draft to localStorage (debounced). Never while editing an
  // existing post — that wrote someone's published post into the new-thread
  // draft slot, and the next visit "recovered" it as a fresh draft, priming a
  // duplicate thread.
  useEffect(() => {
    if (editTarget) return;
    const hasDraftContent = draft.title || draft.body;
    if (!hasDraftContent) {
      try { localStorage.removeItem(DRAFT_STORAGE_KEY); } catch {}
      return;
    }
    const timer = setTimeout(() => {
      try { localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft)); } catch {}
    }, 2000);
    return () => clearTimeout(timer);
  }, [draft, editTarget]);

  // "/" keyboard shortcut focuses the forum search (desktop power-user nicety)
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable) return;
      e.preventDefault();
      document.getElementById("forum-search-input")?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Re-sync saved post IDs when localStorage changes (e.g. from SaveButton)
  useEffect(() => {
    const onStorage = () => setSavedPostIds(getSavedPostIds());
    window.addEventListener("storage", onStorage);
    // Also listen for same-tab changes via custom event dispatched by SaveButton
    const onSaveToggle = () => setSavedPostIds(getSavedPostIds());
    window.addEventListener("rlt_saved_posts_changed", onSaveToggle);
    return () => { window.removeEventListener("storage", onStorage); window.removeEventListener("rlt_saved_posts_changed", onSaveToggle); };
  }, []);

  // Lock body scroll while the mobile compose sheet is open. Ref-counted so
  // the thread modal's delayed cleanup can't unlock the page under this sheet.
  useEffect(() => {
    if (!showMobileCompose) return undefined;
    return lockBodyScroll();
  }, [showMobileCompose]);

  // iOS WKWebView does not shrink the layout viewport for the keyboard, so a
  // bottom-anchored dvh sheet keeps ~330px — including the Post button —
  // hidden behind it. Track the VISUAL viewport (same pattern as the Store
  // cart drawer) and size the sheet to what is actually visible.
  const [composeViewport, setComposeViewport] = useState(null);
  useEffect(() => {
    if (!showMobileCompose || !window.visualViewport) {
      setComposeViewport(null);
      return undefined;
    }
    const viewport = window.visualViewport;
    const syncViewport = () => {
      // Only override the sheet geometry while the keyboard is actually
      // shrinking the visual viewport. Unconditional syncing set top:0 the
      // moment the sheet opened (keyboard closed), pinning the bottom sheet
      // to the TOP of the screen — the pass-2 review's launch blocker.
      const keyboardOpen = viewport.height < window.innerHeight - 100;
      setComposeViewport(keyboardOpen
        ? {
            height: Math.max(320, Math.round(viewport.height)),
            top: Math.max(0, Math.round(viewport.offsetTop)),
          }
        : null);
    };
    syncViewport();
    viewport.addEventListener("resize", syncViewport);
    viewport.addEventListener("scroll", syncViewport);
    return () => {
      viewport.removeEventListener("resize", syncViewport);
      viewport.removeEventListener("scroll", syncViewport);
    };
  }, [showMobileCompose]);
  // Only the thread ID is stored; the post object is derived from the live
  // list further down. Storing the object froze a snapshot: a reply posted
  // from inside the modal cleared your textarea and then never appeared, the
  // 30s poll never updated the open thread, and deleting it left a ghost.
  const [threadModalId, setThreadModalId] = useState(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const { data: posts = [], isLoading: isLoadingPosts } = useQuery({
    queryKey: ["forumPosts"],
    // 100 covered threads AND replies, so at ~10 replies per thread only about
    // nine threads were reachable — and buildForumThreads silently drops replies
    // whose root has aged out, so whole active threads vanished from the feed
    // and ?thread= deep links to them did nothing. 500 is the client default.
    queryFn: () => base44.entities.ForumPost.list("-created_date", 500),
    enabled: appParams.hasBase44Config,
    refetchInterval: 30000,
  });
  // Current avatars by user id, so changing a profile photo updates that
  // member's existing threads/replies. Falls back to the per-post snapshot, then
  // a monogram. Degrades gracefully if the function isn't deployed yet.
  const { data: avatarData } = useQuery({
    queryKey: ["forumAvatars"],
    queryFn: () => base44.functions.invoke("forumAvatars", {}),
    enabled: appParams.hasBase44Config,
    retry: false,
    meta: { silent: true },
    staleTime: 60000,
  });
  // Club crests (from the Events teams list) so a member's favourite team shows
  // its logo next to their name instead of a generic emoji.
  const { data: teamRecords = [] } = useQuery({
    queryKey: ["teams"],
    queryFn: () => base44.entities.Team.list("name", 200),
    enabled: appParams.hasBase44Config,
    retry: false,
    meta: { silent: true },
    staleTime: 60000,
  });
  const teamLogoByName = useMemo(
    () => new Map((teamRecords || []).map((t) => [String(t.name || "").trim().toLowerCase(), t.logo_url || ""])),
    [teamRecords]
  );
  // Per-user forum profile: avatar + the optional location/team a member chose to
  // display. Built from the forumAvatars function; the viewer's own row is merged
  // in live so their changes show immediately.
  const profileById = useMemo(() => {
    const map = new Map((avatarData?.data?.avatars || []).map((a) => [String(a.id), { display_name: a.display_name || "Member", avatar_url: a.avatar_url || "", location: a.location || "", team: a.team || "", badges: parseBadgeIds(a.badges), casino_rank: a.casino_rank || "Rookie Punter", casino_xp: Number(a.casino_xp || 0), casino_chips: Number(a.casino_chips || 0), casino_streak: Number(a.casino_streak || 0), is_member: a.is_member === true }]));
    if (isAuthenticated && user?.id) {
      // The viewer's own row, live — including badges saved to their profile and
      // any just won this session (kept in localStorage).
      let localBadges = [];
      try { localBadges = parseBadgeIds(JSON.parse(localStorage.getItem("rlt_slot_badges") || "[]")); } catch { localBadges = []; }
      const badges = Array.from(new Set([...parseBadgeIds(user.badges), ...localBadges]));
      map.set(String(user.id), {
        display_name: user.full_name || user.email || "You",
        avatar_url: user.avatar_url || "",
        location: user.show_location_on_forum ? [user.city, user.country].filter(Boolean).join(", ") : "",
        team: user.show_team_on_forum ? (user.favourite_team || "") : "",
        badges, casino_rank: user.casino_rank || "Rookie Punter", casino_xp: Number(user.casino_xp || 0), casino_chips: Number(user.casino_chips || 0), casino_streak: Number(user.casino_streak || 0),
        is_member: isActiveMember(user),
      });
    }
    return map;
  }, [avatarData, isAuthenticated, user]);
  const avatarFor = useCallback((userId, snapshot) => (userId && profileById.get(String(userId))?.avatar_url) || snapshot || "", [profileById]);
  const forumMetaFor = useCallback((userId) => {
    const p = userId && profileById.get(String(userId));
    if (!p) return null;
    const teamLogo = p.team ? (teamLogoByName.get(String(p.team).trim().toLowerCase()) || "") : "";
    return { ...p, teamLogo, badge: topBadge(p.badges) };
  }, [profileById, teamLogoByName]);

  const createMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (data) => {
      if (!isAuthenticated || !user?.id) throw new Error("Sign in to post in the forum.");
      const authorName = user?.full_name || user?.email || "Member";
      const post = buildPendingForumPost({ ...data, author_name: authorName });
      const response = await base44.functions.invoke("submitForumPost", {
        author_name: post.author_name, title: post.title, body: post.body,
        category: post.category, parent_id: post.parent_id, media_url: data.media_url || "",
      });
      return { ...response.data, parent_id: post.parent_id };
    },
    onSuccess: (data) => {
      successImpact();
      queryClient.invalidateQueries({ queryKey: ["forumPosts"] }); queryClient.invalidateQueries({ queryKey: ["forumAvatars"] });
      setDraft(emptyPost);
      // Only the draft that was just submitted is cleared — the old blanket
      // wipe deleted every OTHER thread's persisted reply draft too. Storage
      // is updated synchronously so the 1.5s debounce can't resurrect the
      // posted text (or drop the clear) if the page unloads first.
      setReplyDrafts((current) => {
        if (!data?.parent_id) return current;
        const next = { ...current };
        delete next[data.parent_id];
        persistReplyDrafts(next);
        return next;
      });
      setActiveReplyId(null); setSubmittedForReview(true); setShowMobileCompose(false); setDraftRecovered(false);
      if (!data?.parent_id) { setSelectedCategory("All"); setSearchQuery(""); setSortBy("latest"); setUserFilter("all"); setMobileTab("feed"); }
      try { localStorage.removeItem(DRAFT_STORAGE_KEY); } catch {}
      toast({ title: data?.id ? "Post published" : "Post submitted", description: "Your discussion is now visible in the forum." });
      triggerAppStoreReview();
      if (data?.reward) {
        // Pre-compute the conditional part — nested template literals inside ${}
        // have broken the Base44 build pipeline before (publish-killer pattern).
        const streakNote = data.reward.streak ? " · " + data.reward.streak + " day streak" : "";
        toast({ title: `+${data.reward.xp} XP · +${data.reward.chips} chips`, description: data.reward.rank + streakNote });
      }
    },
    onError: (error) => {
      errorImpact();
      toast({ title: "Post failed", description: error?.response?.data?.error || error?.message || "Please try again." });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => base44.functions.invoke("forumAction", { action: "update", postId: id, ...data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["forumPosts"] });
      setDraft(emptyPost); setEditTarget(null); setShowMobileCompose(false);
      toast({ title: "Post updated" });
    },
  });

  const handlePost = (e) => {
    e.preventDefault();
    // The button's disabled prop lands a render late — a double-tap (or the
    // iOS "Go" key firing an implicit submit) could create the thread twice.
    if (createMutation.isPending || updateMutation.isPending) return;
    if (!isAuthenticated || !user?.id || !draft.title || !draft.body) return;
    if (editTarget) {
      updateMutation.mutate({ id: editTarget.id, data: { title: draft.title, body: draft.body, category: draft.category, media_url: draft.media_url || "" } });
    } else {
      createMutation.mutate(draft);
    }
  };

  const getReplyDraft = useCallback((postId) => replyDrafts[postId] || emptyReply, [replyDrafts]);
  const updateReplyDraft = useCallback((postId, updates) => {
    setReplyDrafts((c) => ({ ...c, [postId]: { ...emptyReply, ...c[postId], ...updates } }));
  }, []);

  // Drafts and the in-flight flag are read through refs so this callback stays
  // REFERENTIALLY STABLE: with the mutation object or replyDrafts in the deps,
  // every keystroke minted a new handleReply → new replyApi → props changed on
  // every card → React.memo defeated for the whole feed on a phone keyboard.
  const createPendingRef = useRef(false);
  useEffect(() => { createPendingRef.current = createMutation.isPending; }, [createMutation.isPending]);
  const createReply = createMutation.mutate; // stable across renders

  const handleReply = useCallback((post, e) => {
    e.preventDefault();
    const parentId = String(post?.id || "").trim();
    const reply = replyDraftsRef.current[parentId] || emptyReply;
    if (createPendingRef.current) return; // double-tap guard
    if (!parentId || !isAuthenticated || !user?.id || !reply.body) return;
    // Replying to a reply must not compound the prefix into "Re: Re: Re: …" —
    // strip any existing chain before adding a single "Re:".
    const rootTitle = String(post.title || "Discussion Thread").replace(/^(\s*Re:\s*)+/i, "").trim() || "Discussion Thread";
    createReply({
      author_name: reply.author_name,
      title: `Re: ${rootTitle}`,
      body: reply.body,
      category: post.category || "General",
      parent_id: parentId,
      media_url: reply.media_url || "",
    });
  }, [isAuthenticated, user?.id, createReply]);

  const deleteMutation = useMutation({
    mutationFn: (postId) => base44.functions.invoke("forumAction", { action: "delete", postId }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["forumPosts"] }); toast({ title: "Removed" }); },
  });

  const [deleteTarget, setDeleteTarget] = useState(null);

  const handleDelete = useCallback((node) => {
    if (!node?.id) return;
    setDeleteTarget(node);
  }, []);

  const confirmDelete = useCallback(() => {
    if (deleteTarget?.id) deleteMutation.mutate(deleteTarget.id);
    setDeleteTarget(null);
  }, [deleteTarget, deleteMutation]);

  const openDiscussionComposer = useCallback(() => {
    if (typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches) {
      setMobileTab("feed");
      requestAnimationFrame(() => {
        const composer = document.getElementById("forum-compose-sidebar");
        if (composer) composer.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      return;
    }
    setShowMobileCompose(true);
  }, []);

  const handleToggleReply = useCallback((postId) => {
    if (!isAuthenticated) {
      window.location.assign("/login?next=%2Fforum");
      return;
    }
    setActiveReplyId((curr) => (curr === postId ? null : postId));
  }, [isAuthenticated]);

  const handleOpenThread = useCallback((p) => {
    if (!p?.id) return;
    setThreadModalId(p.id);
    markThreadRead(p.id);
  }, []);

  const handleEditPost = useCallback((post) => {
    setDraft({ author_name: post.author_name || "", title: post.title || "", body: post.body || "", category: post.category || "General", media_url: post.media_url || "" });
    setEditTarget(post);
    // The mobile sheet is lg:hidden — opening it on desktop showed nothing
    // while still locking body scroll. Desktop edits use the sidebar composer.
    if (typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches) {
      requestAnimationFrame(() => {
        document.getElementById("forum-compose-sidebar")?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      return;
    }
    setShowMobileCompose(true);
  }, []);

  const allThreads = useMemo(() => buildForumThreads(posts), [posts]);

  // Mentionable people for @autocomplete — every participant currently in the
  // forum, plus the logged-in member. Used as a client-side fallback so mentions
  // work even before the searchUsers function is deployed (MentionTextarea also
  // merges the full user directory from that function when it's available).
  const mentionPeople = useMemo(() => {
    const names = new Set();
    allThreads.forEach((t) => {
      if (t.author_name) names.add(t.author_name);
      (t.replies || []).forEach((r) => { if (r.author_name) names.add(r.author_name); });
    });
    if (isAuthenticated && (user?.full_name || user?.email)) names.add(user.full_name || user.email);
    return [...names].map((name) => ({ name }));
  }, [allThreads, isAuthenticated, user]);

  // Shared API for the recursive ReplyTree (reply to / delete any comment at
  // any depth). `people` lives INSIDE the memo — it used to be assigned onto
  // the memoized object during render, which React may legally discard.
  const replyApi = useMemo(() => ({
    isAuthenticated,
    user,
    isModerator,
    isSubmitting: createMutation.isPending,
    activeReplyId,
    onToggleReply: handleToggleReply,
    onUpdateReply: updateReplyDraft,
    onReply: handleReply,
    onDelete: handleDelete,
    timeAgo,
    resolveAvatar: avatarFor,
    resolveMeta: forumMetaFor,
    people: mentionPeople,
  }), [
    isAuthenticated,
    user,
    isModerator,
    createMutation.isPending,
    activeReplyId,
    handleToggleReply,
    updateReplyDraft,
    handleReply,
    handleDelete,
    avatarFor,
    forumMetaFor,
    mentionPeople
  ]);

  // The modal's post, always fresh from the live list; vanishes (closing the
  // modal) if the thread is deleted out from under it.
  const threadModalPost = useMemo(
    () => (threadModalId ? allThreads.find((t) => t.id === threadModalId) || null : null),
    [allThreads, threadModalId]
  );

  // Deep-link: /forum?thread=<id> (used by notifications) opens that thread, then
  // clears the param so closing the modal doesn't reopen it.
  const threadParam = searchParams.get("thread");
  useEffect(() => {
    if (!threadParam || !posts.length) return;
    const threads = buildForumThreads(posts);
    // Older notifications linked reply IDs (not roots) — resolve the thread
    // that CONTAINS the id so those taps still land somewhere.
    const containsId = (replies) => (replies || []).some((r) => r.id === threadParam || containsId(r.replies));
    const target = threads.find((t) => t.id === threadParam) || threads.find((t) => containsId(t.replies));
    if (target) {
      setThreadModalId(target.id);
      markThreadRead(target.id);
      const next = new URLSearchParams(searchParams);
      next.delete("thread");
      setSearchParams(next, { replace: true });
    }
  }, [threadParam, posts]); // eslint-disable-line react-hooks/exhaustive-deps

  // Author post/reply counts for badges and hover cards
  const { authorPostCounts, authorReplyCounts } = useMemo(() => {
    const postCounts = {};
    const replyCounts = {};
    allThreads.forEach(t => {
      const name = t.author_name;
      if (name) postCounts[name] = (postCounts[name] || 0) + 1;
      (t.replies || []).forEach(r => {
        if (r.author_name) replyCounts[r.author_name] = (replyCounts[r.author_name] || 0) + 1;
      });
    });
    return { authorPostCounts: postCounts, authorReplyCounts: replyCounts };
  }, [allThreads]);

  // Category counts
  const categoryCounts = useMemo(() => {
    const counts = { All: allThreads.length };
    FORUM_CATEGORIES.forEach((c) => { counts[c] = 0; });
    allThreads.forEach((thread) => {
      if (thread.category && counts[thread.category] !== undefined) {
        counts[thread.category] += 1;
      }
    });
    return counts;
  }, [allThreads]);

  // Filter + Sort
  const filteredThreads = useMemo(() => {
    const normalizedSearch = deferredSearchQuery.trim().toLowerCase();
    let result = allThreads
      .filter((p) => selectedCategory === "All" || p.category === selectedCategory)
      .filter((p) => {
        if (!normalizedSearch) return true;
        const replyText = (p.replies || []).map((r) => `${r.body || ""} ${r.author_name || ""}`).join(" ");
        return `${p.title || ""} ${p.body || ""} ${p.author_name || ""} ${replyText}`.toLowerCase().includes(normalizedSearch);
      });

    if (isAuthenticated && user) {
      if (userFilter === "my_threads") {
        result = result.filter((p) => String(p.user_id) === String(user.id));
      } else if (userFilter === "mentions") {
        // Match what the composer actually INSERTS: the autocomplete writes
        // @handles with whitespace stripped ("@johnsmith"), so filtering on
        // the raw spaced display name matched nothing for anyone with a
        // space in their name. Match the handle, the raw name (hand-typed
        // mentions), and the email local-part.
        const needles = [
          toHandle(user.full_name || ""),
          (user.full_name || "").toLowerCase(),
          (user.email || "").toLowerCase().split("@")[0],
        ].filter(Boolean).map((n) => `@${n}`);
        const mentionsMe = (text) => {
          const lower = (text || "").toLowerCase();
          return needles.some((n) => lower.includes(n));
        };
        const anyReplyMentionsMe = (replies) => (replies || []).some(
          (r) => mentionsMe(r.body) || anyReplyMentionsMe(r.replies)
        );
        result = result.filter((p) =>
          mentionsMe(p.body) || mentionsMe(p.title) || anyReplyMentionsMe(p.replies));
      }
    }

    if (sortBy === "hot") {
      result = [...result].sort((a, b) => getEngagement(b).likes - getEngagement(a).likes);
    } else if (sortBy === "top") {
      result = [...result].sort((a, b) => getEngagement(b).views - getEngagement(a).views);
    }
    // Pinned threads always float to the top (stable within sort order)
    return [...result].sort((a, b) => (b.is_pinned === true) - (a.is_pinned === true));
  }, [allThreads, selectedCategory, deferredSearchQuery, sortBy, isAuthenticated, user, userFilter]);

  const threadsToRender = useMemo(() => {
    return filteredThreads.slice(0, visibleCount);
  }, [filteredThreads, visibleCount]);

  const totalReplies = useMemo(() => allThreads.reduce((s, t) => s + (t.replies || []).length, 0), [allThreads]);
  const uniqueMembers = useMemo(() => new Set(allThreads.map((t) => t.author_name)).size, [allThreads]);

  const clearAllFilters = () => {
    setSelectedCategory("All");
    setSearchQuery("");
    setSortBy("latest");
    setUserFilter("all");
  };

  return (
    <main className="forum-mobile-shell relative min-h-dvh overflow-x-hidden bg-background text-foreground">
      {/* ━━━ HERO SECTION ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <section className="forum-mobile-hero relative overflow-hidden border-b border-border/50">
        <div className="absolute inset-0 cmd-grid-bg opacity-40" />
        <div className="absolute inset-0 bg-gradient-to-b from-primary/[0.04] via-transparent to-background" />
        <FloatingParticles />

        <div className="relative z-10 mx-auto max-w-6xl px-3 pb-4 pt-[calc(6.5rem+env(safe-area-inset-top,0px))] sm:px-5 sm:pb-10 sm:pt-[calc(8rem+env(safe-area-inset-top,0px))] md:px-8 md:pt-[calc(8.5rem+env(safe-area-inset-top,0px))] md:pb-12">
          {/* Breadcrumb */}
          <motion.nav initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="mb-5 hidden items-center gap-2 sm:flex">
            <Link to="/" className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground/30 hover:text-primary transition-colors">Home</Link>
            <span className="text-muted-foreground/20">/</span>
            <span className="text-[10px] font-mono uppercase tracking-wider text-primary font-bold">Forum</span>
          </motion.nav>

          <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-6">
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: [0.25, 0.46, 0.45, 0.94] }}>
              <div className="flex items-center gap-2 mb-3">
                <Radio className="h-3.5 w-3.5 text-primary cmd-pulse" />
                <p className="text-[9px] font-bold uppercase tracking-[0.4em] text-primary font-mono">Fan Discussion Board</p>
                <span className="ml-1 inline-flex items-center gap-1 px-1.5 py-0.5 bg-emerald-500/10 border border-emerald-500/20 text-[9px] font-bold uppercase tracking-wider text-emerald-400">
                  <Activity className="h-2 w-2" /> Live
                </span>
              </div>
              {/* One line on phones — at two stacked lines plus the intro
                  paragraph, the first real post sat 2–3 screens down. */}
              <h1 className="font-display text-3xl sm:text-6xl md:text-7xl uppercase tracking-tight leading-[0.92]">
                <span className="sm:block">Footy Fan </span>
                <span className="sm:block bg-gradient-to-r from-primary via-accent to-primary bg-clip-text text-transparent">Forum</span>
              </h1>
              <p className="mt-3 hidden max-w-md text-sm leading-6 text-muted-foreground/60 sm:mt-4 sm:block sm:leading-relaxed">
                Connect with fellow Rugby League fans heading to Las Vegas. Share tips, plan meetups, and get the inside word on the takeover.
              </p>
            </motion.div>

            {/* Stats Bar */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15, duration: 0.5 }}
              className="hidden w-full grid-cols-3 border border-border/40 bg-card/20 cmd-glass divide-x divide-border/30 sm:grid lg:w-auto"
            >
              {[
                { icon: MessageSquare, value: allThreads.length, label: "Threads" },
                { icon: MessageCircle, value: totalReplies, label: "Replies" },
                { icon: Users, value: uniqueMembers, label: "Members" },
              ].map(({ icon: SIcon, value, label }) => (
                <div key={label} className="flex min-w-0 items-center gap-2 px-2 py-3 sm:gap-3 sm:px-4 md:px-5">
                  <div className="shrink-0 p-1.5 bg-muted/20 border border-border/30">
                    <SIcon className="h-3.5 w-3.5 text-primary/70" />
                  </div>
                  <div>
                    <p className="font-display text-xl tabular-nums text-foreground leading-none">
                      {isLoadingPosts ? <span className="text-muted-foreground/40">—</span> : <AnimatedNumber value={value} />}
                    </p>
                    <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-muted-foreground/40">{label}</p>
                  </div>
                </div>
              ))}
            </motion.div>
            {/* Phones get the same numbers as one quiet line instead of a
                three-cell bordered grid (~110px saved). While loading, show
                nothing rather than animating 0 THREADS · 0 MEMBERS — a brand
                new visitor's first impression shouldn't be a dead forum. */}
            {!isLoadingPosts && (
              <p className="text-[10px] font-mono font-bold uppercase tracking-[0.2em] text-muted-foreground/50 sm:hidden">
                {allThreads.length} threads · {totalReplies} replies · {uniqueMembers} members
              </p>
            )}
          </div>
        </div>
      </section>

      {/* ━━━ MAIN CONTENT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <div className="forum-mobile-content mx-auto max-w-6xl px-2 pb-[calc(9rem+var(--safe-bottom))] pt-4 sm:px-5 sm:py-6 md:px-8 md:py-8">
        <ForumQuickActionRail
          onStartDiscussion={openDiscussionComposer}
          onOpenTools={() => {
            // Switching the tab alone looked like a dead tap (the reported
            // "Fan tools doesn't go anywhere" bug on the apps): on phones the
            // tools panel mounts BELOW the rail + Trending + ad blocks, well
            // under the fold, and on desktop that panel is lg:hidden entirely
            // (the tools live in the right sidebar). Scroll to whichever
            // container actually hosts the tools on this breakpoint.
            setMobileTab("tools");
            requestAnimationFrame(() => {
              const desktop = window.matchMedia?.("(min-width: 1024px)")?.matches;
              document
                .getElementById(desktop ? "forum-compose-sidebar" : "forum-mobile-tabs")
                ?.scrollIntoView({ behavior: "smooth", block: "start" });
            });
          }}
        />

        {/* Trending — desktop only, and only once there are enough threads
            that "top 3 by likes" isn't just the same three cards the phone
            reader is about to scroll past anyway. */}
        {allThreads.length >= 8 && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="hidden border border-border/40 bg-card/20 cmd-glass overflow-hidden mb-6 lg:block"
          >
            <div className="h-[2px] w-full bg-gradient-to-r from-primary via-accent to-primary" />
            <div className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <TrendingUp className="h-3.5 w-3.5 text-primary" />
                <span className="text-[9px] font-bold uppercase tracking-[0.35em] text-primary">Trending Now</span>
                <div className="flex-1" />
                <span className="text-[10px] font-mono text-muted-foreground/30">Updated live</span>
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                {[...allThreads].sort((a, b) => getEngagement(b).likes - getEngagement(a).likes).slice(0, 3).map((t, i) => (
                  <TrendingCard key={t.id} thread={t} rank={i + 1} onClick={() => handleOpenThread(t)} />
                ))}
              </div>
            </div>
          </motion.div>
        )}

        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,_1fr)_320px]">
          {/* ━━━ LEFT: Feed ━━━ */}
          <div className="min-w-0 space-y-4">
            {/* Live Activity Ticker */}
            <LiveActivityTicker threads={allThreads} />

            {/* Draft Recovered Banner */}
            <AnimatePresence>
              {draftRecovered && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="mb-4 overflow-hidden"
                >
                  <div className="flex items-center justify-between gap-2 border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2">
                    <p className="text-xs text-amber-300"><Sparkles className="inline h-3 w-3 mr-1" />Draft recovered from your previous session.</p>
                    <button type="button" onClick={() => setDraftRecovered(false)} className="text-amber-300/60 hover:text-amber-300 transition-colors">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Mobile Tab Selector Segmented Control */}
            <div id="forum-mobile-tabs" className="flex scroll-mt-[calc(4.5rem+var(--safe-top))] border border-border bg-card/30 p-1 mb-4 lg:hidden">
              <button
                type="button"
                onClick={() => setMobileTab("feed")}
                className={`relative flex-1 flex min-h-11 items-center justify-center text-xs font-bold uppercase tracking-wider transition-colors duration-200 cursor-pointer ${
                  mobileTab === "feed" ? "text-foreground font-extrabold" : "text-slate-400"
                }`}
              >
                Discussions
                {mobileTab === "feed" && (
                  <motion.div
                    layoutId="forum-mobile-active-tab-glow"
                    className="absolute inset-0 bg-muted/30 border border-border/50"
                    style={{ boxShadow: "0 0 10px hsl(var(--primary)/0.3)" }}
                  />
                )}
              </button>
              <button
                type="button"
                onClick={() => setMobileTab("tools")}
                className={`relative flex-1 flex min-h-11 items-center justify-center text-xs font-bold uppercase tracking-wider transition-colors duration-200 cursor-pointer ${
                  mobileTab === "tools" ? "text-foreground font-extrabold" : "text-slate-400"
                }`}
              >
                Fan Tools
                {mobileTab === "tools" && (
                  <motion.div
                    layoutId="forum-mobile-active-tab-glow"
                    className="absolute inset-0 bg-muted/30 border border-border/50"
                    style={{ boxShadow: "0 0 10px hsl(var(--primary)/0.3)" }}
                  />
                )}
              </button>
              <button
                type="button"
                onClick={() => setMobileTab("saved")}
                className={`relative flex-1 flex min-h-11 items-center justify-center gap-1 text-xs font-bold uppercase tracking-wider transition-colors duration-200 cursor-pointer ${
                  mobileTab === "saved" ? "text-foreground font-extrabold" : "text-slate-400"
                }`}
              >
                <Bookmark className="h-3 w-3" />
                Saved
                {mobileTab === "saved" && (
                  <motion.div
                    layoutId="forum-mobile-active-tab-glow"
                    className="absolute inset-0 bg-muted/30 border border-border/50"
                    style={{ boxShadow: "0 0 10px hsl(var(--primary)/0.3)" }}
                  />
                )}
              </button>
            </div>

            {/* Mobile Tab Content: Tools */}
            {mobileTab === "tools" ? (
              <div className="space-y-4 lg:hidden">
                <FanRankCard />
                <DailyMissions />
                <Suspense fallback={<div className="h-64 bg-card/10 animate-pulse border border-border/10" />}>
                  <ScorePredictor
                    onSharePrediction={(matchup, homeScore, awayScore) => {
                      const home = matchup.home_team;
                      const away = matchup.away_team;
                      const label = matchup.label || "NRL Fixture";
                      setEditTarget(null); // tool content primes a NEW post, never an edit
                      setDraft((d) => ({
                        ...d,
                        title: `[Tip] ${home} ${homeScore} - ${awayScore} ${away}`,
                        body: `My footy tip for ${label}: ${home} ${homeScore} - ${awayScore} ${away}. Who are you backing?`,
                        category: "MatchDay",
                      }));
                      setShowMobileCompose(true);
                    }}
                  />
                </Suspense>
                <Suspense fallback={<div className="h-64 bg-card/10 animate-pulse border border-border/10" />}>
                  <StadiumSeatPlanner
                    onFilterSearch={(q) => { setSearchQuery(q); setMobileTab("feed"); }}
                    onClaimSeat={(q) => {
                      setEditTarget(null); // tool content primes a NEW post, never an edit
                      setDraft((d) => ({
                        ...d,
                        title: `[${q}] Supporter Meetup!`,
                        body: `Hey fellow fans! I am sitting in ${q}. Let's coordinate and sync up at the game!`,
                        category: "MatchDay",
                      }));
                      setShowMobileCompose(true);
                      try {
                        localStorage.setItem("rlt_seat_claimed", q);
                        window.dispatchEvent(new CustomEvent("rlt_badge_event", { detail: { action: "claim_seat" } }));
                      } catch (err) {}
                    }}
                    currentSearch={searchQuery}
                  />
                </Suspense>
                <Suspense fallback={<div className="h-28 bg-card/10 animate-pulse border border-border/10" />}>
                  <SlotMachineBadgeUnlock />
                </Suspense>
                <TopContributors allThreads={allThreads} />
                <OnlineUsersWidget threads={allThreads} />
                <a
                  href="https://www.facebook.com/groups/663237792349090"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-3 border border-[#1877F2]/20 bg-[#1877F2]/[0.04] px-4 py-3.5 group hover:bg-[#1877F2]/[0.08] transition-all"
                >
                  <svg viewBox="0 0 24 24" className="h-6 w-6 text-[#1877F2] shrink-0" fill="currentColor"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-foreground">Join NRL Las Vegas on Facebook</p>
                    <p className="text-[10px] text-muted-foreground font-mono mt-0.5">16.8k members · Meetups, tickets, travel tips</p>
                  </div>
                  <svg viewBox="0 0 24 24" className="h-4 w-4 text-[#1877F2] shrink-0 group-hover:translate-x-0.5 transition-transform" fill="none" stroke="currentColor" strokeWidth="2"><path d="M7 17L17 7M17 7H7M17 7v10"/></svg>
                </a>
                <CollapsibleGuidelines />
              </div>
            ) : mobileTab === "saved" ? (
              <div className="space-y-4 lg:hidden">
                {(() => {
                  const savedThreads = allThreads.filter((t) => savedPostIds.includes(t.id));
                  if (savedThreads.length === 0) {
                    return (
                      <div className="flex flex-col items-center justify-center py-16 text-center border border-border/30 bg-card/20">
                        <Bookmark className="h-10 w-10 text-muted-foreground/30 mb-4" />
                        <p className="text-sm font-bold text-foreground mb-1">No saved posts yet</p>
                        <p className="text-xs text-muted-foreground/50 max-w-xs">Save threads from the forum to find them here.</p>
                      </div>
                    );
                  }
                  return savedThreads.map((post, index) => {
                    const isActiveThread = activeReplyId && (activeReplyId === post.id || containsActiveReply(post, activeReplyId));
                    const activeReplyDraftSaved = isActiveThread ? (replyDrafts[activeReplyId] || emptyReply) : emptyReply;
                    return (
                      <ForumPostCard
                        key={post.id} post={post} index={index}
                        isAuthenticated={isAuthenticated} user={user} isModerator={isModerator}
                        appReady={appParams.hasBase44Config} isSubmitting={createMutation.isPending || updateMutation.isPending}
                        replyOpen={activeReplyId === post.id}
                        replyDraft={activeReplyId === post.id ? (replyDrafts[post.id] || emptyReply) : emptyReply}
                        onToggleReply={handleToggleReply}
                        onUpdateReply={updateReplyDraft}
                        onReply={handleReply}
                        onOpenThread={handleOpenThread}
                        onDeletePost={handleDelete}
                        onEditPost={handleEditPost}
                        replyApi={replyApi}
                        activeReplyDraft={activeReplyDraftSaved}
                        authorPostCounts={authorPostCounts}
                        authorReplyCounts={authorReplyCounts}
                        resolveAvatar={avatarFor}
                        resolveMeta={forumMetaFor}
                        reactionProfiles={profileById}
                      />
                    );
                  });
                })()}
              </div>
            ) : null}

            {/* Mobile Tab Content: Feed */}
            <div className={mobileTab === "feed" ? "space-y-4" : "hidden lg:block lg:space-y-4"}>
              {/* Search + Filter Bar */}
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
                className="border border-border/40 bg-card/20 cmd-glass overflow-hidden"
              >
                <div className="space-y-3 p-3 sm:p-4">
                  {/* Search + Sort row */}
                  <div className="flex flex-col gap-3 sm:flex-row">
                    <div className="relative flex-1">
                      <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/30" />
                      <Input
                        id="forum-search-input"
                        placeholder="Search discussions… (press / to focus)"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="h-11 rounded-none border-border/50 bg-background/60 pl-9 text-sm"
                      />
                      {searchQuery && (
                        <button type="button" onClick={() => setSearchQuery("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/30 hover:text-foreground transition-colors">
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                    <SortTabs active={sortBy} onChange={setSortBy} />
                  </div>

                  {/* Categories collapsed into a sticky horizontal rail on mobile, flex on desktop */}
                  <div className="forum-filter-rail gap-2 pb-2 scroll-smooth md:flex md:flex-wrap md:mx-0 md:px-0" style={{ WebkitMaskImage: 'linear-gradient(to right, transparent, black 3%, black 97%, transparent)', maskImage: 'linear-gradient(to right, transparent, black 3%, black 97%, transparent)' }}>
                    {categories.map((cat) => (
                      <CategoryPill
                        key={cat.value}
                        value={cat.value}
                        isActive={selectedCategory === cat.value}
                        onClick={() => setSelectedCategory(cat.value)}
                        count={categoryCounts[cat.value] || 0}
                      />
                    ))}
                  </div>

                  {/* My Threads & Mentions for signed in users */}
                  {isAuthenticated && (
                    <div className="flex flex-wrap items-center gap-2 border-t border-border/10 pt-2 text-[10px] font-bold uppercase tracking-wider">
                      <span className="text-muted-foreground/50">Show:</span>
                      <button
                        type="button"
                        onClick={() => setUserFilter("all")}
                        className={`px-2.5 py-1 transition-all border cursor-pointer ${
                          userFilter === "all" ? "border-primary bg-primary/10 text-foreground" : "border-border/30 text-slate-400 hover:text-white"
                        }`}
                      >
                        All Posts
                      </button>
                      <button
                        type="button"
                        onClick={() => setUserFilter("my_threads")}
                        className={`px-2.5 py-1 transition-all border cursor-pointer ${
                          userFilter === "my_threads" ? "border-primary bg-primary/10 text-foreground" : "border-border/30 text-slate-400 hover:text-white"
                        }`}
                      >
                        My Threads
                      </button>
                      <button
                        type="button"
                        onClick={() => setUserFilter("mentions")}
                        className={`px-2.5 py-1 transition-all border cursor-pointer ${
                          userFilter === "mentions" ? "border-primary bg-primary/10 text-foreground" : "border-border/30 text-slate-400 hover:text-white"
                        }`}
                      >
                        Mentions
                      </button>
                    </div>
                  )}

                  {/* Summary */}
                  <div className="flex min-w-0 items-center justify-between gap-3 border-t border-border/20 pt-1">
                    <p className="text-[9px] font-mono text-muted-foreground/30">
                      {filteredThreads.length} {filteredThreads.length === 1 ? "thread" : "threads"}
                      {selectedCategory !== "All" ? ` in ${getCategoryMeta(selectedCategory).label}` : ""}
                      {searchQuery ? ` matching "${searchQuery}"` : ""}
                      {sortBy !== "latest" ? ` · sorted by ${sortBy}` : ""}
                      {userFilter !== "all" ? ` · filtered by ${userFilter}` : ""}
                    </p>
                    {(selectedCategory !== "All" || searchQuery || sortBy !== "latest" || userFilter !== "all") && (
                      <button
                        type="button"
                        onClick={clearAllFilters}
                        className="text-[9px] font-bold uppercase tracking-wider text-primary/60 hover:text-primary transition-colors"
                      >
                        Clear all
                      </button>
                    )}
                  </div>
                </div>
              </motion.div>

              {/* Seating Planner & Score Predictor for MatchDay category on Desktop Only */}
              <AnimatePresence>
                {/* Jersey Swap category → the structured board. Threads stay
                    the negotiation space; the board is where listings and
                    mutual matches live. */}
                {selectedCategory === "JerseySwap" && (
                  <Link
                    to="/swap"
                    className="mb-4 flex items-center justify-between gap-3 border border-purple-400/30 bg-purple-500/[0.06] px-4 py-3 transition-colors hover:bg-purple-500/[0.12]"
                  >
                    <div className="min-w-0">
                      <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-purple-300">Swap Board</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        List your jersey, see who wants it, and get matched — confirmed swaps earn chips and a badge.
                      </p>
                    </div>
                    <span className="shrink-0 border border-purple-400/40 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-purple-300">
                      Open board
                    </span>
                  </Link>
                )}

                {selectedCategory === "MatchDay" && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden space-y-4 mb-4 hidden lg:block"
                  >
                    <div className="grid gap-4">
                      <Suspense fallback={<div className="h-72 bg-card/10 animate-pulse border border-border/10" />}>
                        <StadiumSeatPlanner
                          onFilterSearch={(q) => setSearchQuery(q)}
                          onClaimSeat={(q) => {
                            setDraft((d) => ({
                              ...d,
                              title: `[${q}] Supporter Meetup!`,
                              body: `Hey fellow fans! I am sitting in ${q}. Let's coordinate and sync up at the game!`,
                              category: "MatchDay",
                            }));
                            try {
                              localStorage.setItem("rlt_seat_claimed", q);
                              window.dispatchEvent(new CustomEvent("rlt_badge_event", { detail: { action: "claim_seat" } }));
                            } catch (err) {}
                          }}
                          currentSearch={searchQuery}
                        />
                      </Suspense>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* One obvious compose button (Mobile Only) */}
              <button
                type="button"
                onClick={() => setShowMobileCompose(true)}
                className="w-full flex items-center justify-center gap-2 border border-dashed border-primary/40 bg-primary/5 py-3.5 text-xs font-bold uppercase tracking-wider text-primary hover:bg-primary/10 transition-colors lg:hidden mb-4 cursor-pointer"
              >
                <MessageSquare className="h-4 w-4" /> Start a New Discussion
              </button>

              {/* Thread Feed */}
              <div className="space-y-3">
                {/* Loading skeletons while threads load */}
                {isLoadingPosts && threadsToRender.length === 0 && [1, 2, 3, 4].map((i) => (
                  <div key={i} className="border border-border/40 bg-card/20 p-5">
                    <div className="flex items-start gap-3">
                      <div className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-muted/30" />
                      <div className="flex-1 space-y-2">
                        <div className="h-3 w-32 animate-pulse bg-muted/30" />
                        <div className="h-5 w-3/4 animate-pulse bg-muted/20" />
                        <div className="h-3 w-1/2 animate-pulse bg-muted/10" />
                      </div>
                    </div>
                  </div>
                ))}
                {threadsToRender.map((post, index) => {
                  const isActiveThread = activeReplyId && (activeReplyId === post.id || containsActiveReply(post, activeReplyId));
                  const activeReplyDraft = isActiveThread ? (replyDrafts[activeReplyId] || emptyReply) : emptyReply;

                  return (
                    <React.Fragment key={post.id}>
                    {/* The "in-feed" ad now actually sits in the feed (it used
                        to render as a leaderboard ABOVE the first post). */}
                    {index === 3 && <AdSlot position="in-feed" size="leaderboard" className="w-full" />}
                    <ForumPostCard
                      post={post} index={index}
                      isAuthenticated={isAuthenticated} user={user} isModerator={isModerator}
                      appReady={appParams.hasBase44Config} isSubmitting={createMutation.isPending || updateMutation.isPending}
                      replyOpen={activeReplyId === post.id}
                      replyDraft={activeReplyId === post.id ? (replyDrafts[post.id] || emptyReply) : emptyReply}
                      onToggleReply={handleToggleReply}
                      onUpdateReply={updateReplyDraft}
                      onReply={handleReply}
                      onOpenThread={handleOpenThread}
                      onDeletePost={handleDelete}
                      onEditPost={handleEditPost}
                      replyApi={replyApi}
                      activeReplyDraft={activeReplyDraft}
                      authorPostCounts={authorPostCounts}
                      authorReplyCounts={authorReplyCounts}
                      resolveAvatar={avatarFor}
                      resolveMeta={forumMetaFor}
                      reactionProfiles={profileById}
                    />
                    </React.Fragment>
                  );
                })}

                {filteredThreads.length > visibleCount && (
                  <div className="flex justify-center pt-4">
                    <Button
                      type="button"
                      onClick={() => setVisibleCount((prev) => prev + 15)}
                      className="border border-primary px-8 py-3.5 text-xs font-bold uppercase tracking-[0.25em] text-foreground bg-primary/5 hover:bg-primary hover:text-primary-foreground hover:shadow-[0_0_20px_rgba(249,115,22,0.35)] transition-all duration-300 rounded-none relative overflow-hidden"
                    >
                      Load More ({filteredThreads.length - visibleCount} remaining)
                    </Button>
                  </div>
                )}

                {!isLoadingPosts && filteredThreads.length === 0 && (
                  <EmptyState
                    onClearFilters={clearAllFilters}
                    onSelectCategory={(cat) => { setSelectedCategory(cat); setSearchQuery(""); setSortBy("latest"); }}
                    onStartDiscussion={openDiscussionComposer}
                    category={selectedCategory}
                    searchQuery={searchQuery}
                  />
                )}
              </div>
            </div>
          </div>

          {/* ━━━ RIGHT: Sidebar ━━━ */}
          <div id="forum-compose-sidebar" className="hidden lg:block scroll-mt-28 lg:sticky lg:top-24 lg:max-h-[calc(100dvh-7rem)] lg:overflow-y-auto cmd-scrollbar">
            <div className="mb-6"><FanRankCard /></div>
            <div className="mb-6"><DailyMissions /></div>
            <AdSlot position="sidebar" size="medium-rectangle" className="mb-6 w-full" />
            <Suspense fallback={<div className="h-96 bg-card/10 animate-pulse border border-border/10" />}>
              <ComposeSidebar
                editTarget={editTarget}
                onCancelEdit={() => { setEditTarget(null); setDraft(emptyPost); }}
                draft={draft} setDraft={setDraft}
                isAuthenticated={isAuthenticated} user={user}
                submittedForReview={submittedForReview}
                onSubmit={handlePost} isPending={createMutation.isPending || updateMutation.isPending}
                allThreads={allThreads}
                people={mentionPeople}
                onFilterSearch={(q) => setSearchQuery(q)}
                onClaimSeat={(q) => {
                  setEditTarget(null); // tool content primes a NEW post, never an edit
                  setDraft((d) => ({
                    ...d,
                    title: `[${q}] Supporter Meetup!`,
                    body: `Hey fellow fans! I am sitting in ${q}. Let's coordinate and sync up at the game!`,
                    category: "MatchDay",
                  }));
                  window.scrollTo({ top: 300, behavior: "smooth" });
                  try {
                    localStorage.setItem("rlt_seat_claimed", q);
                    window.dispatchEvent(new CustomEvent("rlt_badge_event", { detail: { action: "claim_seat" } }));
                  } catch (err) {}
                }}
                searchQuery={searchQuery}
                onSharePrediction={(matchup, homeScore, awayScore) => {
                  const home = matchup.home_team;
                  const away = matchup.away_team;
                  const label = matchup.label || "Opening Showdown";
                  setEditTarget(null); // tool content primes a NEW post, never an edit
                  setDraft((d) => ({
                    ...d,
                    title: `[Prediction] ${home} ${homeScore} - ${awayScore} ${away}`,
                    body: `Here is my match prediction for ${label}: ${home} ${homeScore} - ${awayScore} ${away}! Let's go! What are your score predictions?`,
                    category: "MatchDay",
                  }));
                  window.scrollTo({ top: 300, behavior: "smooth" });
                }}
              />
            </Suspense>
          </div>
        </div>
      </div>

      {/* ━━━ THREAD DETAIL MODAL ━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <AnimatePresence>
        {threadModalPost && (
          <Suspense fallback={null}>
            <ThreadDetailModal
              post={threadModalPost}
              onClose={() => {
                // Stamp on close too, so replies that arrived while the
                // thread was open don't show as unread.
                if (threadModalId) markThreadRead(threadModalId);
                setThreadModalId(null);
              }}
              isAuthenticated={isAuthenticated}
              user={user}
              isModerator={isModerator}
              onEditPost={handleEditPost}
              appReady={appParams.hasBase44Config}
              isSubmitting={createMutation.isPending || updateMutation.isPending}
              replyDraft={replyDrafts[threadModalPost.id] || emptyReply}
              onUpdateReply={updateReplyDraft}
              onReply={handleReply}
              replyApi={replyApi}
              activeReplyDraft={replyDrafts[activeReplyId] || emptyReply}
              authorPostCounts={authorPostCounts}
              authorReplyCounts={authorReplyCounts}
              resolveAvatar={avatarFor}
              resolveMeta={forumMetaFor}
              reactionProfiles={profileById}
            />
          </Suspense>
        )}
      </AnimatePresence>

      {/* ━━━ MOBILE COMPOSE SHEET ━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <AnimatePresence>
        {showMobileCompose && (
          <>
            <motion.div 
              initial={{ opacity: 0 }} 
              animate={{ opacity: 1 }} 
              exit={{ opacity: 0 }} 
              transition={{ duration: 0.2, ease: "linear" }}
              style={{ willChange: "opacity" }}
              className="fixed inset-0 z-50 bg-black/65 lg:hidden" 
              onClick={() => {
                setShowMobileCompose(false);
                if (editTarget) {
                  setEditTarget(null);
                  setDraft(emptyPost);
                }
              }}
            />
            <motion.div
              initial={{ y: "100%" }} 
              animate={{ y: 0 }} 
              exit={{ y: "100%" }}
              transition={{ type: "tween", ease: [0.16, 1, 0.3, 1], duration: 0.3 }}
              style={{
                willChange: "transform",
                ...(composeViewport
                  ? { top: `${composeViewport.top}px`, bottom: "auto", height: `${composeViewport.height}px`, maxHeight: `${composeViewport.height}px` }
                  : {}),
              }}
              className="ios-sheet ios-scroll fixed inset-x-0 bottom-0 z-50 max-h-[88dvh] overflow-y-auto border-t border-border bg-card/95 pb-[calc(1.25rem+var(--safe-bottom))] cmd-scrollbar lg:hidden"
              role="dialog"
              aria-modal="true"
              aria-labelledby="forum-mobile-compose-title"
            >
              {/* Drag handle */}
              <div className="flex justify-center pt-3 pb-1">
                <div className="ios-home-indicator" />
              </div>
              <div className="p-5">
                <div className="flex items-center justify-between mb-4">
                  <h2 id="forum-mobile-compose-title" className="font-display text-lg uppercase tracking-wide">
                    {editTarget ? "Edit Discussion" : "Start a Discussion"}
                  </h2>
                  <button
                    type="button"
                    onClick={() => {
                      setShowMobileCompose(false);
                      if (editTarget) {
                        setEditTarget(null);
                        setDraft(emptyPost);
                      }
                    }}
                    className="touch-target flex items-center justify-center border border-border/30 text-slate-300 transition-colors hover:border-border hover:text-foreground"
                    aria-label="Close composer"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                <AnimatePresence>
                  {submittedForReview && !editTarget && (
                    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="mb-4 border border-emerald-500/25 bg-emerald-500/[0.07] p-3 overflow-hidden">
                      <div className="flex items-center gap-2">
                        <Sparkles className="h-3.5 w-3.5 text-emerald-400" />
                        <p className="text-xs font-bold text-emerald-400">Posted — you're live!</p>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {!isAuthenticated ? (
                  <div className="space-y-3 border border-border/30 bg-muted/[0.04] p-4">
                    <p className="text-sm leading-relaxed text-slate-200">
                      Sign in to start a discussion. Accounts help us keep the forum safe and reduce spam.
                    </p>
                    <Button asChild size="mobile" className="w-full rounded-none bg-primary text-[10px] font-bold uppercase tracking-[0.2em]">
                      <Link to="/login?next=%2Fforum">Sign in to post</Link>
                    </Button>
                  </div>
                ) : (
                <form onSubmit={handlePost} className="space-y-3">
                    <div className="flex items-center gap-2 border border-border/30 bg-muted/[0.04] px-3 py-2">
                      <UserAvatar name={user?.full_name || user?.email} size="sm" showStatus src={user?.avatar_url} />
                      <span className="text-xs font-bold text-foreground">{user?.full_name || user?.email}</span>
                    </div>
                  <Select value={draft.category} onValueChange={(v) => setDraft({ ...draft, category: v })}>
                    <SelectTrigger className="h-11 rounded-none border-border bg-background text-left text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>{categories.filter((c) => c.value !== "All").map((c) => <SelectItem key={c.value} value={c.value}>{getCategoryMeta(c.value).label}</SelectItem>)}</SelectContent>
                  </Select>
                  <label htmlFor="mobile-compose-title" className="sr-only">Topic title</label>
                  <Input id="mobile-compose-title" required placeholder="Topic title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} className="h-11 rounded-none border-border bg-background text-sm" />
                  <MentionTextarea required people={mentionPeople} placeholder="What's on your mind? Use @ to mention" value={draft.body} onChange={(val) => setDraft({ ...draft, body: val })} className="min-h-24 rounded-none border-border bg-background text-sm leading-relaxed resize-none" />
                  <MediaAttach value={draft.media_url} onChange={(url) => setDraft({ ...draft, media_url: url })} />
                  <Button type="submit" disabled={!appParams.hasBase44Config || !draft.title || !draft.body || createMutation.isPending || updateMutation.isPending} size="mobile" className="w-full rounded-none bg-primary text-[10px] font-bold uppercase tracking-[0.2em] hover:bg-primary/90">
                    <Send className="mr-2 h-3 w-3" />
                    {editTarget
                      ? updateMutation.isPending ? "Saving..." : "Save Changes"
                      : createMutation.isPending ? "Posting..." : "Post to Community"}
                  </Button>
                </form>
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* ━━━ MOBILE FAB ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      {mobileTab === "feed" && <MobileFAB onClick={() => setShowMobileCompose(true)} />}

      {/* ━━━ SCROLL TO TOP ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <ScrollToTopButton />

      {/* ━━━ DELETE CONFIRMATION ━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <AdminConfirmSheet
        open={!!deleteTarget}
        title="Delete this post?"
        description="This will remove the post and any replies under it. This cannot be undone."
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </main>
  );
}
