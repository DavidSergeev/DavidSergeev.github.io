import { useState, useRef, useEffect } from "react";
import "./App.css";

// ── Types ────────────────────────────────────────────────────────────────────

type Role = "user" | "assistant";

interface Message {
  id: number;
  role: Role;
  text: string;
}

// ── Config ───────────────────────────────────────────────────────────────────

// landing-api-worker's custom domain — signs and proxies requests to the
// AWS_IAM-protected Lambda Function URL (see landing-api-worker/src/index.js)
const API_URL = "https://api.david-slutsky.com/";
// Direct (non-chat) endpoint backing the "Hire me" modal — see POST /schedule-meeting in main.py
const SCHEDULE_MEETING_URL = `${API_URL}schedule-meeting`;

// ── Chat helpers ─────────────────────────────────────────────────────────────

const INITIAL_MESSAGES: Message[] = [
  { id: 1, role: "assistant", text: "Hi! I'm Smitty, David's AI assistant. Ask me anything about his work or experience." },
];

interface QuickAction {
  label: string;
  text: string;
  autoSend: boolean;
}

const QUICK_ACTIONS: QuickAction[] = [
  {
    label: "Tell me about David",
    text: "Tell me about David — his background, skills, and experience.",
    autoSend: true,
  },
  {
    label: "Tell me about this system",
    text: "Tell me about this AI agent system and how it works.",
    autoSend: true,
  },
  {
    label: "Schedule meeting with David",
    text: "I'd like to schedule a meeting with David.\nContact: \nDate: \nDescription: ",
    autoSend: false,
  },
  {
    label: "Request a call from David",
    text: "Please have David reach out to me. My contact details: ",
    autoSend: false,
  },
];

let nextId = 2;

// ── Streaming activity (tool calls in progress) ─────────────────────────────

// `tool` is one or more tool names joined by " -> " by the backend (see react_agent.py).
type Activity = { kind: "thinking" } | { kind: "acting"; tool: string };

function formatToolLabel(name: string): string {
  return name.replace(/_/g, " ");
}

function activityLabel(activity: Activity): string | null {
  if (activity.kind === "thinking") return null;
  const tools = activity.tool.split(" -> ").map(formatToolLabel).join(" -> ");
  return `Using ${tools}…`;
}

function TypingDots() {
  return (
    <span className="typing-dots">
      <span /><span /><span />
    </span>
  );
}

function ChatBubbleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}

function BotIcon() {
  return (
    <div className="bot-icon">
      <img src="/avatar.svg" alt="Assistant avatar" />
    </div>
  );
}

// ── Chat component ────────────────────────────────────────────────────────────

