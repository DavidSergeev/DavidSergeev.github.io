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

// Replace with the Lambda Function URL printed by `sam deploy`
const LAMBDA_URL = "https://scha4nxp6ayxyo7rdwvjeq32za0rdkzf.lambda-url.eu-south-1.on.aws/";

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
    text: "I'd like to schedule a meeting with David. My contact details and preferred date: ",
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

function BotIcon() {
  return (
    <div className="bot-icon">
      <svg viewBox="0 2.25 24 24" fill="currentColor">
        <path
          fillRule="evenodd"
          d="M12 2.5a4.5 4.5 0 0 1 0 9 4.5 4.5 0 0 1 0-9z
             M8.3 5.8 H10.7 Q11.0 5.8 11.0 6.3 V8.2 Q11.0 9.0 9.8 9.0 H8.9 Q8.1 9.0 8.0 8.2 V6.3 Q8.0 5.8 8.3 5.8 Z
             M15.7 5.8 H13.3 Q13.0 5.8 13.0 6.3 V8.2 Q13.0 9.0 14.2 9.0 H15.1 Q15.9 9.0 16.0 8.2 V6.3 Q16.0 5.8 15.7 5.8 Z"
        />
        {/* Suit body with V-collar cut out via evenodd */}
        <path
          fillRule="evenodd"
          d="M3 24 L4 14 L8 11.5 L12 12 L16 11.5 L20 14 L21 24 Z M9 12.5 L12 21 L15 12.5 Z"
        />
        {/* Tie inside the V-collar */}
        <path d="M11.3 14l-.8 5.5 1.5 1.5 1.5-1.5-.8-5.5-.4-.7h-1z" />
      </svg>
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
      const res = await fetch(LAMBDA_URL, {
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

  function handleFocus() {
    const vv = window.visualViewport;
    if (!vv) return;

    const onResize = () => {
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        const rect = ta.getBoundingClientRect();
        const correction = rect.bottom - (vv.height - 28);
        window.scrollTo({ top: window.scrollY + correction });
      });
    };

    vv.addEventListener("resize", onResize, { once: true });
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
          onFocus={handleFocus}
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

const SKILLS = [
  { icon: "⚛️", label: "React & TypeScript" },
  { icon: "🟢", label: "Node.js & APIs" },
  { icon: "🎨", label: "UI / UX Design" },
  { icon: "☁️", label: "Cloud & DevOps" },
  { icon: "📱", label: "Mobile-first Web" },
  { icon: "🗄️", label: "Databases & SQL" },
];

const WORKS = [
  { title: "SaaS Dashboard", desc: "Real-time analytics platform built with React, D3, and GraphQL.", tag: "Web App" },
  { title: "Dev Tooling CLI", desc: "Open-source CLI that speeds up scaffolding by 10×.", tag: "Open Source" },
  { title: "E-commerce Redesign", desc: "Full UX overhaul that improved conversion rate by 34%.", tag: "Design" },
];

function ScrollToTop() {
  const [visible, setVisible] = useState(false);
  const [bottom, setBottom] = useState(40);

  useEffect(() => {
    function onScroll() {
      setVisible(window.scrollY > 10);
      const footer = document.querySelector<HTMLElement>(".site-footer");
      if (footer) {
        const footerTop = footer.getBoundingClientRect().top;
        const overlap = window.innerHeight - footerTop;
        setBottom(overlap > 0 ? overlap + 16 : 40);
      }
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  function scrollTop() {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <button
      className={`scroll-top-btn ${visible ? "visible" : ""}`}
      style={{ bottom: `${bottom}px` }}
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

  return (
    <>
      {/* ── Header ── */}
      <header className="site-header">
        <a href="#" className="logo" onClick={handleNavClick}>David<span>Dev</span></a>
        <nav className={`site-nav ${menuOpen ? "open" : ""}`}>
          {NAV_LINKS.map((l) => (
            <a key={l} href={`#${l.toLowerCase()}`} onClick={(e) => { setMenuOpen(false); handleNavClick(e); }}>{l}</a>
          ))}
          <a href="#contact" className="btn-hire" onClick={(e) => { setMenuOpen(false); handleNavClick(e); }}>Hire me</a>
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
          </div>
          <Chat />
        </section>

        {/* ── Skills ── */}
        <section className="section" id="skills">
          <h2 className="section-title">What I do</h2>
          <p className="section-sub">A versatile skill set honed across startups, agencies, and personal projects.</p>
          <div className="skills-grid">
            {SKILLS.map((s) => (
              <div key={s.label} className="skill-card">
                <span className="skill-icon">{s.icon}</span>
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
                <a href="#" className="work-link">View project →</a>
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
        <p>© 2026 DavidDev. Designed & built with care.</p>
        <div className="footer-links">
          {NAV_LINKS.map((l) => (
            <a key={l} href={`#${l.toLowerCase()}`} onClick={handleNavClick}>{l}</a>
          ))}
        </div>
      </footer>

      <ScrollToTop />
    </>
  );
}