function Chat() {
  const [messages, setMessages] = useState<Message[]>(INITIAL_MESSAGES);
  const [input, setInput] = useState("");
  const [activity, setActivity] = useState<Activity | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, activity]);

  async function sendMessage(text: string) {
    if (!text.trim()) return;
    setMessages((prev) => [...prev, { id: nextId++, role: "user", text }]);
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setActivity({ kind: "thinking" });

    const assistantId = nextId++;
    let assistantStarted = false;

    // Lazily inserts the assistant bubble the first time real answer text arrives,
    // so the activity indicator (thinking / using tool X) stays visible until then.
    function ensureAssistantMessage() {
      if (assistantStarted) return;
      assistantStarted = true;
      setActivity(null);
      setMessages((prev) => [...prev, { id: assistantId, role: "assistant", text: "" }]);
    }

    function appendAnswerToken(token: string) {
      if (!token) return;
      ensureAssistantMessage();
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, text: m.text + token } : m))
      );
    }

    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: text }),
      });

      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        // SSE events are separated by double newline
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";

        for (const event of events) {
          if (!event.startsWith("data: ")) continue;
          const payload = event.slice(6).trim();
          if (payload === "[DONE]") break;

          let frame: { type?: string; token?: string; tool?: string; error?: string };
          try {
            frame = JSON.parse(payload);
          } catch {
            continue; // malformed chunk — skip
          }
          if (frame.error) throw new Error(frame.error);

          switch (frame.type) {
            case "answer":
              appendAnswerToken(frame.token ?? "");
              break;
            case "acting":
              if (frame.tool) setActivity({ kind: "acting", tool: frame.tool });
              break;
            default:
              break;
          }
        }
      }
    } catch (err) {
      console.error("Chat error:", err);
      setActivity(null);
      setMessages((prev) => [
        ...prev.filter((m) => m.id !== assistantId),
        { id: assistantId, role: "assistant", text: "Sorry, something went wrong. Please try again." },
      ]);
    }
  }

  function handleSend() {
    sendMessage(input.trim());
  }

  function handleQuickAction(action: QuickAction) {
    if (action.autoSend) {
      sendMessage(action.text);
    } else {
      setInput(action.text);
      setTimeout(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }, 0);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInput(e.target.value);
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
    }
  }

  return (
    <div className="chat-embed">
      <div className="chat-quick-btns">
        {QUICK_ACTIONS.map((action) => (
          <button
            key={action.label}
            className="quick-btn"
            onClick={() => handleQuickAction(action)}
          >
            {action.label}
          </button>
        ))}
      </div>

      <div className="chat-messages" ref={messagesRef}>
        {messages.map((msg) =>
          msg.role === "assistant" ? (
            <div key={msg.id} className="msg-row assistant">
              <BotIcon />
              <div className="msg-bubble assistant">{msg.text}</div>
            </div>
          ) : (
            <div key={msg.id} className="msg-row user">
              <div className="msg-bubble user">{msg.text}</div>
            </div>
          )
        )}
        {activity && (
          <div className="msg-row assistant">
            <BotIcon />
            <div className="msg-bubble assistant activity-bubble">
              {activityLabel(activity) && <span className="activity-label">{activityLabel(activity)}</span>}
              <TypingDots />
            </div>
          </div>
        )}
      </div>

      <div className="chat-input-bar">
        <textarea
          ref={textareaRef}
          rows={1}
          placeholder="Ask me anything…"
          value={input}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
        />
        <button onClick={handleSend} disabled={!input.trim()} aria-label="Send">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// ── Chat modal + launcher ────────────────────────────────────────────────────

function ChatModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="chat-modal-backdrop" onClick={onClose}>
      <div className="chat-modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="chat-modal-header">
          <div className="chat-modal-title">
            <BotIcon />
            <div>
              <strong>Smitty</strong>
              <span>David's AI agent</span>
            </div>
          </div>
          <button className="chat-modal-close" onClick={onClose} aria-label="Close chat">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <Chat />
      </div>
    </div>
  );
}

// ── Hire modal (schedule-meeting form) ───────────────────────────────────────

type HireStatus = "idle" | "submitting" | "success" | "error";

function HireModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [date, setDate] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<HireStatus>("idle");

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  // Reset to a blank form every time the modal is (re)opened.
  useEffect(() => {
    if (!open) return;
    setEmail("");
    setDate("");
    setDescription("");
    setStatus("idle");
  }, [open]);

  if (!open) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !date || !description.trim() || status === "submitting") return;
    setStatus("submitting");
    try {
      const res = await fetch(SCHEDULE_MEETING_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attendee_email: email.trim(),
          scheduled_at: new Date(date).toISOString(),
          description: description.trim(),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus("success");
    } catch (err) {
      console.error("Schedule meeting error:", err);
      setStatus("error");
    }
  }

  return (
    <div className="chat-modal-backdrop" onClick={onClose}>
      <div className="hire-modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="chat-modal-header">
          <div className="chat-modal-title">
            <div>
              <strong>Schedule a meeting</strong>
              <span>Tell David a bit about your project</span>
            </div>
          </div>
          <button className="chat-modal-close" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        {status === "success" ? (
          <div className="hire-success">
            <p>Thanks! Your meeting request was sent — David will follow up by email.</p>
            <button className="btn-primary" onClick={onClose}>Close</button>
          </div>
        ) : (
          <form className="hire-form" onSubmit={handleSubmit}>
            <label className="form-field">
              <span className="form-label">Email</span>
              <input
                type="email"
                className="form-input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
              />
            </label>
            <label className="form-field">
              <span className="form-label">Date</span>
              <input
                type="datetime-local"
                className="form-input"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                required
              />
            </label>
            <label className="form-field">
              <span className="form-label">Description</span>
              <textarea
                className="form-input form-textarea"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What would you like to talk about?"
                rows={4}
                required
              />
            </label>
            {status === "error" && (
              <p className="form-error">Something went wrong. Please try again.</p>
            )}
            <button type="submit" className="btn-primary hire-submit-btn" disabled={status === "submitting"}>
              {status === "submitting" ? "Sending…" : "Schedule meeting"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

// ── Work modal (expandable project details) ─────────────────────────────────

function WorkModal({ work, onClose }: { work: Work | null; onClose: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const descRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (!work) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [work, onClose]);

  // Reset to collapsed every time a different project is opened.
  useEffect(() => {
    setExpanded(false);
  }, [work]);

  // Detect whether the (collapsed, clamped) text actually overflows, so the
  // "Show more" toggle only appears when there's really more text to reveal.
  useEffect(() => {
    if (!work || expanded) return;
    const el = descRef.current;
    if (!el) return;
    setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [work, expanded]);

  if (!work) return null;

  return (
    <div className="chat-modal-backdrop" onClick={onClose}>
      <div className="work-modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="chat-modal-header">
          <div className="chat-modal-title">
            <div>
              <strong>{work.title}</strong>
              <span>{work.tag}</span>
            </div>
          </div>
          <button className="chat-modal-close" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div className="work-modal-body">
          <p ref={descRef} className={`work-modal-desc ${expanded ? "expanded" : ""}`}>
            {work.details}
          </p>
          {(clamped || expanded) && (
            <button
              type="button"
              className="work-modal-toggle"
              onClick={() => setExpanded((e) => !e)}
            >
              {expanded ? "Show less" : "Show more"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ChatLauncher({
  hidden,
  pinned,
  pinnedTop,
  onOpen,
  anchorRef,
}: {
  hidden: boolean;
  pinned: boolean;
  pinnedTop: number;
  onOpen: () => void;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
}) {
  return (
    <button
      ref={anchorRef}
      className={`chat-launcher ${hidden ? "hidden" : ""} ${pinned ? "pinned" : ""}`}
      style={pinned ? { top: `${pinnedTop}px` } : undefined}
      onClick={onOpen}
      aria-label="Open chat with Smitty"
      aria-hidden={hidden}
      tabIndex={hidden ? -1 : 0}
    >
      <ChatBubbleIcon />
    </button>
  );
}

// ── Smooth scroll ─────────────────────────────────────────────────────────────

interface ScrollAnimation {
  startY: number;
  distance: number;
  duration: number;
  startTime: number | null;
}

let activeScroll: ScrollAnimation | null = null;

/** Trapezoidal velocity profile: accelerate 0→25%, constant 25→75%, decelerate 75→100% */
function easeScrollProgress(t: number): number {
  const a = 0.25, c = 0.5, d = 0.25;
  const vmax = 1 / (0.5 * a + c + 0.5 * d);
  if (t <= a) return 0.5 * (vmax / a) * t * t;
  if (t <= a + c) return 0.5 * vmax * a + vmax * (t - a);
  const td = t - a - c;
  return 0.5 * vmax * a + vmax * c + vmax * td - 0.5 * (vmax / d) * td * td;
}

function scrollStep(timestamp: number): void {
  if (!activeScroll) return;
  if (activeScroll.startTime === null) activeScroll.startTime = timestamp;
  const progress = Math.min((timestamp - activeScroll.startTime) / activeScroll.duration, 1);
  window.scrollTo(0, activeScroll.startY + activeScroll.distance * easeScrollProgress(progress));
  if (progress < 1) requestAnimationFrame(scrollStep);
  else activeScroll = null;
}

function smoothScrollTo(targetY: number, duration = 900): void {
  activeScroll = { startY: window.scrollY, distance: targetY - window.scrollY, duration, startTime: null };
  requestAnimationFrame(scrollStep);
}

const HEADER_H = 64;

function handleNavClick(e: React.MouseEvent<HTMLAnchorElement>): void {
  const href = e.currentTarget.getAttribute("href");
  if (!href) return;
  if (href === "#") {
    e.preventDefault();
    smoothScrollTo(0);
    return;
  }
  const target = document.getElementById(href.slice(1));
  if (!target) return;
  e.preventDefault();
  smoothScrollTo(Math.max(0, target.getBoundingClientRect().top + window.scrollY - HEADER_H));
}

// ── Landing page ──────────────────────────────────────────────────────────────

const NAV_LINKS = ["Agent", "Skills", "Work", "Contact"];

/** "Agent" opens the chat modal instead of scrolling to a section. */
function NavLink({
  label,
  className,
  onOpenChat,
  onNavigate,
}: {
  label: string;
  className?: string;
  onOpenChat: () => void;
  onNavigate?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
}) {
  if (label === "Agent") {
    return (
      <button type="button" className={`nav-link-btn ${className ?? ""}`} onClick={onOpenChat}>
        {label}
      </button>
    );
  }
  return (
    <a
      href={`#${label.toLowerCase()}`}
      className={className}
      onClick={(e) => (onNavigate ? onNavigate(e) : handleNavClick(e))}
    >
      {label}
    </a>
  );
}

const SKILLS = [
  { icon: "/python-3.svg", label: "Python" },
  { icon: "/backend.svg", label: "Backend Engineering" },
  { icon: "/big-data.svg", label: "Big Data" },
  { icon: "/classification.svg", label: "ML Engineering" },
  { icon: "/grapth.svg", label: "Distributed Systems" },
  { icon: "/computer-vision.svg", label: "Computer Vision" },
];

interface Work {
  title: string;
  desc: string;
  tag: string;
  details: string;
}

const WORKS: Work[] = [
  {
    title: "SaaS Dashboard",
    desc: "Real-time analytics platform built with React, D3, and GraphQL.",
    tag: "Web App",
    details:
      "Real-time analytics platform built with React, D3, and GraphQL. Designed and shipped a multi-tenant dashboard that streams live usage metrics to thousands of concurrent users over WebSockets, with sub-second chart updates powered by a custom D3 rendering layer tuned for high-frequency data. The GraphQL API layer replaced a sprawling set of REST endpoints, cutting median dashboard load time by more than half while giving each team the ability to compose their own custom widgets. Rolled out an incremental migration strategy so existing customers experienced zero downtime, and built an internal component library that let the design and engineering teams ship new dashboard modules in days instead of weeks.",
  },
  {
    title: "Dev Tooling CLI",
    desc: "Open-source CLI that speeds up scaffolding by 10×.",
    tag: "Open Source",
    details:
      "Open-source CLI that speeds up scaffolding by 10×. Built a plugin-based architecture so the community could contribute new project templates without touching the core codebase, which grew adoption to thousands of weekly downloads within a few months of launch. Invested heavily in developer experience — interactive prompts, sensible defaults, and clear error messages — so first-time users could go from install to a running project in under a minute. Wrote extensive documentation and a contributor guide that lowered the barrier for outside pull requests, and set up automated release tooling so new versions could ship safely multiple times a week.",
  },
  {
    title: "E-commerce Redesign",
    desc: "Full UX overhaul that improved conversion rate by 34%.",
    tag: "Design",
    details:
      "Full UX overhaul that improved conversion rate by 34%. Led a ground-up redesign of the checkout and product discovery flows after auditing months of session recordings and funnel analytics to pinpoint exactly where shoppers were dropping off. Simplified the cart-to-checkout path from five steps down to two, introduced persistent cart state across devices, and reworked the mobile navigation to surface high-intent categories faster. Partnered closely with the growth team to A/B test every major change before rollout, which not only validated the conversion lift but also uncovered a handful of accessibility issues that were quietly costing sales.",
  },
];

// ── Scroll-pinned floating buttons ──────────────────────────────────────────
// Both the "back to top" and chat launcher buttons are `position: fixed`
// (glued to the viewport) until the user scrolls past PIN_SCROLL_THRESHOLD of
// the page. From that point on they switch to `position: absolute`, pinned to
// the exact document Y they were at when the threshold was crossed, so they
// stop following the viewport for the remaining scroll and instead sit still
// on the page (sharing the same row so both buttons line up).
//
// The row's Y position is measured from each button's actual (still `fixed`)
// `getBoundingClientRect()` rather than duplicating CSS `bottom`/`height`
// values as magic numbers here, so it automatically stays correct across
// breakpoints, zoom levels, or future CSS tweaks. The two buttons are
// aligned on their vertical *centers* (not top edges), since they're
// different sizes (44px vs 52px) — matching top edges alone would leave the
// taller button's center sitting a few pixels lower than the other's.

const PIN_SCROLL_THRESHOLD = 0.95;
// Extra downward nudge applied once pinned, so the row sits a bit lower than
// where the buttons naturally were while still `fixed`.
const PIN_ROW_EXTRA_OFFSET = 24;

interface ScrollPin {
  pinned: boolean;
  primaryTop: number;
  secondaryTop: number;
}

function useScrollPin(
  primaryRef: React.RefObject<HTMLElement | null>,
  secondaryRef: React.RefObject<HTMLElement | null>
): ScrollPin {
  const [pin, setPin] = useState<ScrollPin>({ pinned: false, primaryTop: 0, secondaryTop: 0 });

  useEffect(() => {
    function onScroll() {
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
      const progress = maxScroll > 0 ? window.scrollY / maxScroll : 0;
      if (progress >= PIN_SCROLL_THRESHOLD) {
        setPin((prev) => {
          if (prev.pinned) return prev; // already frozen — leave the row where it is
          const primary = primaryRef.current;
          const secondary = secondaryRef.current;
          if (!primary || !secondary) return prev;
          const scrollYAtThreshold = PIN_SCROLL_THRESHOLD * maxScroll;
          // Both are still `fixed` here, so their rects are viewport-relative
          // and constant regardless of the current scroll position.
          const primaryRect = primary.getBoundingClientRect();
          const secondaryRect = secondary.getBoundingClientRect();
          const primaryTop = scrollYAtThreshold + primaryRect.top + PIN_ROW_EXTRA_OFFSET;
          const centerY = primaryTop + primaryRect.height / 2;
          const secondaryTop = centerY - secondaryRect.height / 2;
          return { pinned: true, primaryTop, secondaryTop };
        });
      } else {
        setPin((prev) => (prev.pinned ? { pinned: false, primaryTop: 0, secondaryTop: 0 } : prev));
      }
    }
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [primaryRef, secondaryRef]);

  return pin;
}

function ScrollToTop({
  pinned,
  pinnedTop,
  anchorRef,
}: {
  pinned: boolean;
  pinnedTop: number;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    function onScroll() {
      setVisible(window.scrollY > 10);
    }
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  function scrollTop() {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <button
      ref={anchorRef}
      className={`scroll-top-btn ${visible ? "visible" : ""} ${pinned ? "pinned" : ""}`}
      style={pinned ? { top: `${pinnedTop}px` } : undefined}
      onClick={scrollTop}
      aria-label="Back to top"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
        <polyline points="18 15 12 9 6 15" />
      </svg>
    </button>
  );
}

export default function App() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [hireOpen, setHireOpen] = useState(false);
  const [activeWork, setActiveWork] = useState<Work | null>(null);
  const scrollTopBtnRef = useRef<HTMLButtonElement>(null);
  const chatLauncherRef = useRef<HTMLButtonElement>(null);
  const { pinned, primaryTop, secondaryTop } = useScrollPin(scrollTopBtnRef, chatLauncherRef);

  function openChat() {
    setMenuOpen(false);
    setChatOpen(true);
  }

  function openHire() {
    setMenuOpen(false);
    setHireOpen(true);
  }

  return (
    <>
      {/* ── Header ── */}
      <header className="site-header">
        <a href="#" className="logo" onClick={handleNavClick}>David<span>Studio</span></a>
        <nav className={`site-nav ${menuOpen ? "open" : ""}`}>
          {NAV_LINKS.map((l) => (
            <NavLink
              key={l}
              label={l}
              onOpenChat={openChat}
              onNavigate={(e) => { setMenuOpen(false); handleNavClick(e); }}
            />
          ))}
          <button type="button" className="btn-hire" onClick={openHire}>Hire me</button>
        </nav>
        <button className="menu-toggle" onClick={() => setMenuOpen((o) => !o)} aria-label="Menu">
          <span /><span /><span />
        </button>
      </header>

      <main>
        {/* ── Agent / Hero ── */}
        <section className="hero" id="agent">
          <div className="hero-intro">
            <h1>Talk to <span>David's</span> Agent</h1>
            <p className="hero-subtitle">Smitty the AI agent</p>
            <button className="btn-primary hero-chat-btn" onClick={openChat}>
              <ChatBubbleIcon />
              Start chatting
            </button>
          </div>
        </section>

        {/* ── Skills ── */}
        <section className="section" id="skills">
          <h2 className="section-title">What I do</h2>
          <p className="section-sub">A versatile skill set honed across startups, agencies, and personal projects.</p>
          <div className="skills-grid">
            {SKILLS.map((s) => (
              <div key={s.label} className="skill-card">
                <span className="skill-icon-badge">
                  <img src={s.icon} alt="" className="skill-icon" />
                </span>
                <span>{s.label}</span>
              </div>
            ))}
          </div>
        </section>

        {/* ── Work ── */}
        <section className="section alt" id="work">
          <h2 className="section-title">Selected work</h2>
          <p className="section-sub">A handful of projects I'm proud of.</p>
          <div className="work-grid">
            {WORKS.map((w) => (
              <div key={w.title} className="work-card">
                <span className="work-tag">{w.tag}</span>
                <h3>{w.title}</h3>
                <p>{w.desc}</p>
                <button type="button" className="work-link" onClick={() => setActiveWork(w)}>
                  Read More
                </button>
              </div>
            ))}
          </div>
        </section>

        {/* ── Contact ── */}
        <section className="section" id="contact">
          <h2 className="section-title">Let's work together</h2>
          <p className="section-sub">Have a project in mind? I'd love to hear about it.</p>
          <div className="contact-links">
            <a href="mailto:hello@alexdev.io">hello@alexdev.io</a>
            <a href="#">GitHub</a>
            <a href="#">LinkedIn</a>
            <a href="#">Twitter / X</a>
          </div>
        </section>
      </main>

      {/* ── Footer ── */}
      <footer className="site-footer">
        <p>© 2026 DavidStudio. Designed & built with care.</p>
        <div className="footer-links">
          {NAV_LINKS.map((l) => (
            <NavLink key={l} label={l} onOpenChat={openChat} />
          ))}
        </div>
      </footer>

      <ScrollToTop pinned={pinned} pinnedTop={primaryTop} anchorRef={scrollTopBtnRef} />
      <ChatLauncher hidden={chatOpen} pinned={pinned} pinnedTop={secondaryTop} onOpen={openChat} anchorRef={chatLauncherRef} />
      <ChatModal open={chatOpen} onClose={() => setChatOpen(false)} />
      <HireModal open={hireOpen} onClose={() => setHireOpen(false)} />
      <WorkModal work={activeWork} onClose={() => setActiveWork(null)} />
    </>
  );
}
